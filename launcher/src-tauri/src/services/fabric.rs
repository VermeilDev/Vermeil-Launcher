// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::download::{DownloadTask, download_file};
use crate::util::paths;
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::PathBuf;

const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const LEGACY_FABRIC_META: &str = "https://meta.legacyfabric.net/v2";

/// Determine if a MC version should use Legacy Fabric (pre-1.14)
fn is_legacy_fabric_version(game_version: &str) -> bool {
    let parts: Vec<&str> = game_version.split('.').collect();
    // New format (26.x) — always modern Fabric
    if parts[0] != "1" { return false; }
    if parts.len() < 2 { return true; } // unknown, assume legacy
    let minor: u32 = parts[1].parse().unwrap_or(0);
    minor < 14 // 1.13.x and below use Legacy Fabric
}

#[derive(Debug, Deserialize)]
pub struct FabricVersionMeta {
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Vec<FabricLibrary>,
}

#[derive(Debug, Deserialize)]
pub struct FabricLibrary {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    pub natives: Option<std::collections::HashMap<String, String>>,
    pub rules: Option<Vec<FabricRule>>,
}

#[derive(Debug, Deserialize)]
pub struct FabricRule {
    pub action: String,
}

/// Fetch the Fabric loader profile for a specific game version + loader version
/// Automatically uses Legacy Fabric meta for MC versions below 1.14
pub async fn get_fabric_profile(game_version: &str, loader_version: &str) -> Result<FabricVersionMeta, String> {
    let meta_dir = paths::meta_dir().join("fabric");
    let cache_path = meta_dir.join(format!("{}-{}.json", game_version, loader_version));

    if cache_path.exists() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(meta) = serde_json::from_str::<FabricVersionMeta>(&content) {
                return Ok(meta);
            }
        }
    }

    let meta_base = if is_legacy_fabric_version(game_version) {
        LEGACY_FABRIC_META
    } else {
        FABRIC_META
    };
    let url = format!("{}/versions/loader/{}/{}/profile/json", meta_base, game_version, loader_version);

    let resp = crate::util::http::HTTP.get(&url)
        .send()
        .await
        .map_err(|e| format!("Fabric profile fetch failed: {}", e))?;

    if !resp.status().is_success() {
        if resp.status().as_u16() == 404 {
            return Err(format!("Fabric does not support Minecraft {}. Try a different version.", game_version));
        }
        return Err(format!("Fabric meta returned HTTP {} for {}/{}", resp.status(), game_version, loader_version));
    }

    let text = resp.text().await.map_err(|e| format!("Read Fabric profile: {}", e))?;
    let _ = fs::create_dir_all(&meta_dir);
    let _ = fs::write(&cache_path, &text);

    serde_json::from_str::<FabricVersionMeta>(&text)
        .map_err(|e| format!("Parse Fabric profile: {}", e))
}

/// Convert a Maven coordinate (group:artifact:version) to a file path
/// e.g., "net.fabricmc:fabric-loader:0.16.10" → "net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar"
fn maven_to_path(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }

    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];

    format!("{}/{}/{}/{}-{}.jar", group, artifact, version, artifact, version)
}

/// Convert a Maven coordinate + classifier to a file path
/// e.g., "org.lwjgl.lwjgl:lwjgl-platform:2.9.4+legacyfabric.15" with classifier "natives-windows"
/// → "org/lwjgl/lwjgl/lwjgl-platform/2.9.4+legacyfabric.15/lwjgl-platform-2.9.4+legacyfabric.15-natives-windows.jar"
fn maven_to_path_classified(coordinate: &str, classifier: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }

    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];

    format!("{}/{}/{}/{}-{}-{}.jar", group, artifact, version, artifact, version, classifier)
}

/// Ensure all Fabric libraries are downloaded and return their paths + the main class.
/// For Legacy Fabric, also handles native library extraction.
pub async fn ensure_fabric_libraries(game_version: &str, loader_version: &str) -> Result<(String, Vec<PathBuf>), String> {
    let profile = get_fabric_profile(game_version, loader_version).await?;

    let libs_dir = paths::libraries_dir();
    let mut paths_out = Vec::new();

    for lib in &profile.libraries {
        // Skip libraries with disallow rules
        if let Some(rules) = &lib.rules {
            if rules.iter().any(|r| r.action == "disallow") {
                continue;
            }
        }

        // Skip libraries without a URL (can't download them)
        let base_url = match &lib.url {
            Some(u) => u.as_str(),
            None => continue,
        };

        // Check if this is a natives-only library (has natives map)
        if let Some(natives_map) = &lib.natives {
            // This library provides native .dll/.so files via a classifier jar.
            // Download the natives classifier jar and extract it.
            if let Some(classifier) = natives_map.get(crate::util::platform::natives_map_key()) {
                let rel_path = maven_to_path_classified(&lib.name, classifier);
                let dest = libs_dir.join(&rel_path);

                if !dest.exists() {
                    let url = format!("{}{}", base_url, rel_path);
                    let task = DownloadTask {
                        url,
                        dest: dest.clone(),
                        expected_sha1: None,
                        expected_size: None,
                    };
                    download_file(&crate::util::http::HTTP, &task).await?;
                }

                // Don't add natives jars to classpath — they get extracted to the natives dir.
                // The extraction happens in ensure_fabric_natives() called separately.
            }
            continue; // Skip adding to classpath
        }

        // Standard library — download the main artifact jar
        let rel_path = maven_to_path(&lib.name);
        let dest = libs_dir.join(&rel_path);

        if !dest.exists() {
            let url = format!("{}{}", base_url, rel_path);
            let task = DownloadTask {
                url,
                dest: dest.clone(),
                expected_sha1: None,
                expected_size: None,
            };
            download_file(&crate::util::http::HTTP, &task).await?;
        }

        paths_out.push(dest);
    }

    Ok((profile.main_class, paths_out))
}

/// Get the group/artifact path keys for libraries in the Fabric/Legacy Fabric profile.
/// Used to deduplicate: if the loader provides org.lwjgl.lwjgl:lwjgl, we remove the vanilla
/// version from the classpath so only the loader's version is used.
/// Also includes libraries with "disallow" rules — these are explicitly excluded by the loader.
/// Returns keys like "org/lwjgl/lwjgl/lwjgl/" which can be matched against classpath paths.
pub async fn get_profile_library_keys(game_version: &str, loader_version: &str) -> Result<Vec<String>, String> {
    let profile = get_fabric_profile(game_version, loader_version).await?;
    let mut keys = Vec::new();

    for lib in &profile.libraries {
        // Include ALL libraries in the keys — both provided ones (which override vanilla)
        // and disallowed ones (which should be removed from vanilla classpath)
        let parts: Vec<&str> = lib.name.split(':').collect();
        if parts.len() >= 2 {
            let group = parts[0].replace('.', "/");
            let artifact = parts[1];
            // Build the path prefix that identifies this group:artifact in the filesystem
            // e.g. "org/lwjgl/lwjgl/lwjgl/" matches any version of org.lwjgl.lwjgl:lwjgl
            keys.push(format!("{}/{}/", group, artifact));
        }
    }

    Ok(keys)
}

/// Extract native libraries from Legacy Fabric's LWJGL jars into the instance natives directory.
/// Only needed for Legacy Fabric (pre-1.14) which uses LWJGL 2 with native classifiers.
pub async fn ensure_fabric_natives(game_version: &str, loader_version: &str, instance_id: &str) -> Result<(), String> {
    if !is_legacy_fabric_version(game_version) {
        return Ok(()); // Modern Fabric doesn't need this
    }

    let profile = get_fabric_profile(game_version, loader_version).await?;
    let libs_dir = paths::libraries_dir();
    let natives_dir = paths::instances_dir().join(instance_id).join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

    for lib in &profile.libraries {
        if let Some(natives_map) = &lib.natives {
            if let Some(classifier) = natives_map.get(crate::util::platform::natives_map_key()) {
                let rel_path = maven_to_path_classified(&lib.name, classifier);
                let jar_path = libs_dir.join(&rel_path);

                if jar_path.exists() {
                    // Extract .dll files from the natives jar (overwrite vanilla natives if present)
                    if let Ok(file) = fs::File::open(&jar_path) {
                        if let Ok(mut archive) = zip::ZipArchive::new(file) {
                            for i in 0..archive.len() {
                                if let Ok(mut entry) = archive.by_index(i) {
                                    let name = entry.name().to_string();
                                    // Skip META-INF and only extract native binaries
                                    if name.starts_with("META-INF") { continue; }
                                    if name.ends_with(".dll") || name.ends_with(".so") || name.ends_with(".dylib") {
                                        let out_path = natives_dir.join(
                                            std::path::Path::new(&name).file_name().unwrap_or_default()
                                        );
                                        // Always overwrite — Legacy Fabric natives take precedence over vanilla
                                        if let Ok(mut outfile) = fs::File::create(&out_path) {
                                            let _ = io::copy(&mut entry, &mut outfile);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
