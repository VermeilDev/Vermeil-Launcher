// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Modpack installation service (Modrinth .mrpack format).
//!
//! Single-pass install: writes instance.json, builds the list of mod-content
//! download tasks from `modrinth.index.json`, then hands everything to
//! `prepare_with_extras` so game files + Java + mod content all stream through
//! one batch with one progress popup.

use crate::models::instance::{Instance, JavaConfig, LoaderConfig, LoaderType, ModEntry, WindowConfig};
use crate::services::download::{DownloadTask, download_file};
use crate::services::prepare::{PostAction, prepare_with_extras};
use crate::util::paths;
use serde::Deserialize;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use tauri::Emitter;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct MrpackIndex {
    name: String,
    /// Author-set version label for this modpack release (mrpack spec
    /// `versionId`). Surfaced as the Library card's modpack version badge.
    #[serde(rename = "versionId", default)]
    version_id: Option<String>,
    files: Vec<MrpackFile>,
    dependencies: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct MrpackFile {
    path: String,
    hashes: MrpackHashes,
    downloads: Vec<String>,
    #[serde(rename = "fileSize")]
    file_size: u64,
}

#[derive(Debug, Deserialize)]
struct MrpackHashes {
    sha1: Option<String>,
}

/// Install a modpack from a Modrinth project. Downloads the .mrpack metadata,
/// then runs the unified prepare flow (game files + Java + mod content + overrides).
pub async fn install_from_modrinth(
    project_id: &str,
    version_id: Option<&str>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    let source_project_id = project_id.to_string();

    // Show the install-progress popup immediately so the user sees feedback while
    // we do the API calls + .mrpack download. Without this, the UI sits frozen on
    // a closed modal for several seconds before `prepare_with_extras` opens the popup.
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Fetching modpack metadata...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Fetch the project's icon up-front so the new instance carries it as
    // its tile icon in the Library and sidebar pin tile. Best-effort —
    // a missing icon falls back to the generic placeholder.
    let project_icon_path = match fetch_project_icon(project_id).await {
        Ok(Some(url)) => crate::services::icon_cache::cache_remote_icon(&url).await,
        _ => None,
    };

    // 1. Get the version to install
    let version_url = if let Some(vid) = version_id {
        format!("https://api.modrinth.com/v2/version/{}", vid)
    } else {
        // Get latest version
        let versions_url = format!(
            "https://api.modrinth.com/v2/project/{}/version",
            project_id
        );
        let resp = crate::util::http::HTTP
            .get(&versions_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch versions for {}: {}", project_id, e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Modrinth returned HTTP {} when fetching versions for project {}: {}",
                status, project_id, body.chars().take(200).collect::<String>()
            ));
        }
        let versions: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse versions list for {}: {}", project_id, e))?;
        let first = versions.first().ok_or("No versions available")?;
        let vid = first.get("id").and_then(|v| v.as_str()).ok_or("No version ID")?;
        format!("https://api.modrinth.com/v2/version/{}", vid)
    };

    let resp = crate::util::http::HTTP
        .get(&version_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch version data: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Modrinth returned HTTP {} when fetching version data: {}",
            status, body.chars().take(200).collect::<String>()
        ));
    }
    let version_data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse version data: {}", e))?;

    // Find the .mrpack file
    let files = version_data
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or("No files in version")?;
    let mrpack_file = files
        .iter()
        .find(|f| {
            f.get("filename")
                .and_then(|n| n.as_str())
                .map(|n| n.ends_with(".mrpack"))
                .unwrap_or(false)
        })
        .ok_or("No .mrpack file found")?;

    let mrpack_url = mrpack_file
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("No URL for mrpack")?;

    // 2. Download the .mrpack file (small, single download — kept outside the unified batch
    // because we need to read its manifest before we know what else to download).
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Downloading modpack...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }
    // Unique per install: a fixed name meant two concurrent modpack installs
    // wrote the same file and each extracted whatever the other had just landed.
    let temp_path = paths::data_dir().join(format!("temp_modpack_{}.mrpack", Uuid::new_v4()));
    let task = DownloadTask {
        url: mrpack_url.to_string(),
        dest: temp_path.clone(),
        expected_sha1: None,
        expected_size: None,
    };
    // Clean up on failure too. The temp name is unique per install, so unlike the
    // old fixed name a leftover here would never be overwritten by a later run.
    if let Err(e) = download_file(&crate::util::http::HTTP, &task).await {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    // 3. Install from the downloaded file
    let result = install_from_mrpack_file(
        &temp_path,
        Some(source_project_id),
        project_icon_path,
        window,
    )
    .await;

    // Cleanup temp file regardless of success/failure
    let _ = fs::remove_file(&temp_path);

    result
}

fn compute_file_sha1(path: &std::path::Path) -> Option<String> {
    use sha1::{Digest, Sha1};
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

/// Install a modpack from a local .mrpack file. Writes instance.json, then runs
/// the unified prepare flow with mod tasks + an override-extraction post action.
///
/// `project_icon_path` is an optional pre-cached icon path (typically populated
/// when this is called via `install_from_modrinth`). If not supplied, we resolve
/// the icon automatically via archive extraction or Modrinth hash/name search.
pub async fn install_from_mrpack_file(
    mrpack_path: &PathBuf,
    mut source_project_id: Option<String>,
    mut project_icon_path: Option<String>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    // Open the ZIP, read manifest, and extract embedded icon if present.
    // Done in a dedicated synchronous block so `archive` and `ZipFile` references
    // are dropped before any async await points (ensuring Send safety).
    let (index, embedded_icon_bytes) = {
        let file = fs::File::open(mrpack_path).map_err(|e| format!("Open mrpack: {}", e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Read mrpack ZIP: {}", e))?;

        let mut index_str = String::new();
        {
            let mut entry = archive
                .by_name("modrinth.index.json")
                .map_err(|_| "No modrinth.index.json in mrpack")?;
            entry
                .read_to_string(&mut index_str)
                .map_err(|e| format!("Read index: {}", e))?;
        }

        let parsed_index: MrpackIndex = serde_json::from_str(&index_str)
            .map_err(|e| format!("Parse modrinth.index.json: {}", e))?;

        let mut found_icon = None;
        for candidate in &[
            "icon.png", "pack.png", "logo.png", "icon.webp",
            "overrides/icon.png", "overrides/pack.png", "overrides/logo.png",
            "client-overrides/icon.png", "client-overrides/pack.png",
        ] {
            if let Ok(mut entry) = archive.by_name(candidate) {
                let mut buf = Vec::new();
                if entry.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                    let ext = if candidate.ends_with(".webp") { "webp" } else { "png" };
                    found_icon = Some((buf, ext.to_string()));
                    break;
                }
            }
        }

        (parsed_index, found_icon)
    };

    let mut source_version = index.version_id.clone();

    // 1. Cache embedded icon if found in archive
    let embedded_icon_path = if let Some((ref buf, ref ext)) = embedded_icon_bytes {
        crate::services::icon_cache::cache_icon_bytes(buf, ext).await
    } else {
        None
    };

    // 2. If project icon or source project ID is missing, resolve via Modrinth file SHA-1
    if project_icon_path.is_none() || source_project_id.is_none() {
        if let Some(sha1) = compute_file_sha1(mrpack_path) {
            let version_url = format!("https://api.modrinth.com/v2/version_file/{}?algorithm=sha1", sha1);
            if let Ok(resp) = crate::util::http::HTTP.get(&version_url).send().await {
                if resp.status().is_success() {
                    if let Ok(val) = resp.json::<serde_json::Value>().await {
                        if let Some(pid) = val.get("project_id").and_then(|p| p.as_str()) {
                            if source_project_id.is_none() {
                                source_project_id = Some(pid.to_string());
                            }
                            if source_version.is_none() {
                                if let Some(ver) = val.get("version_number").and_then(|v| v.as_str()) {
                                    source_version = Some(ver.to_string());
                                }
                            }
                            if project_icon_path.is_none() {
                                if let Ok(Some(url)) = fetch_project_icon(pid).await {
                                    project_icon_path = crate::services::icon_cache::cache_remote_icon(&url).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback: Search Modrinth by modpack name if still missing project ID or icon
    if (project_icon_path.is_none() || source_project_id.is_none()) && !index.name.is_empty() {
        let search_url = format!(
            "https://api.modrinth.com/v2/search?query={}&facets=[[\"project_type:modpack\"]]&limit=5",
            urlencoding::encode(&index.name)
        );
        if let Ok(resp) = crate::util::http::HTTP.get(&search_url).send().await {
            if resp.status().is_success() {
                if let Ok(val) = resp.json::<serde_json::Value>().await {
                    if let Some(hits) = val.get("hits").and_then(|h| h.as_array()) {
                        let target = index.name.trim().to_lowercase();
                        let matched = hits.iter().find(|h| {
                            let title = h.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_lowercase();
                            let slug = h.get("slug").and_then(|s| s.as_str()).unwrap_or("").trim().to_lowercase();
                            title == target || slug == target
                        }).or_else(|| hits.first());

                        if let Some(hit) = matched {
                            if source_project_id.is_none() {
                                if let Some(pid) = hit.get("project_id").and_then(|p| p.as_str()) {
                                    source_project_id = Some(pid.to_string());
                                }
                            }
                            if project_icon_path.is_none() {
                                if let Some(icon_url) = hit.get("icon_url").and_then(|i| i.as_str()) {
                                    project_icon_path = crate::services::icon_cache::cache_remote_icon(icon_url).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Determine loader and game version
    let game_version = index
        .dependencies
        .get("minecraft")
        .cloned()
        .ok_or("No minecraft version in modpack")?;

    let (loader_type, loader_version) = if let Some(v) = index.dependencies.get("fabric-loader") {
        (LoaderType::Fabric, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("quilt-loader") {
        (LoaderType::Quilt, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("neoforge") {
        (LoaderType::Neoforge, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("forge") {
        (LoaderType::Forge, Some(v.clone()))
    } else {
        (LoaderType::Vanilla, None)
    };

    // Create instance directory
    let id = Uuid::new_v4().to_string();
    let instance_dir = paths::instances_dir().join(&id);
    let minecraft_dir = instance_dir.join(".minecraft");
    let mods_dir = minecraft_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    // Build mod download tasks + ModEntry list (entries reflect what *will* be on disk
    // after `prepare_with_extras` finishes downloading them).
    let mut mod_tasks: Vec<DownloadTask> = Vec::new();
    let mut mod_entries: Vec<ModEntry> = Vec::new();

    for mf in &index.files {
        if let Some(url) = mf.downloads.first() {
            let dest = minecraft_dir.join(&mf.path);
            mod_tasks.push(DownloadTask {
                url: url.clone(),
                dest: dest.clone(),
                expected_sha1: mf.hashes.sha1.clone(),
                expected_size: Some(mf.file_size),
            });

            let sha1_hash = mf.hashes.sha1.clone().unwrap_or_default();

            // Track as content entry based on path
            if let Some(filename) = mf.path.strip_prefix("mods/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: sha1_hash.clone(),
                    filename: filename.to_string(),
                    version_number: None,
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "mod".to_string(),
                    author: None,
                    loaders: Vec::new(),
                    game_versions: Vec::new(),
                });
            } else if let Some(filename) = mf.path.strip_prefix("resourcepacks/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: sha1_hash.clone(),
                    filename: filename.to_string(),
                    version_number: None,
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "resourcepack".to_string(),
                    author: None,
                    loaders: Vec::new(),
                    game_versions: Vec::new(),
                });
            } else if let Some(filename) = mf.path.strip_prefix("shaderpacks/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: sha1_hash.clone(),
                    filename: filename.to_string(),
                    version_number: None,
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "shader".to_string(),
                    author: None,
                    loaders: Vec::new(),
                    game_versions: Vec::new(),
                });
            } else if let Some(filename) = mf.path.strip_prefix("datapacks/") {
                // Top-level `datapacks/` entries in a .mrpack — uncommon (most
                // datapacks live inside a world's `saves/<world>/datapacks/`)
                // but the spec doesn't forbid them. Track as a content entry
                // so the Datapacks tab shows them and metadata enrichment
                // can fetch their icon/title like any other content type.
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: sha1_hash,
                    filename: filename.to_string(),
                    version_number: None,
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "datapack".to_string(),
                    author: None,
                    loaders: Vec::new(),
                    game_versions: Vec::new(),
                });
            }
        }
    }

    // Write the instance metadata so it appears in the library immediately
    // (with duplicate-name handling).
    let final_name = unique_instance_name(&index.name)?;
    let now = chrono::Utc::now().to_rfc3339();
    // The resolved project icon (Modrinth API or embedded archive icon) is
    // copied into the instance's own directory so it survives cache purges.
    let icon_value = crate::services::icon_cache::persist_instance_icon(
        project_icon_path.or(embedded_icon_path),
        &instance_dir,
    );
    let instance = Instance {
        format_version: 1,
        id: id.clone(),
        name: final_name,
        icon: icon_value,
        icon_custom: None,
        created_at: now,
        last_played: None,
        total_play_seconds: 0,
        game_version,
        loader: LoaderConfig {
            loader_type,
            version: loader_version,
        },
        java: JavaConfig::default(),
        window: WindowConfig::default(),
        mods: mod_entries,
        source_project_id,
        source_platforms: vec!["modrinth".to_string()],
        source_version,
        companion_enabled: crate::services::settings_service::load().await.unwrap_or_default().enable_companion_mod,
        companion_version: None,
    };

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

    // Build the override-extraction post action. Captures the .mrpack path; runs
    // after all downloads complete so overrides are written on top of mod files.
    let mrpack_path_owned = mrpack_path.clone();
    let minecraft_dir_owned = minecraft_dir.clone();
    let post: PostAction = Box::new(move || {
        Box::pin(async move {
            extract_overrides(&mrpack_path_owned, &minecraft_dir_owned).await
        })
    });

    // Run the unified prepare flow. This handles MC libs/assets/client jar,
    // loader libs, Java, then mod files, and finally extracts overrides via
    // the post action above.
    // On failure, delete the partially-created instance directory so no broken
    // instance shows up in the library.
    let window_for_revalidate = window.clone();
    let window_for_enrichment_outer = window.clone();
    if let Err(e) = prepare_with_extras(&instance, mod_tasks, Some(post), window).await {
        tracing::error!("Modpack prepare failed, cleaning up instance {}: {}", id, e);
        let _ = fs::remove_dir_all(&instance_dir);
        return Err(e);
    }

    // Loader-version validation: now that the mods are on disk, scan them for
    // loader requirements the pack's declared loader version doesn't meet. If
    // a bump is needed, instance.json is updated and we re-run prepare to pull
    // the newer loader libraries.
    if let Err(e) = revalidate_loader(&id, window_for_revalidate).await {
        tracing::warn!("Loader revalidation failed for {} (non-fatal): {}", id, e);
    }

    // Enrich mod metadata (titles, icons, authors) from APIs in the
    // background so the install completes (and the Library card appears)
    // immediately. Two-phase emit: metadata first (cards populate),
    // then icons (cards swap to local copies). The function emits
    // `instance-enriched` itself after each phase.
    let id_for_enrichment = id.clone();
    let window_for_enrichment = window_for_enrichment_outer;
    tokio::spawn(async move {
        if let Err(e) = enrich_mod_metadata(&id_for_enrichment, window_for_enrichment).await {
            tracing::warn!("Metadata enrichment failed for {} (non-fatal): {}", id_for_enrichment, e);
        }
    });

    // Re-read the (possibly loader-bumped) instance so the returned value
    // reflects the final state.
    let final_instance = crate::services::instance_service::get_by_id(&id)
        .await
        .unwrap_or(instance);

    Ok(final_instance)
}

/// Scan installed mods and bump the loader version if any mod requires a
/// newer one, then re-prepare to install the new loader libraries. Shared by
/// the Modrinth and CurseForge modpack install paths.
pub async fn revalidate_loader(
    instance_id: &str,
    window: Option<tauri::WebviewWindow>,
) -> Result<(), String> {
    let fix = crate::services::loader_scan::validate_and_fix_loader(instance_id).await?;
    if !fix.bumped {
        return Ok(());
    }

    // Surface the bump to the user.
    if let (Some(w), Some(ref from), Some(ref to)) =
        (window.as_ref(), &fix.from_version, &fix.to_version)
    {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Adjusting loader".to_string(),
                message: format!(
                    "Upgraded loader {} → {} for {} mod{}",
                    from, to, fix.mods_requiring,
                    if fix.mods_requiring == 1 { "" } else { "s" }
                ),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Re-run prepare with the bumped loader version to fetch its libraries.
    let bumped = crate::services::instance_service::get_by_id(instance_id)
        .await
        .map_err(|e| format!("Reload instance after bump: {}", e))?;
    crate::services::prepare::prepare(&bumped, window).await
}

/// Enrich mod entries in a modpack instance with metadata (title, icon URL,
/// author) from their respective APIs, then cache icons to disk for offline
/// use. Called after modpack install completes. Mods without a `project_id`
/// (Modrinth .mrpack path) get looked up via the hash endpoint; CurseForge
/// mods are batched via the `/v1/mods` endpoint.
///
/// Two-phase to keep the UI responsive on big packs:
///   1. **Metadata** — batch API calls, write titles/descriptions/icon URLs
///      back to instance.json, emit `instance-enriched` so the frontend
///      renders cards immediately (icons load from the remote CDN via
///      `<img>` while phase 2 runs).
///   2. **Icon caching** — parallel downloads (fixed concurrency 8, see the
///      cdn-vs-api note in coding-standards) write each icon to the local
///      `icons/` cache. Once done, save again and re-emit so the UI swaps
///      to local files.
///
/// This is best-effort — enrichment failures don't break the instance, they
/// just leave cards with filename-only display (or with remote icon URLs
/// that won't survive offline).
pub async fn enrich_mod_metadata(
    instance_id: &str,
    window: Option<tauri::WebviewWindow>,
) -> Result<(), String> {
    let meta_path = paths::instances_dir().join(instance_id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Sync any unindexed .jar files from .minecraft/mods/ (e.g. .mrpack overrides/mods/*.jar)
    let mods_dir = paths::instances_dir().join(instance_id).join(".minecraft").join("mods");
    if let Ok(rd) = std::fs::read_dir(&mods_dir) {
        // Exclude and purge any Vermeil companion mod jars so they are never indexed as user mods
        instance.mods.retain(|m| !crate::services::companion_mod::is_managed(&m.filename));

        let known_files: std::collections::HashSet<String> = instance
            .mods
            .iter()
            .map(|m| m.filename.trim_end_matches(".disabled").to_lowercase())
            .collect();
        let default_source = if instance.source_project_id.is_some() {
            "modpack"
        } else {
            "local"
        };
        for entry in rd.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let clean = fname.trim_end_matches(".disabled");
            if clean.to_lowercase().ends_with(".jar")
                && !known_files.contains(&clean.to_lowercase())
                && !crate::services::companion_mod::is_managed(&fname)
            {
                instance.mods.push(crate::models::instance::ModEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: default_source.to_string(),
                    project_id: String::new(),
                    version_id: String::new(),
                    filename: clean.to_string(),
                    version_number: None,
                    enabled: !fname.ends_with(".disabled"),
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "mod".to_string(),
                    author: None,
                    loaders: Vec::new(),
                    game_versions: Vec::new(),
                });
            }
        }
    }

    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let api_key = if settings.curseforge_api_key.trim().is_empty() {
        crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string()
    } else {
        settings.curseforge_api_key.trim().to_string()
    };

    // ─── Phase 1: metadata ───────────────────────────────────────────────
    // Hit the batch APIs once each, write titles/descriptions/icon URLs.
    // Icon downloads are deferred to phase 2 so the user sees populated
    // cards within ~1s of install completion instead of waiting for every
    // icon to round-trip serially.

    // Collect CurseForge project IDs that need enrichment (CurseForge IDs are numeric)
    let cf_ids: Vec<String> = instance.mods.iter()
        .filter(|m| {
            let is_cf_id = m.project_id.parse::<u64>().is_ok();
            (m.source == "curseforge" || (m.source == "modpack" && is_cf_id)) && !m.project_id.is_empty() && m.title.is_none()
        })
        .map(|m| m.project_id.clone())
        .collect();

    // Batch fetch CurseForge metadata using existing helper (handles 50-chunking, logos, attachments)
    if !cf_ids.is_empty() {
        let metas = crate::services::curseforge::fetch_projects_meta(&api_key, &cf_ids).await;
        for entry in instance.mods.iter_mut() {
            if let Some(meta) = metas.get(&entry.project_id) {
                if entry.title.is_none() {
                    entry.title = meta.name.clone();
                    entry.icon_url = meta.icon_url.clone();
                    entry.author = meta.author.clone();
                    entry.description = meta.summary.clone();
                }
            }
        }
    }

    // For Modrinth-sourced entries (mods, resource packs, shader packs,
    // datapacks) that need metadata enrichment (title is None).
    // An entry might already have a project_id (e.g. from an earlier hash resolution
    // where project metadata fetch failed) or it needs hash lookup.
    let modrinth_entries: Vec<(usize, String, String, String, String)> = instance.mods.iter().enumerate()
        .filter(|(_, m)| {
            let is_cf_id = m.project_id.parse::<u64>().is_ok();
            let is_modpack_entry = m.source == "modpack"
                || (instance.source_platforms.iter().any(|p| p == "modrinth") && m.source == "modrinth");
            is_modpack_entry && !is_cf_id && m.title.is_none()
        })
        .map(|(i, m)| (i, m.filename.clone(), m.category.clone(), m.version_id.clone(), m.project_id.clone()))
        .collect();

    if !modrinth_entries.is_empty() {
        let minecraft_dir = paths::instances_dir().join(instance_id).join(".minecraft");
        let mut hash_to_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut hashes: Vec<String> = Vec::new();
        let mut project_ids: Vec<String> = Vec::new();

        for (idx, filename, category, sha1_from_manifest, existing_pid) in &modrinth_entries {
            // If both project_id and a non-SHA1 version_id were already resolved, reuse project_id directly
            let is_sha1_vid = sha1_from_manifest.len() == 40
                && sha1_from_manifest.chars().all(|c| c.is_ascii_hexdigit());
            if !existing_pid.is_empty() && !is_sha1_vid {
                project_ids.push(existing_pid.clone());
                continue;
            }

            if !sha1_from_manifest.is_empty() {
                hash_to_idx.insert(sha1_from_manifest.clone(), *idx);
                hashes.push(sha1_from_manifest.clone());
            } else {
                let subdir = match category.as_str() {
                    "resourcepack" => "resourcepacks",
                    "shader" => "shaderpacks",
                    "datapack" => "datapacks",
                    _ => "mods",
                };
                let file_path = minecraft_dir.join(subdir).join(filename);
                if file_path.exists() {
                    if let Ok(bytes) = std::fs::read(&file_path) {
                        use sha1::Digest;
                        let hash = format!("{:x}", sha1::Sha1::digest(&bytes));
                        hash_to_idx.insert(hash.clone(), *idx);
                        hashes.push(hash);
                    }
                }
            }
        }

        // Batch lookup via Modrinth (up to 1000 hashes per request)
        if !hashes.is_empty() {
            let body = serde_json::json!({ "hashes": hashes, "algorithm": "sha1" });
            let resp = crate::util::http::HTTP
                .post("https://api.modrinth.com/v2/version_files")
                .json(&body)
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(v) = r.json::<serde_json::Value>().await {
                        // Response is a map of hash → version object
                        if let Some(obj) = v.as_object() {
                            for (hash, version) in obj {
                                if let Some(pid) = version.get("project_id").and_then(|p| p.as_str()) {
                                    project_ids.push(pid.to_string());
                                    // Update the project_id on the entry without changing source to "modrinth"
                                    if let Some(&idx) = hash_to_idx.get(hash) {
                                        instance.mods[idx].project_id = pid.to_string();
                                        if let Some(vid) = version.get("id").and_then(|v| v.as_str()) {
                                            instance.mods[idx].version_id = vid.to_string();
                                        }
                                        if instance.source_project_id.is_some() {
                                            instance.mods[idx].source = "modpack".to_string();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    tracing::warn!("Modrinth /v2/version_files returned HTTP {}: {}", status, text);
                }
                Err(e) => {
                    tracing::warn!("Modrinth /v2/version_files request failed: {}", e);
                }
            }
        }

        // Stage 2: For any mods still unresolved after Modrinth SHA-1 lookup (e.g. CurseForge jars
        // bundled in .mrpack overrides/mods/ or dropped in manually), resolve via CurseForge Murmur2 fingerprints.
        {
            let mut fp_to_indices: std::collections::HashMap<u32, Vec<usize>> =
                std::collections::HashMap::new();
            for (idx, entry) in instance.mods.iter().enumerate() {
                let is_sha1_vid = entry.version_id.len() == 40
                    && entry.version_id.chars().all(|c| c.is_ascii_hexdigit());
                if !entry.project_id.is_empty()
                    && !entry.version_id.is_empty()
                    && !is_sha1_vid
                {
                    continue;
                }
                let subdir = match entry.category.as_str() {
                    "resourcepack" => "resourcepacks",
                    "shader" => "shaderpacks",
                    "datapack" => "datapacks",
                    _ => "mods",
                };
                let file_path = minecraft_dir.join(subdir).join(&entry.filename);
                if let Ok(bytes) = std::fs::read(&file_path) {
                    let fp = crate::services::curseforge::compute_cf_fingerprint(&bytes);
                    fp_to_indices.entry(fp).or_default().push(idx);
                }
            }

            if !fp_to_indices.is_empty() {
                let fps: Vec<u32> = fp_to_indices.keys().copied().collect();
                let matches =
                    crate::services::curseforge::match_fingerprints(&api_key, &fps).await;

                let mut cf_mod_ids: Vec<String> = Vec::new();
                for (fp, matched) in matches {
                    if let Some(indices) = fp_to_indices.get(&fp) {
                        cf_mod_ids.push(matched.mod_id.clone());
                        for &idx in indices {
                            instance.mods[idx].project_id = matched.mod_id.clone();
                            instance.mods[idx].version_id = matched.file_id.clone();
                            if instance.source_project_id.is_none() {
                                instance.mods[idx].source = "curseforge".to_string();
                            }
                            if instance.mods[idx].version_number.is_none() {
                                instance.mods[idx].version_number = matched.display_name.clone();
                            }
                        }
                    }
                }

                cf_mod_ids.sort();
                cf_mod_ids.dedup();
                if !cf_mod_ids.is_empty() {
                    let metas =
                        crate::services::curseforge::fetch_projects_meta(&api_key, &cf_mod_ids)
                            .await;
                    for (mid, meta) in metas {
                        for entry in instance.mods.iter_mut() {
                            if entry.project_id == mid {
                                if entry.title.is_none() {
                                    entry.title = meta.name.clone();
                                }
                                if entry.description.is_none() {
                                    entry.description = meta.summary.clone();
                                }
                                if entry.author.is_none() {
                                    entry.author = meta.author.clone();
                                }
                                if entry.icon_url.is_none() {
                                    entry.icon_url = meta.icon_url.clone();
                                }
                            }
                        }
                    }
                }
            }
        }

        // Batch fetch project metadata in chunks of 50
        // (Modrinth endpoint `/v2/projects` has a strict max limit of 100 IDs)
        project_ids.sort();
        project_ids.dedup();
        for chunk in project_ids.chunks(50) {
            let ids_json = serde_json::to_string(chunk).unwrap_or_default();
            let resp = crate::util::http::HTTP
                .get("https://api.modrinth.com/v2/projects")
                .query(&[("ids", &ids_json)])
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => {
                    match r.json::<Vec<serde_json::Value>>().await {
                        Ok(projects) => {
                            for project in &projects {
                                let pid = project.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                let title = project.get("title").and_then(|t| t.as_str()).map(|s| s.to_string());
                                let description = project.get("description").and_then(|d| d.as_str()).map(|s| s.to_string());
                                let icon = project.get("icon_url").and_then(|u| u.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());

                                for entry in instance.mods.iter_mut() {
                                    if entry.project_id == pid {
                                        if entry.title.is_none() {
                                            entry.title = title.clone();
                                        }
                                        if entry.icon_url.is_none() {
                                            entry.icon_url = icon.clone();
                                        }
                                        if entry.description.is_none() {
                                            entry.description = description.clone();
                                        }
                                        if instance.source_project_id.is_some() && entry.version_number.is_none() {
                                            entry.source = "modpack".to_string();
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => tracing::warn!("Failed to parse Modrinth /v2/projects response: {}", e),
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    tracing::warn!("Modrinth /v2/projects returned HTTP {}: {}", status, text);
                }
                Err(e) => {
                    tracing::warn!("Modrinth /v2/projects request failed: {}", e);
                }
            }
        }
    }

    // ─── Phase 1 commit: write metadata + emit so the UI populates ──────
    // The frontend's `instance-enriched` listener calls `refetchInstances`,
    // and `resolveIconUrl` falls back to `icon_url` (the CDN URL we just
    // wrote) when `local_icon_path` is empty — so cards render with remote
    // icons immediately while phase 2 runs.
    {
        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
        if let Some(ref w) = window {
            use tauri::Emitter;
            let _ = w.emit("instance-enriched", instance_id.to_string());
        }
        tracing::info!("Enriched mod metadata (phase 1) for instance {}", instance_id);
    }

    // ─── Phase 2: parallel icon caching ──────────────────────────────────
    // Sequential `cache_remote_icon().await` per mod (the previous shape)
    // serialized N icon downloads on a single TLS connection — ~20s for a
    // 50-mod pack. Bounded parallel cuts that to ~2s without raising any
    // resource ceiling worth caring about.
    //
    // Concurrency cap is hardcoded (8) because these requests target
    // static-asset CDNs (cdn.modrinth.com, media.forgecdn.net), not
    // rate-limited APIs. The user-tunable `concurrent_downloads` setting
    // is reserved for install-blocking download batches; see the HTTP
    // section of coding-standards for the API-vs-CDN policy split.
    const ICON_CACHE_CONCURRENCY: usize = 8;
    let icon_jobs: Vec<(usize, String)> = instance.mods.iter().enumerate()
        .filter_map(|(idx, m)| {
            // Skip entries that already have a cached icon on disk (subsequent
            // enrichment passes, e.g. after loader revalidation, shouldn't
            // re-download). If the cached file is missing (e.g. after purge), re-cache it.
            if let Some(ref path) = m.local_icon_path {
                if std::path::Path::new(path).exists() {
                    return None;
                }
            }
            m.icon_url.as_ref().filter(|s| !s.is_empty()).map(|u| (idx, u.clone()))
        })
        .collect();

    if !icon_jobs.is_empty() {
        use futures_util::stream::{FuturesUnordered, StreamExt};
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        let sem = Arc::new(Semaphore::new(ICON_CACHE_CONCURRENCY));
        let mut futures = FuturesUnordered::new();
        for (idx, url) in icon_jobs {
            let sem = Arc::clone(&sem);
            futures.push(async move {
                let _permit = sem.acquire().await.ok()?;
                let cached = crate::services::icon_cache::cache_remote_icon(&url).await;
                Some((idx, cached))
            });
        }

        // Drain results into a Vec first so we can mutate `instance.mods`
        // without juggling overlapping borrows inside the stream loop.
        let mut results: Vec<(usize, Option<String>)> = Vec::new();
        while let Some(item) = futures.next().await {
            if let Some(pair) = item { results.push(pair); }
        }
        for (idx, path) in results {
            if let Some(p) = path {
                if let Some(entry) = instance.mods.get_mut(idx) {
                    entry.local_icon_path = Some(p);
                }
            }
        }
    }

    // Cross-platform detection: if this instance was installed from one
    // platform, check if the same modpack (by title) is also published on
    // the other. If so, append the other platform to source_platforms so
    // the UI can show both source badges. Best-effort — failures are
    // silent and just leave the single-platform badge.
    //
    // Runs in phase 2 because it's another network round trip and doesn't
    // need to block the first card render.
    if instance.source_platforms.len() == 1 && !instance.name.is_empty() {
        let installed_platform = instance.source_platforms[0].clone();
        let other = match installed_platform.as_str() {
            "modrinth" => "curseforge",
            "curseforge" => "modrinth",
            _ => "",
        };
        if !other.is_empty() {
            if let Some(_) = check_other_platform(&instance.name, other, &api_key).await {
                instance.source_platforms.push(other.to_string());
                tracing::info!("Detected '{}' is also on {}", instance.name, other);
            }
        }
    }

    // ─── Phase 2 commit: write cached icon paths + emit so cards swap ────
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(ref w) = window {
        use tauri::Emitter;
        let _ = w.emit("instance-enriched", instance_id.to_string());
    }
    tracing::info!("Enriched mod metadata (phase 2) for instance {}", instance_id);
    Ok(())
}

/// Search the given platform for a modpack matching the supplied name.
/// Returns Some(()) when a likely match is found (case-insensitive,
/// alphanumeric-only string equality on titles). Used by the enrichment
/// pass to detect cross-platform availability.
async fn check_other_platform(name: &str, platform: &str, api_key: &str) -> Option<()> {
    // Normalize: lowercase + strip non-alphanumerics. Catches differences
    // like "Fabulously Optimized" vs "fabulously-optimized" or "RLCraft"
    // vs "RL Craft".
    fn normalize(s: &str) -> String {
        s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
    }
    let target = normalize(name);
    if target.is_empty() {
        return None;
    }

    if platform == "modrinth" {
        // Modrinth modpack search
        let url = format!(
            "https://api.modrinth.com/v2/search?query={}&facets=[[\"project_type:modpack\"]]&limit=5",
            urlencoding::encode(name),
        );
        let resp = crate::util::http::HTTP.get(&url).send().await.ok()?;
        let v: serde_json::Value = resp.json().await.ok()?;
        let hits = v.get("hits")?.as_array()?;
        for hit in hits {
            let title = hit.get("title")?.as_str()?;
            if normalize(title) == target {
                return Some(());
            }
        }
    } else if platform == "curseforge" {
        // CurseForge modpack search (classId 4471)
        let url = format!(
            "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter={}&pageSize=5",
            urlencoding::encode(name),
        );
        let resp = crate::util::http::HTTP
            .get(&url)
            .header("x-api-key", api_key)
            .send()
            .await
            .ok()?;
        let v: serde_json::Value = resp.json().await.ok()?;
        let data = v.get("data")?.as_array()?;
        for hit in data {
            let title = hit.get("name")?.as_str()?;
            if normalize(title) == target {
                return Some(());
            }
        }
    }
    None
}

/// Generate a unique instance name by appending "(N)" if needed. Shared with
/// the CurseForge import path so both modpack sources dedupe names the same way.
pub(crate) fn unique_instance_name(base_name: &str) -> Result<String, String> {
    let instances_dir = paths::instances_dir();
    if !instances_dir.exists() {
        return Ok(base_name.to_string());
    }

    let mut existing_names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&instances_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let meta = entry.path().join("instance.json");
        if meta.exists() {
            if let Ok(content) = fs::read_to_string(&meta) {
                if let Ok(inst) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(name) = inst.get("name").and_then(|n| n.as_str()) {
                        existing_names.push(name.to_string());
                    }
                }
            }
        }
    }

    if !existing_names.iter().any(|n| n == base_name) {
        return Ok(base_name.to_string());
    }

    let mut count = 2;
    loop {
        let candidate = format!("{} ({})", base_name, count);
        if !existing_names.iter().any(|n| n == &candidate) {
            return Ok(candidate);
        }
        count += 1;
    }
}

/// Extract override files from a .mrpack into the instance's .minecraft directory.
/// Run as a post-download action so overrides land on top of any mod files.
async fn extract_overrides(
    mrpack_path: &PathBuf,
    minecraft_dir: &PathBuf,
) -> Result<(), String> {
    let mrpack_path = mrpack_path.clone();
    let minecraft_dir = minecraft_dir.clone();

    // Run the synchronous zip extraction on a blocking thread so we don't
    // stall the async runtime.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = fs::File::open(&mrpack_path).map_err(|e| format!("Reopen mrpack: {}", e))?;
        let buf_file = std::io::BufReader::with_capacity(256 * 1024, file);
        let mut archive = zip::ZipArchive::new(buf_file).map_err(|e| format!("Reread ZIP: {}", e))?;
        let mut created_dirs = std::collections::HashSet::new();
        created_dirs.insert(minecraft_dir.clone());

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("ZIP entry: {}", e))?;
            let name = entry.name().to_string();

            let rel_path = if let Some(rest) = name.strip_prefix("overrides/") {
                Some(rest.to_string())
            } else {
                name.strip_prefix("client-overrides/").map(|s| s.to_string())
            };

            if let Some(rel) = rel_path {
                if rel.contains("..") {
                    continue; // Skip path traversal attempts
                }
                let dest = minecraft_dir.join(&rel);
                if rel.is_empty() || entry.is_dir() {
                    if created_dirs.insert(dest.clone()) {
                        let _ = fs::create_dir_all(&dest);
                    }
                } else {
                    if let Some(parent) = dest.parent() {
                        if created_dirs.insert(parent.to_path_buf()) {
                            let _ = fs::create_dir_all(parent);
                        }
                    }
                    let mut outfile =
                        fs::File::create(&dest).map_err(|e| format!("Create: {}", e))?;
                    std::io::copy(&mut entry, &mut outfile)
                        .map_err(|e| format!("Extract: {}", e))?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Override extraction task panicked: {}", e))??;

    Ok(())
}


/// Fetch a Modrinth project's `icon_url` field. Returns `Ok(None)` when the
/// project has no icon set, `Err` only on transport / parse failure. Used by
/// `install_from_modrinth` to populate the new instance's tile icon.
async fn fetch_project_icon(project_id: &str) -> Result<Option<String>, String> {
    let url = format!("https://api.modrinth.com/v2/project/{}", project_id);
    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth project fetch: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("icon_url")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string()))
}

/// Fetch a CurseForge project's logo/thumbnail URL. Returns `Ok(None)` when
/// the project has no logo, `Err` only on transport failure. Used by
/// `install_from_curseforge` to populate the new instance's tile icon.
async fn fetch_cf_project_icon(api_key: &str, project_id: &str) -> Result<Option<String>, String> {
    let url = format!("https://api.curseforge.com/v1/mods/{}", project_id);
    let resp = crate::util::http::HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge project fetch: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let logo = v.get("data").and_then(|d| d.get("logo"));
    // Prefer thumbnailUrl, fall back to full `url` when thumbnail is empty
    // (some CurseForge projects only populate the full-size URL).
    let icon = logo
        .and_then(|l| l.get("thumbnailUrl"))
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| logo.and_then(|l| l.get("url")).and_then(|u| u.as_str()).filter(|s| !s.is_empty()))
        .map(|s| s.to_string());
    Ok(icon)
}

/// Install a modpack from a CurseForge project ID. Fetches the modpack zip
/// from the CurseForge API, downloads it, then imports via `cf_import::import_zip`.
pub async fn install_from_curseforge(
    project_id: &str,
    file_id: Option<&str>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    // Show progress immediately
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Fetching modpack metadata...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Load settings for the API key
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let api_key = if settings.curseforge_api_key.trim().is_empty() {
        crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string()
    } else {
        settings.curseforge_api_key.trim().to_string()
    };

    // Fetch the project's icon up-front so the new instance carries it as
    // its tile icon in the Library and sidebar pin tile. Best-effort —
    // a missing icon falls back to the generic placeholder.
    let project_icon_path = match fetch_cf_project_icon(&api_key, project_id).await {
        Ok(Some(url)) => crate::services::icon_cache::cache_remote_icon(&url).await,
        _ => None,
    };

    // Get the download URL for the modpack file. `None` means the author
    // disabled third-party downloads — hand the user the project page instead of
    // failing with an opaque message.
    let (download_url, pack_file_name) =
        crate::services::curseforge::get_modpack_file_url(&api_key, project_id, file_id).await?;
    let download_url = match download_url {
        Some(u) => u,
        None => {
            let (name, website) =
                crate::services::curseforge::fetch_project_brief(&api_key, project_id).await;
            let title = name.unwrap_or_else(|| project_id.to_string());
            crate::services::manual_download::notify(
                window.as_ref(),
                crate::services::manual_download::ManualDownload {
                    kind: "modpack".to_string(),
                    title: title.clone(),
                    file_name: Some(pack_file_name),
                    url: website,
                    // No instance exists yet — nothing to open a folder for.
                    instance_id: None,
                },
            );
            return Err(format!(
                "{} can't be downloaded automatically — its author disabled \
                 third-party downloads. Download the pack from CurseForge and use \
                 Import instead.",
                title
            ));
        }
    };

    // Download the modpack zip to a temp location
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Downloading modpack...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Unique per install — see the Modrinth path for why a fixed name collided.
    let temp_path = paths::data_dir().join(format!("temp_cf_modpack_{}.zip", Uuid::new_v4()));
    let task = DownloadTask {
        url: download_url,
        dest: temp_path.clone(),
        expected_sha1: None,
        expected_size: None,
    };
    // Clean up on failure too — see the Modrinth path.
    if let Err(e) = download_file(&crate::util::http::HTTP, &task).await {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    // Import via the existing CF import logic. Pass the CurseForge project ID
    // and pre-cached icon so the instance is created atomically with its proper icon,
    // avoiding any race condition with background metadata enrichment.
    let result =
        crate::services::cf_import::import_zip(
            temp_path.to_str().unwrap_or_default(),
            &api_key,
            Some(project_id.to_string()),
            project_icon_path,
            window,
        )
        .await;

    // Cleanup temp file regardless of success/failure
    let _ = fs::remove_file(&temp_path);

    result
}
