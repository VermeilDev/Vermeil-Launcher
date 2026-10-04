// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::instance::*;
use crate::services::mod_install::{self, ProjectType, find_preferred_version};
use crate::services::{cf_mod_install, curseforge, modrinth};
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use tauri::Emitter;
use uuid::Uuid;

pub async fn list_all() -> Result<Vec<Instance>, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();

    if !instances_dir.exists() {
        fs::create_dir_all(&instances_dir)?;
        return Ok(Vec::new());
    }

    let mut instances = Vec::new();

    for entry in fs::read_dir(&instances_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            let meta_path = path.join("instance.json");
            if meta_path.exists() {
                let content = fs::read_to_string(&meta_path)?;
                if let Ok(mut instance) = serde_json::from_str::<Instance>(&content) {
                    sanitize_instance_json(&mut instance, &meta_path);
                    instances.push(instance);
                }
            }
        }
    }

    // Sort by last_played (most recent first)
    instances.sort_by(|a, b| {
        b.last_played.cmp(&a.last_played)
    });

    Ok(instances)
}

/// Sanitize any legacy bloated base64 data URLs in `instance.mods` or `instance.icon`,
/// and ensure instance icons are stored durably within the instance's own directory
/// instead of referencing volatile purgeable cache directories.
fn sanitize_instance_json(instance: &mut Instance, meta_path: &std::path::Path) {
    let mut modified = false;
    let instance_dir = meta_path.parent().unwrap_or(meta_path);

    let mods_dir = instance_dir.join(".minecraft").join("mods");
    for m in &mut instance.mods {
        if let Some(ref path) = m.local_icon_path {
            if path.starts_with("data:")
                || (!path.starts_with("http://")
                    && !path.starts_with("https://")
                    && !path.starts_with("asset:")
                    && !std::path::Path::new(path).exists())
            {
                m.local_icon_path = None;
                modified = true;
            }
        }

        if m.category == "mod" {
            let current_path = mods_dir.join(&m.filename);
            if m.loaders.is_empty() && current_path.exists() {
                let detected = crate::services::loader_scan::detect_jar_loaders(&current_path);
                if !detected.is_empty() {
                    m.loaders = detected;
                    modified = true;
                }
            }

            if m.enabled
                && !crate::services::loader_scan::is_mod_compatible_with_loader(
                    &instance.loader.loader_type,
                    &m.loaders,
                )
            {
                let new_name = if m.filename.ends_with(".disabled") {
                    m.filename.clone()
                } else {
                    format!("{}.disabled", m.filename)
                };
                let new_path = mods_dir.join(&new_name);
                if current_path.exists() && current_path != new_path {
                    let _ = fs::rename(&current_path, &new_path);
                }
                m.filename = new_name;
                m.enabled = false;
                modified = true;
                tracing::warn!(
                    "Auto-disabled incompatible mod '{}' for loader {:?}",
                    m.title.as_deref().unwrap_or(&m.filename),
                    instance.loader.loader_type
                );
            }
        }
    }

    if instance.icon.starts_with("data:") {
        if let Some((_header, b64)) = instance.icon.split_once(',') {
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                let icon_dest = instance_dir.join("icon.png");
                if fs::write(&icon_dest, &bytes).is_ok() {
                    instance.icon = crate::services::icon_cache::clean_path_string(&icon_dest);
                    modified = true;
                }
            }
        }
    } else if instance.icon != "cube"
        && !instance.icon.starts_with("http://")
        && !instance.icon.starts_with("https://")
        && !instance.icon.starts_with("asset:")
    {
        let current_path = std::path::Path::new(&instance.icon);
        if current_path.exists() {
            // If the icon exists on disk but is outside the instance directory (e.g. in cache/icons/),
            // migrate it durably into the instance directory so cache purges cannot destroy it.
            if !current_path.starts_with(instance_dir) {
                let ext = current_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("png")
                    .to_lowercase();
                let dest = instance_dir.join(format!("icon.{}", ext));
                if std::fs::copy(current_path, &dest).is_ok() {
                    instance.icon = crate::services::icon_cache::clean_path_string(&dest);
                    modified = true;
                    tracing::info!("Migrated instance icon to durable directory for {}", instance.name);
                }
            }
        } else {
            // File does NOT exist on disk — check if an icon exists in instance_dir
            let mut healed = false;
            for ext in ["png", "webp", "jpg", "jpeg"] {
                let candidate = instance_dir.join(format!("icon.{}", ext));
                if candidate.exists() {
                    instance.icon = crate::services::icon_cache::clean_path_string(&candidate);
                    modified = true;
                    healed = true;
                    tracing::info!("Healed instance icon from instance directory for {}", instance.name);
                    break;
                }
            }
            if !healed {
                // Ghost path — fall back to "cube" sentinel so Tauri doesn't log 404s
                instance.icon = "cube".to_string();
                modified = true;
                tracing::warn!("Ghost icon path missing on disk for {}; falling back to cube", instance.name);
            }
        }
    }

    if modified {
        if let Ok(serialized) = serde_json::to_string_pretty(instance) {
            let _ = fs::write(meta_path, serialized);
            tracing::info!("Sanitized and saved instance.json for {}", instance.name);
        }
    }
}

pub async fn create(config: CreateInstanceConfig) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let id = Uuid::new_v4().to_string();
    let instances_dir = paths::instances_dir();
    let instance_dir = instances_dir.join(&id);

    // Create instance directory structure
    fs::create_dir_all(instance_dir.join(".minecraft").join("mods"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("config"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("saves"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("resourcepacks"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("logs"))?;

    let now = chrono::Utc::now().to_rfc3339();
    let icon = crate::services::icon_cache::persist_instance_icon(config.icon, &instance_dir);
    let settings = crate::services::settings_service::load().await.unwrap_or_default();

    let instance = Instance {
        format_version: 1,
        id: id.clone(),
        name: config.name,
        icon,
        icon_custom: None,
        created_at: now,
        last_played: None,
        total_play_seconds: 0,
        game_version: config.game_version,
        loader: LoaderConfig {
            loader_type: config.loader_type,
            version: config.loader_version,
        },
        java: JavaConfig {
            memory_max_mb: config.memory_max_mb.unwrap_or(4096),
            ..Default::default()
        },
        window: WindowConfig::default(),
        mods: Vec::new(),
        source_project_id: None,
        source_platforms: Vec::new(),
        source_version: None,
        companion_enabled: settings.enable_companion_mod,
        companion_version: None,
    };

    // Write instance.json
    let json = serde_json::to_string_pretty(&instance)?;
    fs::write(instance_dir.join("instance.json"), json)?;

    Ok(instance)
}

pub async fn get_by_id(id: &str) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();
    let meta_path = instances_dir.join(id).join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance '{}' not found", id).into());
    }

    let content = fs::read_to_string(&meta_path)?;
    let mut instance: Instance = serde_json::from_str(&content)?;
    sanitize_instance_json(&mut instance, &meta_path);
    Ok(instance)
}

/// Duplicate an existing instance, copying every file under its `.minecraft/`
/// directory (mods, configs, worlds, resource packs, shader packs, etc.)
/// to a new instance with a fresh UUID and a unique name.
///
/// `last_played` and `total_play_seconds` reset on the clone — the user is
/// effectively starting fresh with the same setup. `mods` array is copied
/// as-is so the Installed-tab view shows the same content immediately.
pub async fn clone_instance(
    source_id: &str,
    new_name: Option<String>,
) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let source = get_by_id(source_id).await?;
    let instances_dir = paths::instances_dir();
    let source_dir = instances_dir.join(source_id);
    if !source_dir.exists() {
        return Err(format!("Source instance dir missing: {}", source_dir.display()).into());
    }

    let new_id = Uuid::new_v4().to_string();
    let new_dir = instances_dir.join(&new_id);

    // Resolve a unique display name. Default to "<original> (copy)"; on
    // collision append " 2", " 3", etc. until we land on something free.
    let base_name = new_name.unwrap_or_else(|| format!("{} (copy)", source.name));
    let final_name = unique_instance_name(&base_name)?;

    // Recursive copy of the source instance directory. We copy the entire
    // tree (including .minecraft/) so worlds, configs, and any custom files
    // come along — Minecraft launchers without this feature force users to
    // manually shovel folders, which always loses something.
    crate::util::paths::copy_dir_all(&source_dir, &new_dir)?;

    // Rewrite instance.json with the new id, name, and reset play stats.
    let mut cloned = source.clone();
    cloned.id = new_id.clone();
    cloned.name = final_name;
    cloned.created_at = chrono::Utc::now().to_rfc3339();
    cloned.last_played = None;
    cloned.total_play_seconds = 0;
    if let Ok(rel) = std::path::Path::new(&cloned.icon).strip_prefix(&source_dir) {
        cloned.icon = crate::services::icon_cache::clean_path_string(&new_dir.join(rel));
    }

    let json = serde_json::to_string_pretty(&cloned)?;
    fs::write(new_dir.join("instance.json"), json)?;

    Ok(cloned)
}

/// Resolve a non-conflicting display name. Appends " 2", " 3", etc. until a
/// free slot is found.
fn unique_instance_name(base: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();
    if !instances_dir.exists() {
        return Ok(base.to_string());
    }

    let existing: Vec<String> = fs::read_dir(&instances_dir)?
        .flatten()
        .filter_map(|entry| {
            let meta = entry.path().join("instance.json");
            if !meta.exists() {
                return None;
            }
            let content = fs::read_to_string(&meta).ok()?;
            let inst: Instance = serde_json::from_str(&content).ok()?;
            Some(inst.name)
        })
        .collect();

    if !existing.iter().any(|n| n == base) {
        return Ok(base.to_string());
    }

    let mut n: u32 = 2;
    loop {
        let candidate = format!("{} {}", base, n);
        if !existing.iter().any(|x| x == &candidate) {
            return Ok(candidate);
        }
        n += 1;
    }
}


/// Result of changing an instance's loader, including mod conversion statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderChangeResult {
    pub instance: Instance,
    pub converted_count: usize,
    pub disabled_count: usize,
    pub converted_titles: Vec<String>,
    pub disabled_titles: Vec<String>,
}

/// Progress event emitted during mod auto-conversion.
#[derive(Debug, Clone, Serialize)]
pub struct ModConversionProgress {
    pub current: usize,
    pub total: usize,
    pub mod_title: String,
    pub status: String,
}

fn emit_progress(
    app: Option<&tauri::AppHandle>,
    current: usize,
    total: usize,
    mod_title: &str,
    status: &str,
) {
    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "mod-conversion-progress",
            ModConversionProgress {
                current,
                total,
                mod_title: mod_title.to_string(),
                status: status.to_string(),
            },
        );
    }
}

async fn resolve_cf_key() -> String {
    crate::commands::mods::resolve_cf_api_key()
        .await
        .unwrap_or_else(|_| crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string())
}

fn disable_single_mod_on_disk_and_meta(
    meta_path: &std::path::Path,
    mods_dir: &std::path::Path,
    entry_id: &str,
    project_id: &str,
) {
    let Ok(content) = fs::read_to_string(meta_path) else { return; };
    let Ok(mut inst) = serde_json::from_str::<Instance>(&content) else { return; };
    let mut modified = false;

    for m in &mut inst.mods {
        if m.id == entry_id || (!project_id.is_empty() && m.project_id == project_id) {
            let current_path = mods_dir.join(&m.filename);
            if m.loaders.is_empty() && current_path.exists() {
                let detected = crate::services::loader_scan::detect_jar_loaders(&current_path);
                if !detected.is_empty() {
                    m.loaders = detected;
                }
            }
            let new_name = if m.filename.ends_with(".disabled") {
                m.filename.clone()
            } else {
                format!("{}.disabled", m.filename)
            };
            let new_path = mods_dir.join(&new_name);
            if current_path.exists() && current_path != new_path {
                let _ = fs::rename(&current_path, &new_path);
            }
            m.filename = new_name;
            m.enabled = false;
            modified = true;
            break;
        }
    }

    if modified {
        if let Ok(json) = serde_json::to_string_pretty(&inst) {
            let _ = paths::atomic_write(meta_path, json.as_bytes());
        }
    }
}

fn enable_single_mod_on_disk_and_meta(
    meta_path: &std::path::Path,
    mods_dir: &std::path::Path,
    entry_id: &str,
    project_id: &str,
) {
    let Ok(content) = fs::read_to_string(meta_path) else { return; };
    let Ok(mut inst) = serde_json::from_str::<Instance>(&content) else { return; };
    let mut modified = false;

    for m in &mut inst.mods {
        if m.id == entry_id || (!project_id.is_empty() && m.project_id == project_id) {
            let current_path = mods_dir.join(&m.filename);
            if m.loaders.is_empty() && current_path.exists() {
                let detected = crate::services::loader_scan::detect_jar_loaders(&current_path);
                if !detected.is_empty() {
                    m.loaders = detected;
                }
            }
            let active_name = if m.filename.ends_with(".disabled") {
                m.filename.strip_suffix(".disabled").unwrap_or(&m.filename).to_string()
            } else {
                m.filename.clone()
            };
            let active_path = mods_dir.join(&active_name);
            if current_path.exists() && current_path != active_path {
                let _ = fs::rename(&current_path, &active_path);
            }
            m.filename = active_name;
            m.enabled = true;
            modified = true;
            break;
        }
    }

    if modified {
        if let Ok(json) = serde_json::to_string_pretty(&inst) {
            let _ = paths::atomic_write(meta_path, json.as_bytes());
        }
    }
}

fn disable_loose_jars(mods_dir: &std::path::Path, active_filenames: &HashSet<String>) {
    if let Ok(dir_entries) = fs::read_dir(mods_dir) {
        for dir_entry in dir_entries.flatten() {
            let p = dir_entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension() {
                    if ext == "jar" {
                        let file_name_lossy = p.file_name().unwrap_or_default().to_string_lossy();
                        if !file_name_lossy.starts_with("vermeil-")
                            && !active_filenames.contains(file_name_lossy.as_ref())
                        {
                            let new_path = mods_dir.join(format!("{}.disabled", file_name_lossy));
                            let _ = fs::rename(&p, &new_path);
                        }
                    }
                }
            }
        }
    }
}

/// Change an instance's mod loader and/or loader version.
///
/// If `convert_mods` is true, queries Modrinth and CurseForge for compatible builds of installed
/// mods matching the newly selected loader for the instance's Minecraft version. Compatible builds
/// are downloaded and replaced in place; mods without a compatible build are disabled (`.disabled`).
/// If `disable_mods` is true (and `convert_mods` is false), all active mod entries are disabled.
pub async fn change_loader(
    app: Option<&tauri::AppHandle>,
    id: &str,
    loader_type: LoaderType,
    loader_version: Option<String>,
    disable_mods: bool,
    convert_mods: bool,
) -> Result<LoaderChangeResult, Box<dyn std::error::Error + Send + Sync>> {
    let instance_dir = paths::instances_dir().join(id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance '{}' not found", id).into());
    }

    let content = fs::read_to_string(&meta_path)?;
    let mut instance: Instance = serde_json::from_str(&content)?;

    // Validate loader version
    let cleaned_version = match loader_type {
        LoaderType::Vanilla => None,
        _ => {
            let ver = loader_version.as_deref().map(str::trim).filter(|s| !s.is_empty());
            match ver {
                Some(v) => Some(v.to_string()),
                None => {
                    return Err(format!(
                        "A valid loader version is required when switching to {}",
                        loader_type.as_str()
                    )
                    .into());
                }
            }
        }
    };

    let previous_loader = instance.loader.loader_type;
    let loader_changed = previous_loader != loader_type;

    // Update loader config immediately
    instance.loader.loader_type = loader_type;
    instance.loader.version = cleaned_version;

    let json = serde_json::to_string_pretty(&instance)?;
    paths::atomic_write(&meta_path, json.as_bytes())?;

    let mut converted_count = 0;
    let mut disabled_count = 0;
    let mut converted_titles = Vec::new();
    let mut disabled_titles = Vec::new();

    let mods_dir = instance_dir.join(".minecraft").join("mods");

    if loader_type == LoaderType::Vanilla {
        // Vanilla cannot load mods
        if disable_mods && mods_dir.exists() {
            for entry in &mut instance.mods {
                if entry.category == "mod" && entry.enabled {
                    let title = entry.title.clone().unwrap_or_else(|| entry.filename.clone());
                    let current_path = mods_dir.join(&entry.filename);
                    let new_name = if entry.filename.ends_with(".disabled") {
                        entry.filename.clone()
                    } else {
                        format!("{}.disabled", entry.filename)
                    };
                    let new_path = mods_dir.join(&new_name);
                    if current_path.exists() && current_path != new_path {
                        let _ = fs::rename(&current_path, &new_path);
                    }
                    entry.filename = new_name;
                    entry.enabled = false;
                    disabled_count += 1;
                    disabled_titles.push(title);
                }
            }
            let active_filenames: HashSet<String> = instance
                .mods
                .iter()
                .filter(|m| m.enabled)
                .map(|m| m.filename.clone())
                .collect();
            disable_loose_jars(&mods_dir, &active_filenames);

            let json = serde_json::to_string_pretty(&instance)?;
            paths::atomic_write(&meta_path, json.as_bytes())?;
        }
    } else if loader_changed && convert_mods {
        // Auto-convert compatible mods for the new loader
        let mod_candidates: Vec<ModEntry> = instance
            .mods
            .iter()
            .filter(|m| m.category == "mod" && m.enabled)
            .cloned()
            .collect();

        let total = mod_candidates.len();

        for (idx, entry) in mod_candidates.iter().enumerate() {
            let title = entry.title.clone().unwrap_or_else(|| {
                entry
                    .filename
                    .strip_suffix(".jar")
                    .or_else(|| entry.filename.strip_suffix(".jar.disabled"))
                    .unwrap_or(&entry.filename)
                    .to_string()
            });

            emit_progress(app, idx + 1, total, &title, "Checking...");

            if entry.source == "modrinth" && !entry.project_id.is_empty() {
                let versions_res = modrinth::get_project_versions(
                    &entry.project_id,
                    loader_type.as_str(),
                    &instance.game_version,
                )
                .await;

                match versions_res {
                    Ok(versions) => {
                        let preferred = find_preferred_version(
                            &versions,
                            ProjectType::Mod,
                            loader_type.as_str(),
                            &instance.game_version,
                        );

                        if let Some(ver) = preferred {
                            if ver.id == entry.version_id {
                                // Existing jar already supports this target loader
                                enable_single_mod_on_disk_and_meta(&meta_path, &mods_dir, &entry.id, &entry.project_id);
                                converted_count += 1;
                                converted_titles.push(title.clone());
                                emit_progress(app, idx + 1, total, &title, "Compatible");
                            } else {
                                emit_progress(app, idx + 1, total, &title, "Downloading...");
                                match mod_install::install_mod(
                                    id,
                                    &entry.project_id,
                                    loader_type.as_str(),
                                    &instance.game_version,
                                    "mod",
                                    Some(ver.id.clone()),
                                )
                                .await
                                {
                                    Ok(_) => {
                                        converted_count += 1;
                                        converted_titles.push(title.clone());
                                        emit_progress(app, idx + 1, total, &title, "Converted");
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            "Failed to install converted Modrinth mod {}: {}",
                                            entry.project_id,
                                            e
                                        );
                                        disable_single_mod_on_disk_and_meta(
                                            &meta_path,
                                            &mods_dir,
                                            &entry.id,
                                            &entry.project_id,
                                        );
                                        disabled_count += 1;
                                        disabled_titles.push(title.clone());
                                        emit_progress(app, idx + 1, total, &title, "Failed (disabled)");
                                    }
                                }
                            }
                        } else {
                            // No compatible build for target loader
                            disable_single_mod_on_disk_and_meta(
                                &meta_path,
                                &mods_dir,
                                &entry.id,
                                &entry.project_id,
                            );
                            disabled_count += 1;
                            disabled_titles.push(title.clone());
                            emit_progress(app, idx + 1, total, &title, "No build (disabled)");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to fetch Modrinth versions for {}: {}",
                            entry.project_id,
                            e
                        );
                        disable_single_mod_on_disk_and_meta(
                            &meta_path,
                            &mods_dir,
                            &entry.id,
                            &entry.project_id,
                        );
                        disabled_count += 1;
                        disabled_titles.push(title.clone());
                        emit_progress(app, idx + 1, total, &title, "Lookup failed (disabled)");
                    }
                }
            } else if entry.source == "curseforge" && !entry.project_id.is_empty() {
                let api_key = resolve_cf_key().await;
                let files_res = curseforge::get_project_files(
                    &api_key,
                    &entry.project_id,
                    &instance.game_version,
                    loader_type.as_str(),
                )
                .await;

                match files_res {
                    Ok(files) => {
                        let preferred = cf_mod_install::find_preferred_file(
                            &files,
                            &instance.game_version,
                            loader_type.as_str(),
                        );

                        if let Some(file) = preferred {
                            if file.file_id.to_string() == entry.version_id {
                                enable_single_mod_on_disk_and_meta(&meta_path, &mods_dir, &entry.id, &entry.project_id);
                                converted_count += 1;
                                converted_titles.push(title.clone());
                                emit_progress(app, idx + 1, total, &title, "Compatible");
                            } else {
                                emit_progress(app, idx + 1, total, &title, "Downloading...");
                                match cf_mod_install::install_cf_mod(
                                    id,
                                    &entry.project_id,
                                    loader_type.as_str(),
                                    &instance.game_version,
                                    "mod",
                                    &api_key,
                                    Some(file.file_id.to_string()),
                                    None,
                                )
                                .await
                                {
                                    Ok(_) => {
                                        converted_count += 1;
                                        converted_titles.push(title.clone());
                                        emit_progress(app, idx + 1, total, &title, "Converted");
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            "Failed to install converted CurseForge mod {}: {}",
                                            entry.project_id,
                                            e
                                        );
                                        disable_single_mod_on_disk_and_meta(
                                            &meta_path,
                                            &mods_dir,
                                            &entry.id,
                                            &entry.project_id,
                                        );
                                        disabled_count += 1;
                                        disabled_titles.push(title.clone());
                                        emit_progress(app, idx + 1, total, &title, "Failed (disabled)");
                                    }
                                }
                            }
                        } else {
                            disable_single_mod_on_disk_and_meta(
                                &meta_path,
                                &mods_dir,
                                &entry.id,
                                &entry.project_id,
                            );
                            disabled_count += 1;
                            disabled_titles.push(title.clone());
                            emit_progress(app, idx + 1, total, &title, "No build (disabled)");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to fetch CurseForge files for {}: {}",
                            entry.project_id,
                            e
                        );
                        disable_single_mod_on_disk_and_meta(
                            &meta_path,
                            &mods_dir,
                            &entry.id,
                            &entry.project_id,
                        );
                        disabled_count += 1;
                        disabled_titles.push(title.clone());
                        emit_progress(app, idx + 1, total, &title, "Lookup failed (disabled)");
                    }
                }
            } else {
                // Untracked or local mod without online project ID
                let jar_path = mods_dir.join(&entry.filename);
                let detected = if entry.loaders.is_empty() && jar_path.exists() {
                    crate::services::loader_scan::detect_jar_loaders(&jar_path)
                } else {
                    entry.loaders.clone()
                };
                if !detected.is_empty()
                    && crate::services::loader_scan::is_mod_compatible_with_loader(
                        &loader_type,
                        &detected,
                    )
                {
                    enable_single_mod_on_disk_and_meta(
                        &meta_path,
                        &mods_dir,
                        &entry.id,
                        &entry.project_id,
                    );
                    converted_count += 1;
                    converted_titles.push(title.clone());
                    emit_progress(app, idx + 1, total, &title, "Compatible");
                } else {
                    disable_single_mod_on_disk_and_meta(
                        &meta_path,
                        &mods_dir,
                        &entry.id,
                        &entry.project_id,
                    );
                    disabled_count += 1;
                    disabled_titles.push(title.clone());
                    emit_progress(app, idx + 1, total, &title, "Incompatible source (disabled)");
                }
            }
        }
    } else if loader_changed && disable_mods {
        // Standard disable without conversion
        if mods_dir.exists() {
            for entry in &mut instance.mods {
                if entry.category == "mod" && entry.enabled {
                    let title = entry.title.clone().unwrap_or_else(|| entry.filename.clone());
                    let current_path = mods_dir.join(&entry.filename);
                    let new_name = if entry.filename.ends_with(".disabled") {
                        entry.filename.clone()
                    } else {
                        format!("{}.disabled", entry.filename)
                    };
                    let new_path = mods_dir.join(&new_name);
                    if current_path.exists() && current_path != new_path {
                        let _ = fs::rename(&current_path, &new_path);
                    }
                    entry.filename = new_name;
                    entry.enabled = false;
                    disabled_count += 1;
                    disabled_titles.push(title);
                }
            }
            let active_filenames: HashSet<String> = instance
                .mods
                .iter()
                .filter(|m| m.enabled)
                .map(|m| m.filename.clone())
                .collect();
            disable_loose_jars(&mods_dir, &active_filenames);

            let json = serde_json::to_string_pretty(&instance)?;
            paths::atomic_write(&meta_path, json.as_bytes())?;
        }
    }

    // Re-read final instance.json and sanitize
    let final_content = fs::read_to_string(&meta_path)?;
    let mut final_instance: Instance = serde_json::from_str(&final_content)?;
    sanitize_instance_json(&mut final_instance, &meta_path);

    if mods_dir.exists() {
        let active_filenames: HashSet<String> = final_instance
            .mods
            .iter()
            .filter(|m| m.enabled)
            .map(|m| m.filename.clone())
            .collect();
        disable_loose_jars(&mods_dir, &active_filenames);
    }

    // Synchronize Vermeil companion mod build with the newly selected loader/version
    let _ = crate::services::companion_mod::ensure_installed(&final_instance).await;

    Ok(LoaderChangeResult {
        instance: final_instance,
        converted_count,
        disabled_count,
        converted_titles,
        disabled_titles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loader_change_result_serde() {
        let instance_json = r#"{
            "format_version": 1,
            "id": "test-instance",
            "name": "Test Instance",
            "icon": "grass",
            "created_at": "2026-01-01T00:00:00Z",
            "total_play_seconds": 0,
            "game_version": "1.21.1",
            "loader": {
                "type": "fabric",
                "version": "0.16.9"
            },
            "java": {
                "memory_max_mb": 4096,
                "memory_min_mb": 1024,
                "extra_args": []
            },
            "window": {
                "width": 854,
                "height": 480
            },
            "mods": []
        }"#;

        let dummy_instance: Instance = serde_json::from_str(instance_json).expect("Parse instance");

        let result = LoaderChangeResult {
            instance: dummy_instance,
            converted_count: 5,
            disabled_count: 2,
            converted_titles: vec!["Sodium".to_string(), "Iris".to_string()],
            disabled_titles: vec!["Fabric API".to_string()],
        };

        let json = serde_json::to_string(&result).expect("Serialize LoaderChangeResult");
        let deserialized: LoaderChangeResult = serde_json::from_str(&json).expect("Deserialize LoaderChangeResult");

        assert_eq!(deserialized.converted_count, 5);
        assert_eq!(deserialized.disabled_count, 2);
        assert_eq!(deserialized.converted_titles.len(), 2);
        assert_eq!(deserialized.disabled_titles.len(), 1);
        assert_eq!(deserialized.instance.loader.loader_type, LoaderType::Fabric);
    }
}

