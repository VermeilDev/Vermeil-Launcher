// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! CurseForge import service.
//! Supports two import methods:
//! 1. Import from .zip file (CurseForge export format with manifest.json)
//! 2. Import from profile share code (requires CurseForge API key)

use crate::models::instance::{Instance, LoaderType, LoaderConfig, JavaConfig, WindowConfig};
use crate::services::download::DownloadTask;
use crate::services::prepare::{PostAction, prepare_with_extras};
use crate::util::paths;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

const CF_API_BASE: &str = "https://api.curseforge.com/v1";

// === CurseForge manifest format (inside .zip exports) ===

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfManifest {
    pub minecraft: CfMinecraft,
    pub name: String,
    /// Modpack release version from the CurseForge manifest. Shown as the
    /// Library card's modpack version badge.
    #[serde(default)]
    pub version: Option<String>,
    pub files: Vec<CfFile>,
    #[serde(default)]
    pub overrides: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfMinecraft {
    pub version: String,
    #[serde(default)]
    pub mod_loaders: Vec<CfModLoader>,
}

#[derive(Debug, Deserialize)]
pub struct CfModLoader {
    pub id: String,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Deserialize)]
pub struct CfFile {
    #[serde(rename = "projectID")]
    pub project_id: u64,
    #[serde(rename = "fileID")]
    pub file_id: u64,
}

// === CurseForge API response types ===

#[derive(Debug, Deserialize)]
pub struct CfApiResponse<T> {
    pub data: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFileInfo {
    pub id: u64,
    pub file_name: String,
    pub download_url: Option<String>,
    pub file_length: u64,
    pub hashes: Vec<CfHash>,
}

#[derive(Debug, Deserialize)]
pub struct CfHash {
    pub value: String,
    #[serde(rename = "algo")]
    pub algo: u32, // 1 = SHA1, 2 = MD5
}

// === Import from .zip ===

/// Import a CurseForge modpack from a .zip file.
/// Extracts manifest.json, resolves mod URLs, writes instance.json, then runs
/// the unified prepare flow (game files + Java + mod content + overrides).
///
/// `source_project_id` ties the resulting instance back to its CurseForge
/// project so the modpack browser's "already installed" tracker can match it.
/// Direct zip imports (from the Import modal) pass `None`.
pub async fn import_zip(
    zip_path: &str,
    api_key: &str,
    mut source_project_id: Option<String>,
    mut project_icon: Option<String>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    let zip_path_buf = PathBuf::from(zip_path);

    // Find and parse manifest.json, and extract embedded icon if present.
    // Done in a dedicated synchronous block so `archive` and `ZipFile` references
    // are dropped before any async await points (ensuring Send safety).
    let (manifest, embedded_icon_bytes) = {
        let zip_file = fs::File::open(&zip_path_buf)
            .map_err(|e| format!("Failed to open zip: {}", e))?;
        let mut archive = zip::ZipArchive::new(zip_file)
            .map_err(|e| format!("Invalid zip file: {}", e))?;

        let parsed_manifest: CfManifest = {
            let mut manifest_file = archive.by_name("manifest.json")
                .map_err(|_| "No manifest.json found in zip. Is this a CurseForge export?".to_string())?;
            let mut content = String::new();
            std::io::Read::read_to_string(&mut manifest_file, &mut content)
                .map_err(|e| format!("Read manifest: {}", e))?;
            serde_json::from_str(&content)
                .map_err(|e| format!("Parse manifest.json: {}", e))?
        };

        let mut found_icon = None;
        for candidate in &[
            "icon.png", "pack.png", "logo.png", "icon.webp",
            "overrides/icon.png", "overrides/pack.png", "overrides/logo.png",
            "client-overrides/icon.png", "client-overrides/pack.png",
        ] {
            if let Ok(mut entry) = archive.by_name(candidate) {
                let mut buf = Vec::new();
                if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() && !buf.is_empty() {
                    let ext = if candidate.ends_with(".webp") { "webp" } else { "png" };
                    found_icon = Some((buf, ext.to_string()));
                    break;
                }
            }
        }

        (parsed_manifest, found_icon)
    };

    let embedded_icon_path = if let Some((ref buf, ref ext)) = embedded_icon_bytes {
        crate::services::icon_cache::cache_icon_bytes(buf, ext).await
    } else {
        None
    };

    // 2. If project icon or source project ID is missing, search CurseForge API for matching modpack
    if (project_icon.is_none() || source_project_id.is_none()) && !api_key.is_empty() && !manifest.name.is_empty() {
        if let Ok(res) = crate::services::curseforge::search(
            api_key,
            &manifest.name,
            "",
            "",
            0,
            5,
            "relevance",
            "modpack",
        ).await {
            let target = manifest.name.trim().to_lowercase();
            let matched = res.hits.iter().find(|h| {
                h.title.trim().to_lowercase() == target
            }).or_else(|| res.hits.first());

            if let Some(hit) = matched {
                if source_project_id.is_none() {
                    source_project_id = Some(hit.project_id.clone());
                }
                if project_icon.is_none() {
                    if let Some(ref icon_url) = hit.icon_url {
                        project_icon = crate::services::icon_cache::cache_remote_icon(icon_url).await;
                    }
                }
            }
        }
    }

    // Parse loader info
    let (loader_type, loader_version) = parse_loader(&manifest.minecraft.mod_loaders);

    // Resolve a non-conflicting display name. Reuses the Modrinth dedup helper
    // so importing the same CurseForge modpack twice yields "Name (2)", "(3)",
    // etc. instead of two identically-named instances.
    let instance_name = crate::services::modpack::unique_instance_name(&manifest.name)?;

    // Create the instance
    let instance_id = uuid::Uuid::new_v4().to_string();
    let instance_dir = paths::instances_dir().join(&instance_id);
    let final_icon = crate::services::icon_cache::persist_instance_icon(
        project_icon.or(embedded_icon_path),
        &instance_dir,
    );
    let minecraft_dir = instance_dir.join(".minecraft");
    let mods_dir = minecraft_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    let loader_str = match loader_type {
        LoaderType::Fabric => "fabric",
        LoaderType::Forge => "forge",
        LoaderType::Neoforge => "neoforge",
        LoaderType::Quilt => "quilt",
        LoaderType::Vanilla => "vanilla",
    };

    // Resolve and prepare mod download tasks (no actual downloading yet — that
    // happens inside `prepare_with_extras` so the progress bar is unified).
    // `blocked` are files whose authors opted out of third-party distribution on CurseForge
    // and could not be cross-resolved via Modrinth.
    let (mod_tasks, mod_entries, blocked) =
        build_mod_tasks(&manifest.files, &mods_dir, api_key, &manifest.minecraft.version, loader_str).await?;

    let source_platforms = vec!["curseforge".to_string()];

    // Build instance metadata
    let instance = Instance {
        format_version: 1,
        id: instance_id.clone(),
        name: instance_name,
        icon: final_icon,
        icon_custom: None,
        game_version: manifest.minecraft.version.clone(),
        loader: LoaderConfig {
            loader_type,
            version: loader_version,
        },
        java: JavaConfig {
            override_path: None,
            memory_max_mb: 4096,
            memory_min_mb: 512,
            extra_args: Vec::new(),
            adaptive_override: false,
        },
        window: WindowConfig {
            width: 1280,
            height: 720,
        },
        mods: mod_entries,
        last_played: None,
        total_play_seconds: 0,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_project_id,
        source_platforms,
        source_version: manifest.version.clone(),
        companion_enabled: crate::services::settings_service::load().await.unwrap_or_default().enable_companion_mod,
        companion_version: None,
    };

    // Save instance.json
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

    // Build the override-extraction post action
    let zip_path_owned = zip_path_buf.clone();
    let overrides_prefix = if manifest.overrides.is_empty() {
        "overrides".to_string()
    } else {
        manifest.overrides.clone()
    };
    let minecraft_dir_owned = minecraft_dir.clone();
    let post: PostAction = Box::new(move || {
        Box::pin(async move {
            extract_overrides_async(zip_path_owned, overrides_prefix, minecraft_dir_owned).await
        })
    });

    // Run the unified prepare flow: MC libs/assets/client + loader libs + Java + mods + overrides
    // On failure, delete the partially-created instance directory so no broken
    // instance shows up in the library.
    let window_for_revalidate = window.clone();
    let window_for_enrichment = window.clone();
    let window_for_blocked = window.clone();
    if let Err(e) = prepare_with_extras(&instance, mod_tasks, Some(post), window).await {
        tracing::error!("CurseForge import prepare failed, cleaning up instance {}: {}", instance_id, e);
        let _ = fs::remove_dir_all(&instance_dir);
        return Err(e);
    }

    // Reported after the install lands, so the dialog doesn't fight the progress
    // popup for attention and the "open mods folder" action points somewhere
    // that exists.
    report_blocked_files(&blocked, api_key, &instance_id, window_for_blocked.as_ref()).await;

    // Loader-version validation — bump the loader if any mod needs a newer
    // one than the manifest declared, then re-prepare loader libs.
    if let Err(e) = crate::services::modpack::revalidate_loader(&instance_id, window_for_revalidate).await {
        tracing::warn!("Loader revalidation failed for {} (non-fatal): {}", instance_id, e);
    }

    // Enrich mod metadata in the background so the install completes
    // immediately. Two-phase: metadata first (cards populate), icons
    // second (cards swap to local copies). The function emits
    // `instance-enriched` itself after each phase.
    let id_for_enrichment = instance_id.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::services::modpack::enrich_mod_metadata(&id_for_enrichment, window_for_enrichment).await {
            tracing::warn!("Metadata enrichment failed for {} (non-fatal): {}", id_for_enrichment, e);
        }
    });

    let final_instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .unwrap_or(instance);

    Ok(final_instance)
}

// === Helpers ===

/// Parse loader type and version from CurseForge mod loader IDs (e.g. "fabric-0.19.2", "forge-47.4.5")
fn parse_loader(loaders: &[CfModLoader]) -> (LoaderType, Option<String>) {
    let primary = loaders.iter().find(|l| l.primary).or(loaders.first());

    if let Some(loader) = primary {
        let id = &loader.id;
        if id.starts_with("fabric-") {
            let version = id.strip_prefix("fabric-").unwrap_or("").to_string();
            (LoaderType::Fabric, Some(version))
        } else if id.starts_with("quilt-") {
            let version = id.strip_prefix("quilt-").unwrap_or("").to_string();
            (LoaderType::Quilt, Some(version))
        } else if id.starts_with("neoforge-") {
            let version = id.strip_prefix("neoforge-").unwrap_or("").to_string();
            (LoaderType::Neoforge, Some(version))
        } else if id.starts_with("forge-") {
            let version = id.strip_prefix("forge-").unwrap_or("").to_string();
            (LoaderType::Forge, Some(version))
        } else {
            (LoaderType::Vanilla, None)
        }
    } else {
        (LoaderType::Vanilla, None)
    }
}

/// Build mod download tasks + ModEntry list using the CurseForge API to resolve URLs.
/// Returns (tasks, entries) — tasks are deferred to `prepare_with_extras` so the
/// progress bar covers game files + mods together.
/// One pack file CurseForge won't serve to us: `(project_id, file_name)`.
type BlockedFile = (String, String);

async fn build_mod_tasks(
    files: &[CfFile],
    mods_dir: &PathBuf,
    api_key: &str,
    game_version: &str,
    loader: &str,
) -> Result<
    (
        Vec<DownloadTask>,
        Vec<crate::models::instance::ModEntry>,
        Vec<BlockedFile>,
    ),
    String,
> {
    use crate::models::instance::ModEntry;

    if files.is_empty() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }

    // Batch resolve file info from CurseForge API
    let file_infos = resolve_files(files, api_key).await?;

    let mut tasks: Vec<DownloadTask> = Vec::new();
    let mut mod_entries: Vec<ModEntry> = Vec::new();
    let mut blocked: Vec<BlockedFile> = Vec::new();

    struct CandidateBlocked {
        project_id: String,
        file_name: String,
        sha1: Option<String>,
    }
    let mut candidate_blocked: Vec<CandidateBlocked> = Vec::new();

    for info in &file_infos {
        let project_id_of = |id: u64| {
            files
                .iter()
                .find(|f| f.file_id == id)
                .map(|f| f.project_id.to_string())
                .unwrap_or_default()
        };

        // `download_url: null` means the author opted out of third-party
        // distribution on CurseForge. We queue them for cross-source resolution
        // on Modrinth (where distribution is allowed) before giving up and prompting the user.
        let url = match &info.download_url {
            Some(u) => u.clone(),
            None => {
                let sha1 = info
                    .hashes
                    .iter()
                    .find(|h| h.algo == 1)
                    .map(|h| h.value.clone());
                candidate_blocked.push(CandidateBlocked {
                    project_id: project_id_of(info.id),
                    file_name: info.file_name.clone(),
                    sha1,
                });
                continue;
            }
        };

        let dest = mods_dir.join(&info.file_name);
        let sha1 = info
            .hashes
            .iter()
            .find(|h| h.algo == 1)
            .map(|h| h.value.clone());

        tasks.push(DownloadTask {
            url,
            dest: dest.clone(),
            expected_sha1: sha1,
            expected_size: Some(info.file_length),
        });

        let project_id = project_id_of(info.id);

        mod_entries.push(ModEntry {
            id: uuid::Uuid::new_v4().to_string(),
            source: "modpack".to_string(),
            project_id,
            version_id: info.id.to_string(),
            filename: info.file_name.clone(),
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
    }

    // Attempt cross-source resolution via Modrinth for CurseForge blocked files
    if !candidate_blocked.is_empty() {
        tracing::info!(
            "Attempting cross-source resolution on Modrinth for {} blocked CurseForge modpack files...",
            candidate_blocked.len()
        );

        let mut resolved_indices = std::collections::HashSet::new();

        // ── Tier 1: Bulk Cryptographic SHA-1 Match (100% bit-for-bit identical) ──
        let sha1_list: Vec<String> = candidate_blocked
            .iter()
            .filter_map(|c| c.sha1.clone())
            .collect();

        if !sha1_list.is_empty() {
            match crate::services::modrinth::get_versions_by_hashes(&sha1_list).await {
                Ok(hash_map) => {
                    for (idx, candidate) in candidate_blocked.iter().enumerate() {
                        if let Some(sha1) = &candidate.sha1 {
                            if let Some(version) = hash_map.get(sha1) {
                                let matched_file = version
                                    .files
                                    .iter()
                                    .find(|f| f.hashes.sha1.as_deref() == Some(sha1))
                                    .or_else(|| version.files.iter().find(|f| f.primary))
                                    .or_else(|| version.files.first());

                                if let Some(file) = matched_file {
                                    tracing::info!(
                                        "Cross-source resolved {} via Modrinth SHA-1 match (project: {}, version: {})",
                                        candidate.file_name,
                                        version.project_id,
                                        version.version_number
                                    );

                                    tasks.push(DownloadTask {
                                        url: file.url.clone(),
                                        dest: mods_dir.join(&file.filename),
                                        expected_sha1: Some(sha1.clone()),
                                        expected_size: Some(file.size),
                                    });

                                    mod_entries.push(ModEntry {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        source: "modrinth".to_string(),
                                        project_id: version.project_id.clone(),
                                        version_id: version.id.clone(),
                                        filename: file.filename.clone(),
                                        version_number: Some(version.version_number.clone()),
                                        enabled: true,
                                        pinned: false,
                                        title: None,
                                        icon_url: None,
                                        local_icon_path: None,
                                        description: None,
                                        category: "mod".to_string(),
                                        author: None,
                                        loaders: version.loaders.clone(),
                                        game_versions: version.game_versions.clone(),
                                    });

                                    resolved_indices.insert(idx);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Modrinth hash lookup failed during cross-source resolution: {}", e);
                }
            }
        }

        // ── Tier 2: Metadata / Search Fallback for Remaining Unresolved ──
        let unresolved_cf_ids: Vec<String> = candidate_blocked
            .iter()
            .enumerate()
            .filter(|(idx, _)| !resolved_indices.contains(idx))
            .map(|(_, c)| c.project_id.clone())
            .collect();

        let cf_briefs = if !api_key.is_empty() && !unresolved_cf_ids.is_empty() {
            crate::services::curseforge::fetch_projects_brief(api_key, &unresolved_cf_ids).await
        } else {
            std::collections::HashMap::new()
        };

        for (idx, candidate) in candidate_blocked.iter().enumerate() {
            if resolved_indices.contains(&idx) {
                continue;
            }

            // Prefer project name from CurseForge metadata; fall back to filename prefix
            let project_title = cf_briefs
                .get(&candidate.project_id)
                .and_then(|(name, _)| name.as_deref());

            let clean_query = project_title.unwrap_or_else(|| {
                candidate
                    .file_name
                    .trim_end_matches(".jar")
                    .split(&['-', '_', '+'][..])
                    .next()
                    .unwrap_or(&candidate.file_name)
            });

            if !clean_query.is_empty() && !game_version.is_empty() {
                if let Ok(search_res) = crate::services::modrinth::search_mods(
                    clean_query,
                    loader,
                    game_version,
                    0,
                    5,
                    "relevance",
                    "mod",
                )
                .await
                {
                    let mut matched = false;
                    for hit in search_res.hits {
                        if let Ok(versions) = crate::services::modrinth::get_project_versions(
                            &hit.project_id,
                            loader,
                            game_version,
                        )
                        .await
                        {
                            for v in versions {
                                let hit_file = v.files.iter().find(|f| {
                                    f.filename.eq_ignore_ascii_case(&candidate.file_name)
                                });

                                if let Some(file) = hit_file {
                                    tracing::info!(
                                        "Cross-source resolved {} via Modrinth metadata search (project: {}, version: {})",
                                        candidate.file_name,
                                        hit.project_id,
                                        v.version_number
                                    );

                                    tasks.push(DownloadTask {
                                        url: file.url.clone(),
                                        dest: mods_dir.join(&file.filename),
                                        expected_sha1: file.hashes.sha1.clone(),
                                        expected_size: Some(file.size),
                                    });

                                    mod_entries.push(ModEntry {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        source: "modrinth".to_string(),
                                        project_id: hit.project_id.clone(),
                                        version_id: v.id.clone(),
                                        filename: file.filename.clone(),
                                        version_number: Some(v.version_number.clone()),
                                        enabled: true,
                                        pinned: false,
                                        title: Some(hit.title.clone()),
                                        icon_url: hit.icon_url.clone(),
                                        local_icon_path: None,
                                        description: Some(hit.description.clone()),
                                        category: "mod".to_string(),
                                        author: hit.author.clone(),
                                        loaders: v.loaders.clone(),
                                        game_versions: v.game_versions.clone(),
                                    });

                                    resolved_indices.insert(idx);
                                    matched = true;
                                    break;
                                }
                            }
                        }
                        if matched {
                            break;
                        }
                    }
                }
            }
        }

        // Remaining unresolved files must be reported as blocked
        for (idx, candidate) in candidate_blocked.into_iter().enumerate() {
            if !resolved_indices.contains(&idx) {
                blocked.push((candidate.project_id, candidate.file_name));
            }
        }
    }

    Ok((tasks, mod_entries, blocked))
}

/// Raise the manual-download dialog for every pack file CurseForge wouldn't
/// serve, resolving their names and project pages in one batched request.
async fn report_blocked_files(
    blocked: &[BlockedFile],
    api_key: &str,
    instance_id: &str,
    window: Option<&tauri::WebviewWindow>,
) {
    if blocked.is_empty() {
        return;
    }
    let ids: Vec<String> = blocked.iter().map(|(id, _)| id.clone()).collect();
    let briefs = crate::services::curseforge::fetch_projects_brief(api_key, &ids).await;
    for (project_id, file_name) in blocked {
        let (name, website) = briefs.get(project_id).cloned().unwrap_or((None, None));
        crate::services::manual_download::notify(
            window,
            crate::services::manual_download::ManualDownload {
                kind: "mod".to_string(),
                title: name.unwrap_or_else(|| format!("CurseForge project {}", project_id)),
                file_name: Some(file_name.clone()),
                url: website,
                instance_id: Some(instance_id.to_string()),
            },
        );
    }
}

/// Resolve file download URLs from CurseForge API (batch endpoint).
async fn resolve_files(files: &[CfFile], api_key: &str) -> Result<Vec<CfFileInfo>, String> {
    if api_key.is_empty() {
        return resolve_files_without_api(files).await;
    }

    // Use the batch files endpoint, chunked in batches of 200 to prevent
    // oversized payloads or timeouts on very large modpacks.
    let file_ids: Vec<u64> = files.iter().map(|f| f.file_id).collect();
    let mut all_infos: Vec<CfFileInfo> = Vec::with_capacity(file_ids.len());

    for chunk in file_ids.chunks(200) {
        let resp = crate::util::http::HTTP
            .post(format!("{}/mods/files", CF_API_BASE))
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&serde_json::json!({ "fileIds": chunk }))
            .send()
            .await
            .map_err(|e| format!("CurseForge files API failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("CurseForge files API error ({}): {}", status, text));
        }

        let body: CfApiResponse<Vec<CfFileInfo>> = resp.json().await
            .map_err(|e| format!("Parse files response: {}", e))?;
        all_infos.extend(body.data);
    }

    Ok(all_infos)
}

/// Without an API key there's no way to resolve a file id to its name or URL, so
/// there's nothing to fall back to. Kept as a named function so the reason is
/// stated once rather than inlined as a bare error.
async fn resolve_files_without_api(_files: &[CfFile]) -> Result<Vec<CfFileInfo>, String> {
    Err("CurseForge API key is required to download mods. Set it in Settings.".to_string())
}

/// Extract override files from the zip into the .minecraft directory.
/// Runs as a post-download action so overrides land on top of mod files.
async fn extract_overrides_async(
    zip_path: PathBuf,
    overrides_prefix: String,
    minecraft_dir: PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let zip_file = fs::File::open(&zip_path)
            .map_err(|e| format!("Reopen zip: {}", e))?;
        let buf_file = std::io::BufReader::with_capacity(256 * 1024, zip_file);
        let mut archive = zip::ZipArchive::new(buf_file)
            .map_err(|e| format!("Reread zip: {}", e))?;
        let prefix = format!("{}/", overrides_prefix);
        let mut created_dirs = std::collections::HashSet::new();
        created_dirs.insert(minecraft_dir.clone());

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry: {}", e))?;
            let name = entry.name().to_string();

            if !name.starts_with(&prefix) || name == prefix {
                continue;
            }

            // Strip the overrides/ prefix to get the relative path
            let relative = &name[prefix.len()..];
            if relative.contains("..") {
                continue;
            }
            let dest = minecraft_dir.join(relative);

            if entry.is_dir() {
                if created_dirs.insert(dest.clone()) {
                    let _ = fs::create_dir_all(&dest);
                }
            } else {
                if let Some(parent) = dest.parent() {
                    if created_dirs.insert(parent.to_path_buf()) {
                        let _ = fs::create_dir_all(parent);
                    }
                }
                let mut outfile = fs::File::create(&dest)
                    .map_err(|e| format!("Create override file: {}", e))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("Extract override: {}", e))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Override extraction task panicked: {}", e))?
}
