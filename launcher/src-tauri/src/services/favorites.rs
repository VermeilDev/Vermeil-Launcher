// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::services::icon_cache;
use crate::util::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteItem {
    /// Compound unique ID: format "{platform}:{project_id}" (e.g. "modrinth:fALhf0ST" or "curseforge:306612")
    pub id: String,
    /// Platform: "modrinth" | "curseforge"
    pub platform: String,
    /// Upstream project ID
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub author: Option<String>,
    pub icon_url: Option<String>,
    pub local_icon_path: Option<String>,
    /// Content category: "mod" | "modpack" | "resourcepack" | "shader" | "datapack"
    pub category: String,
    /// Supported loaders: e.g. ["fabric", "forge", "neoforge", "quilt"]
    pub loaders: Vec<String>,
    /// Supported game versions: e.g. ["1.20.1", "1.21.1"]
    pub versions: Vec<String>,
    /// Latest release version string if known: e.g. "0.5.8"
    pub version_name: Option<String>,
    /// ISO-8601 timestamp when favorited
    pub date_added: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FavoritesFile {
    pub version: u32,
    pub items: Vec<FavoriteItem>,
}

static FAVORITES_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn favorites_path() -> PathBuf {
    paths::data_dir().join("favorites.json")
}

fn favorites_backup_path() -> PathBuf {
    paths::data_dir().join("favorites.json.bak")
}

pub async fn load_favorites() -> Result<Vec<FavoriteItem>, String> {
    let path = favorites_path();
    if !path.exists() {
        let bak = favorites_backup_path();
        if !bak.exists() {
            return Ok(Vec::new());
        }
        if let Ok(contents) = tokio::fs::read_to_string(&bak).await {
            if let Ok(file) = serde_json::from_str::<FavoritesFile>(&contents) {
                return Ok(file.items);
            }
        }
        return Ok(Vec::new());
    }

    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read favorites.json: {}", e))?;

    match serde_json::from_str::<FavoritesFile>(&contents) {
        Ok(file) => Ok(file.items),
        Err(e) => {
            // Also try fallback as direct Vec<FavoriteItem>
            if let Ok(items) = serde_json::from_str::<Vec<FavoriteItem>>(&contents) {
                return Ok(items);
            }
            // If primary file was corrupted, try recovering from backup mirror
            let bak = favorites_backup_path();
            if bak.exists() {
                if let Ok(bak_contents) = tokio::fs::read_to_string(&bak).await {
                    if let Ok(bak_file) = serde_json::from_str::<FavoritesFile>(&bak_contents) {
                        tracing::warn!("Recovered favorites from favorites.json.bak after parse failure: {}", e);
                        return Ok(bak_file.items);
                    }
                }
            }
            tracing::warn!("Failed to parse favorites.json: {}", e);
            Err(format!("Failed to parse favorites.json: {}", e))
        }
    }
}

pub async fn save_favorites(items: &[FavoriteItem]) -> Result<(), String> {
    let file = FavoritesFile {
        version: 1,
        items: items.to_vec(),
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize favorites: {}", e))?;

    let final_path = favorites_path();
    let backup_path = favorites_backup_path();

    tokio::task::spawn_blocking(move || {
        paths::atomic_write(&final_path, json.as_bytes())
            .map_err(|e| format!("Failed to commit favorites: {}", e))?;
        let _ = paths::atomic_write(&backup_path, json.as_bytes());
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Failed to execute blocking write: {}", e))??;

    Ok(())
}

/// Toggles a favorite item.
/// If already present, removes it and returns Ok(false).
/// If not present, caches its icon if available, adds it to the front, and returns Ok(true).
pub async fn toggle_favorite(mut item: FavoriteItem) -> Result<bool, String> {
    let _guard = FAVORITES_LOCK.lock().await;
    let mut items = load_favorites().await?;

    if let Some(pos) = items.iter().position(|i| i.id == item.id) {
        items.remove(pos);
        save_favorites(&items).await?;
        return Ok(false);
    }

    // Never trust client-supplied local filesystem paths from IPC
    item.local_icon_path = None;

    // Cache the icon locally for offline resilience if remote url is available
    if let Some(ref url) = item.icon_url {
        if let Some(cached_path) = icon_cache::cache_remote_icon(url).await {
            item.local_icon_path = Some(cached_path);
        }
    }

    if item.date_added.is_empty() {
        item.date_added = chrono::Utc::now().to_rfc3339();
    }

    items.insert(0, item);
    save_favorites(&items).await?;
    Ok(true)
}

pub async fn remove_favorite(id: &str) -> Result<bool, String> {
    let _guard = FAVORITES_LOCK.lock().await;
    let mut items = load_favorites().await?;
    if let Some(pos) = items.iter().position(|i| i.id == id) {
        items.remove(pos);
        save_favorites(&items).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_favorite_item_serde() {
        let item = FavoriteItem {
            id: "modrinth:fALhf0ST".to_string(),
            platform: "modrinth".to_string(),
            project_id: "fALhf0ST".to_string(),
            slug: "fabric-api".to_string(),
            title: "Fabric API".to_string(),
            description: "Essential hooks".to_string(),
            author: Some("modmuss50".to_string()),
            icon_url: Some("https://example.com/icon.png".to_string()),
            local_icon_path: None,
            category: "mod".to_string(),
            loaders: vec!["fabric".to_string(), "quilt".to_string()],
            versions: vec!["1.20.1".to_string(), "1.21.1".to_string()],
            version_name: Some("0.100.0".to_string()),
            date_added: "2026-10-11T12:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&item).unwrap();
        let parsed: FavoriteItem = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "modrinth:fALhf0ST");
        assert_eq!(parsed.platform, "modrinth");
        assert_eq!(parsed.category, "mod");
        assert_eq!(parsed.loaders.len(), 2);
    }
}
