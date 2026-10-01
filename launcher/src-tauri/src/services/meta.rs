// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::{Deserialize, Serialize};
use crate::util::paths;
use std::fs;

const VERSION_MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META_URL: &str = "https://meta.fabricmc.net/v2/versions/loader";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FabricLoaderVersion {
    pub separator: Option<String>,
    pub build: Option<u32>,
    pub maven: Option<String>,
    pub version: String,
    pub stable: bool,
}

/// Fetch the Mojang version manifest (with local caching)
pub async fn get_version_manifest(force_refresh: bool) -> Result<VersionManifest, String> {
    let cache_path = paths::meta_dir().join("version_manifest_v2.json");

    // Use cache if fresh (less than 1 hour old) and not forcing refresh
    if !force_refresh && cache_path.exists() {
        if let Ok(metadata) = fs::metadata(&cache_path) {
            if let Ok(modified) = metadata.modified() {
                let age = std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if age.as_secs() < 3600 {
                    if let Ok(content) = fs::read_to_string(&cache_path) {
                        if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&content) {
                            return Ok(manifest);
                        }
                    }
                }
            }
        }
    }

    // Fetch fresh manifest
    let resp = crate::util::http::HTTP
        .get(VERSION_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch version manifest: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Version manifest HTTP {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| format!("Read body: {}", e))?;

    // Cache it
    let meta_dir = paths::meta_dir();
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let _ = fs::write(&cache_path, &text);

    serde_json::from_str::<VersionManifest>(&text)
        .map_err(|e| format!("Parse manifest: {}", e))
}

/// Fetch Fabric loader versions
pub async fn get_fabric_versions() -> Result<Vec<FabricLoaderVersion>, String> {
    let cache_path = paths::meta_dir().join("fabric_loader_versions.json");

    // Use cache if less than 6 hours old
    if cache_path.exists() {
        if let Ok(metadata) = fs::metadata(&cache_path) {
            if let Ok(modified) = metadata.modified() {
                let age = std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if age.as_secs() < 21600 {
                    if let Ok(content) = fs::read_to_string(&cache_path) {
                        if let Ok(versions) = serde_json::from_str::<Vec<FabricLoaderVersion>>(&content) {
                            return Ok(versions);
                        }
                    }
                }
            }
        }
    }

    let resp = crate::util::http::HTTP
        .get(FABRIC_META_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Fabric versions: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Fabric meta HTTP {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| format!("Read body: {}", e))?;

    let meta_dir = paths::meta_dir();
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let _ = fs::write(&cache_path, &text);

    serde_json::from_str::<Vec<FabricLoaderVersion>>(&text)
        .map_err(|e| format!("Parse Fabric versions: {}", e))
}
