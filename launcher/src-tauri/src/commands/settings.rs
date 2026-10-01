// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::settings::LauncherSettings;
use crate::services::settings_service;

#[tauri::command]
pub async fn get_settings() -> Result<LauncherSettings, String> {
    settings_service::load()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(settings: LauncherSettings) -> Result<(), String> {
    crate::services::download::set_speed_limit_mb(settings.download_speed_limit_mb);
    crate::services::discord::set_enabled(settings.discord_rpc);
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())?;

    if crate::services::google_cloud::is_cloud_connected() {
        tokio::spawn(async {
            crate::services::google_cloud::sync_settings_background().await;
        });
    }

    Ok(())
}

/// The launcher's root data directory as a display string for the current
/// platform (Windows `%LOCALAPPDATA%\Vermeil`, Linux `~/.local/share/Vermeil`,
/// macOS `~/Library/Application Support/Vermeil`). The Resources tab shows this
/// so the path matches reality instead of a hardcoded Windows string.
#[tauri::command]
pub async fn get_app_directory() -> Result<String, String> {
    Ok(paths::data_dir().to_string_lossy().to_string())
}

/// Open the launcher's data directory in the OS file manager.
#[tauri::command]
pub async fn open_app_directory() -> Result<(), String> {
    let dir = paths::data_dir();
    if dir.exists() {
        open::that(&dir).map_err(|e| format!("Failed to open {}: {}", dir.display(), e))?;
    }
    Ok(())
}

use crate::util::paths;
use std::fs;

/// Calculate the total size of all purgeable caches.
///
/// Includes:
/// - `<data>/cache/` — all unified caches (installers, scratch, icons, meta, versions, companion)
/// - Any lingering legacy root cache directories (`loader-scratch`, `icons`, `versions`, `meta`)
/// - `assets/indexes/` — asset index JSONs
///
/// Does NOT include (too expensive to re-download or user data):
/// - `libraries/` — shared Java libraries across all instances
/// - `assets/objects/` — shared game assets (sounds, textures, 1-2GB)
/// - `java/` — Java runtimes
/// - `instances/` — user worlds, mods, configs
/// - `accounts.json`, `config.json` — user credentials and settings
/// - `skins/`, `capes/` — user skin and cape libraries
#[tauri::command]
pub async fn get_cache_size() -> Result<u64, String> {
    let mut total: u64 = 0;

    // 1. Unified cache directory (<data>/cache)
    let cache_dir = paths::cache_dir();
    if cache_dir.exists() {
        total += dir_size(&cache_dir);
    }

    // 2. Lingering legacy root-level cache directories
    let data = paths::data_dir();
    for legacy in ["loader-scratch", "icons", "versions", "meta"] {
        let dir = data.join(legacy);
        if dir.exists() {
            total += dir_size(&dir);
        }
    }
    let legacy_comp_jars = data.join("companion").join("jars");
    if legacy_comp_jars.exists() {
        total += dir_size(&legacy_comp_jars);
    }

    // 3. Asset index JSONs (not the objects — those are 1-2 GB)
    let indexes_dir = paths::assets_dir().join("indexes");
    if indexes_dir.exists() {
        total += dir_size(&indexes_dir);
    }

    Ok(total)
}

/// Purge all purgeable caches. Returns the number of bytes freed.
///
/// After purging, the next instance launch will re-download version
/// metadata, client JARs, asset indexes, and project icons as needed.
/// Forge/NeoForge instances will re-run their installer on next launch.
#[tauri::command]
pub async fn purge_cache() -> Result<u64, String> {
    let mut freed: u64 = 0;

    // 1. Unified cache directory (<data>/cache)
    let cache_dir = paths::cache_dir();
    if cache_dir.exists() {
        freed += dir_size(&cache_dir);
        if let Err(e) = fs::remove_dir_all(&cache_dir) {
            tracing::warn!("Failed to remove cache dir {:?}: {}", cache_dir, e);
        }
        let _ = fs::create_dir_all(&cache_dir);
    }

    // 2. Sweep lingering legacy root-level cache directories
    let data = paths::data_dir();
    for legacy in ["loader-scratch", "icons", "versions", "meta"] {
        let dir = data.join(legacy);
        if dir.exists() {
            freed += dir_size(&dir);
            if let Err(e) = fs::remove_dir_all(&dir) {
                tracing::warn!("Failed to remove legacy cache {:?}: {}", dir, e);
            }
        }
    }
    let legacy_comp_jars = data.join("companion").join("jars");
    if legacy_comp_jars.exists() {
        freed += dir_size(&legacy_comp_jars);
        let _ = fs::remove_dir_all(&legacy_comp_jars);
    }

    // 3. Asset index JSONs
    let indexes_dir = paths::assets_dir().join("indexes");
    if indexes_dir.exists() {
        freed += dir_size(&indexes_dir);
        if let Err(e) = fs::remove_dir_all(&indexes_dir) {
            tracing::warn!("Failed to remove asset indexes dir {:?}: {}", indexes_dir, e);
        }
    }

    tracing::info!("Purged launcher cache: freed {} bytes", freed);
    // Sanitize all instances so any ghost local_icon_paths in the purged cache are healed immediately
    let _ = crate::services::instance_service::list_all().await;
    crate::util::platform::update_windows_estimated_size();
    Ok(freed)
}

fn dir_size(path: &std::path::Path) -> u64 {
    crate::util::paths::dir_size(path)
}

/// Calculate the total size of shared Minecraft game data (`assets/` and `libraries/`).
#[tauri::command]
pub async fn get_shared_game_data_size() -> Result<u64, String> {
    let assets = paths::assets_dir();
    let libraries = paths::libraries_dir();
    Ok(calculate_shared_data_size(&[&assets, &libraries]))
}

pub(crate) fn calculate_shared_data_size(dirs: &[&std::path::Path]) -> u64 {
    dirs.iter()
        .filter(|d| d.exists())
        .map(|d| dir_size(d))
        .sum()
}

/// Purge shared Minecraft game data (`assets/` and `libraries/`).
/// Returns the number of bytes freed and recreates empty root directories.
#[tauri::command]
pub async fn purge_shared_game_data() -> Result<u64, String> {
    let assets = paths::assets_dir();
    let libraries = paths::libraries_dir();
    let freed = purge_game_data_dirs(&[&assets, &libraries]);
    tracing::info!("Purged shared game data: freed {} bytes", freed);
    crate::util::platform::update_windows_estimated_size();
    Ok(freed)
}

pub(crate) fn purge_game_data_dirs(dirs: &[&std::path::Path]) -> u64 {
    let mut freed: u64 = 0;
    for dir in dirs {
        if dir.exists() {
            freed += dir_size(dir);
            if let Err(e) = fs::remove_dir_all(dir) {
                tracing::warn!("Failed to remove dir {:?}: {}", dir, e);
            }
            let _ = fs::create_dir_all(dir);
        }
    }
    freed
}

/// Get total system memory in MB.
#[tauri::command]
pub async fn get_system_memory() -> Result<u64, String> {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    Ok(sys.total_memory() / 1024 / 1024) // bytes → MB
}

/// Load persisted download history from disk.
#[tauri::command]
pub async fn load_download_history() -> Result<String, String> {
    let path = paths::data_dir().join("download_history.json");
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read download history: {}", e))
}

/// Save download history to disk (capped at 200 entries by the frontend).
#[tauri::command]
pub async fn save_download_history(json: String) -> Result<(), String> {
    let path = paths::data_dir().join("download_history.json");
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write download history: {}", e))
}

/// Update window, taskbar, system tray, and OS shortcuts to match the selected theme.
#[tauri::command]
pub async fn set_theme_icon(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    crate::services::window_icon::apply_theme_icon(&app, &theme)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_size_and_purge() {
        let cache = paths::cache_dir();
        let test_subdir = cache.join("installers");
        std::fs::create_dir_all(&test_subdir).unwrap();
        let test_file = test_subdir.join("test_installer.jar");
        std::fs::write(&test_file, vec![0u8; 1024]).unwrap();

        let size = get_cache_size().await.unwrap();
        assert!(size >= 1024);

        let freed = purge_cache().await.unwrap();
        assert!(freed >= 1024);
        assert!(!test_file.exists());
    }

    #[tokio::test]
    async fn test_shared_game_data_size_and_purge() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_shared_game_data_{}", uuid::Uuid::new_v4()));
        let assets = temp.join("assets");
        let libraries = temp.join("libraries");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(&libraries).unwrap();

        let test_asset = assets.join("test_asset.ogg");
        let test_lib = libraries.join("test_lib.jar");
        std::fs::write(&test_asset, vec![0u8; 2048]).unwrap();
        std::fs::write(&test_lib, vec![0u8; 4096]).unwrap();

        let size = calculate_shared_data_size(&[&assets, &libraries]);
        assert_eq!(size, 6144);

        let freed = purge_game_data_dirs(&[&assets, &libraries]);
        assert_eq!(freed, 6144);
        assert!(!test_asset.exists());
        assert!(!test_lib.exists());
        assert!(assets.exists());
        assert!(libraries.exists());

        let _ = std::fs::remove_dir_all(&temp);

        // Verify the IPC command itself executes cleanly
        let live_size = get_shared_game_data_size().await;
        assert!(live_size.is_ok());
    }
}
