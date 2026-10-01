// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::instance::*;
use crate::util::paths;
use std::fs;
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


/// Change an instance's mod loader and/or loader version.
///
/// If `disable_mods` is true, all active entries in `instance.mods` where `category == "mod"`
/// are renamed from `*.jar` to `*.jar.disabled` on disk and marked `enabled = false` in `instance.json`.
/// Non-mod content (resourcepacks, shaders, datapacks) is kept intact since those formats
/// are loader-independent. Any loose unrecorded `.jar` files in `.minecraft/mods` are also
/// renamed to `.jar.disabled` so incompatible jars cannot crash the newly selected loader.
pub async fn change_loader(
    id: &str,
    loader_type: LoaderType,
    loader_version: Option<String>,
    disable_mods: bool,
) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let instance_dir = paths::instances_dir().join(id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance '{}' not found", id).into());
    }

    let content = fs::read_to_string(&meta_path)?;
    let mut instance: Instance = serde_json::from_str(&content)?;

    if disable_mods {
        let mods_dir = instance_dir.join(".minecraft").join("mods");
        if mods_dir.exists() {
            // 1. Disable tracked mod entries
            for entry in &mut instance.mods {
                if entry.category == "mod" && entry.enabled {
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
                }
            }

            // 2. Also check for any loose *.jar files in mods_dir that aren't yet disabled
            if let Ok(dir_entries) = fs::read_dir(&mods_dir) {
                for dir_entry in dir_entries.flatten() {
                    let p = dir_entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension() {
                            if ext == "jar" {
                                let file_name_lossy = p.file_name().unwrap_or_default().to_string_lossy();
                                // Ignore Vermeil companion mod jar
                                if !file_name_lossy.starts_with("vermeil-") {
                                    let new_path = mods_dir.join(format!("{}.disabled", file_name_lossy));
                                    let _ = fs::rename(&p, &new_path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

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

    // Update loader config
    instance.loader.loader_type = loader_type;
    instance.loader.version = cleaned_version;

    // Atomic write
    let json = serde_json::to_string_pretty(&instance)?;
    paths::atomic_write(&meta_path, json.as_bytes())?;

    Ok(instance)
}

