// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::instance::{Instance, CreateInstanceConfig, InstanceSummary};
use crate::services::instance_service;
use crate::services::instance_cape;
use crate::models::settings::IngameCapeSettings;
use serde::Serialize;

/// A library instance summary plus UI-only computed flags. Uses
/// [`InstanceSummary`] (no `mods` array) so `list_instances` doesn't push
/// megabytes of mod metadata across IPC when the frontend only needs
/// `mod_count` for a badge.
#[derive(Serialize)]
pub struct InstanceListItem {
    #[serde(flatten)]
    instance: InstanceSummary,
    ingame_cape_supported: bool,
}

#[tauri::command]
pub async fn list_instances() -> Result<Vec<InstanceListItem>, String> {
    let list = instance_service::list_all()
        .await
        .map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|mut instance| {
            let supported = instance_cape::is_supported_loader(
                &instance.loader.loader_type,
                &instance.game_version,
            );
            if instance.companion_version.is_none() {
                instance.companion_version = crate::services::companion_mod::get_companion_version(
                    &instance.id,
                    &instance.game_version,
                    instance.loader.loader_type.as_str(),
                );
            }
            InstanceListItem {
                ingame_cape_supported: supported,
                instance: InstanceSummary::from_instance(instance),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn create_instance(config: CreateInstanceConfig) -> Result<Instance, String> {
    let instance = instance_service::create(config)
        .await
        .map_err(|e| e.to_string())?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}

#[tauri::command]
pub async fn get_instance(id: String) -> Result<Instance, String> {
    let mut instance = instance_service::get_by_id(&id)
        .await
        .map_err(|e| e.to_string())?;
    if instance.companion_version.is_none() {
        instance.companion_version = crate::services::companion_mod::get_companion_version(
            &instance.id,
            &instance.game_version,
            instance.loader.loader_type.as_str(),
        );
    }
    Ok(instance)
}

#[tauri::command]
pub async fn delete_instance(id: String) -> Result<(), String> {
    delete_instances(vec![id]).await
}

#[tauri::command]
pub async fn delete_instances(ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let instances_dir = crate::util::paths::instances_dir();
    let ids_set: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let mut max_last_played: Option<String> = None;

    // Scan metadata for last_played across all targets before deletion
    for id in &ids {
        let meta_path = instances_dir.join(id).join("instance.json");
        if meta_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                if let Ok(inst) = serde_json::from_str::<crate::models::instance::Instance>(&content) {
                    if let Some(lp) = inst.last_played {
                        if max_last_played.as_ref().is_none_or(|cur| &lp > cur) {
                            max_last_played = Some(lp);
                        }
                    }
                }
            }
        }
    }

    // Strip deleted instances from settings once
    if let Ok(mut settings) = crate::services::settings_service::load().await {
        let before_len = settings.sidebar_pinned_instances.len();
        settings.sidebar_pinned_instances.retain(|pinned| !ids_set.contains(pinned));
        let mut changed = settings.sidebar_pinned_instances.len() != before_len;

        if let Some(ref lp) = max_last_played {
            if settings.last_active_at.as_ref().is_none_or(|cur| lp > cur) {
                settings.last_active_at = Some(lp.clone());
                changed = true;
            }
        }

        if changed {
            let _ = crate::services::settings_service::save(&settings).await;
        }
    }

    // Delete folders concurrently in parallel blocking tasks
    let mut handles = Vec::new();
    for id in ids {
        let dir = instances_dir.join(id);
        handles.push(tokio::task::spawn_blocking(move || {
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    crate::util::platform::update_windows_estimated_size();
    Ok(())
}

#[tauri::command]
pub async fn update_instance_memory(id: String, memory_max_mb: u32) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    instance.java.memory_max_mb = memory_max_mb;
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ask the running install to stop.
///
/// The install aborts at its next checkpoint (between download tasks, or between
/// post-download stages) and returns an error, which routes into the install
/// flow's existing failure path — the one that already deletes the
/// partially-created instance directory. There's no separate teardown to keep in
/// sync as a result.
#[tauri::command]
pub async fn cancel_install(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::services::download::request_cancel();
    // Acknowledge immediately. The abort itself isn't instant — in-flight
    // requests finish first — and the aborting install returns an error rather
    // than emitting a terminal event, so without this the popup would sit at its
    // last phase until the 30s inactivity auto-hide.
    use tauri::Emitter;
    let _ = window.emit(
        "install-progress",
        crate::services::prepare::InstallProgressPayload {
            section: "cancelled".to_string(),
            title: "Install".to_string(),
            message: "Cancelling install...".to_string(),
            fraction: 0.0,
            skipped: false,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn install_modpack(
    project_id: String,
    version_id: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<crate::models::instance::Instance, String> {
    let _install = crate::services::download::InstallScope::begin();
    let instance = crate::services::modpack::install_from_modrinth(
        &project_id,
        version_id.as_deref(),
        Some(window),
    )
    .await?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}

/// Import a Modrinth modpack from a local .mrpack file.
#[tauri::command]
pub async fn import_mrpack(
    path: String,
    window: tauri::WebviewWindow,
) -> Result<Instance, String> {
    use tauri::Emitter;
    let _install = crate::services::download::InstallScope::begin();
    let _ = window.emit(
        "install-progress",
        crate::services::prepare::InstallProgressPayload {
            section: "game".to_string(),
            title: "Modpack".to_string(),
            message: "Analyzing package...".to_string(),
            fraction: 0.0,
            skipped: false,
        },
    );
    let path_buf = std::path::PathBuf::from(&path);
    let instance = crate::services::modpack::install_from_mrpack_file(
        &path_buf,
        None,
        None,
        Some(window),
    )
    .await?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}

#[tauri::command]
pub async fn install_cf_modpack(
    project_id: String,
    file_id: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<crate::models::instance::Instance, String> {
    let _install = crate::services::download::InstallScope::begin();
    let instance = crate::services::modpack::install_from_curseforge(
        &project_id,
        file_id.as_deref(),
        Some(window),
    )
    .await?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}

#[tauri::command]
pub async fn update_instance_options(
    id: String,
    memory_max_mb: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    extra_args: Option<Vec<String>>,
    adaptive_override: Option<bool>,
) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Some(mem) = memory_max_mb { instance.java.memory_max_mb = mem; }
    if let Some(w) = width { instance.window.width = w; }
    if let Some(h) = height { instance.window.height = h; }
    if let Some(args) = extra_args { instance.java.extra_args = args; }
    if let Some(ovr) = adaptive_override { instance.java.adaptive_override = ovr; }

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_instance(id: String, new_name: String) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    instance.name = new_name.trim().to_string();
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn change_instance_loader(
    id: String,
    loader_type: String,
    loader_version: Option<String>,
    disable_mods: bool,
) -> Result<crate::models::instance::Instance, String> {
    let parsed_loader = match loader_type.to_lowercase().as_str() {
        "fabric" => crate::models::instance::LoaderType::Fabric,
        "forge" => crate::models::instance::LoaderType::Forge,
        "neoforge" => crate::models::instance::LoaderType::Neoforge,
        "quilt" => crate::models::instance::LoaderType::Quilt,
        "vanilla" => crate::models::instance::LoaderType::Vanilla,
        other => return Err(format!("Unknown loader type '{}'", other)),
    };

    instance_service::change_loader(&id, parsed_loader, loader_version, disable_mods)
        .await
        .map_err(|e| e.to_string())
}


/// Set a user-supplied image as the instance's tile icon.
///
/// `source_path` is an absolute path to a local image file picked by the
/// user (the frontend opens a file dialog and hands us the path back). We
/// copy it into the instance's own directory so the icon survives across
/// re-imports and isn't tied to wherever the user happened to keep the
/// original. Stored at `instances/<id>/icon.png` regardless of the source
/// extension — the webview decodes by content, not extension.
///
/// Returns the absolute destination path so the frontend can immediately
/// re-render with the new icon (via `convertFileSrc`) without waiting for
/// `list_instances` to re-fetch.
#[tauri::command]
pub async fn set_instance_icon(id: String, source_path: String) -> Result<String, String> {
    let instance_dir = crate::util::paths::instances_dir().join(&id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance {} not found", id));
    }

    // Validate source exists and is readable as an image-like file. We don't
    // try to validate the file is a real PNG/JPG — the frontend's file
    // dialog already filters by extension, and the webview's `<img>` will
    // simply fail to render anything weird, leaving the fallback in place.
    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let dest = instance_dir.join("icon.png");

    // Copy bytes. We don't try to convert formats — most modpack icons are
    // PNG anyway and the webview decodes JPG / WebP transparently regardless
    // of the `.png` extension.
    std::fs::copy(src, &dest).map_err(|e| format!("Copy icon: {}", e))?;

    // Update instance.json to point at the new icon.
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let dest_str = strip_extended_prefix(&dest.to_string_lossy());
    instance.icon = dest_str.clone();

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(dest_str)
}

/// Reset an instance's tile icon back to the generic placeholder. Removes
/// the on-disk `icon.png` if it exists and writes the sentinel `"cube"` value
/// into `instance.json` so the frontend falls back to the loader-tinted
/// default banner.
#[tauri::command]
pub async fn clear_instance_icon(id: String) -> Result<(), String> {
    let instance_dir = crate::util::paths::instances_dir().join(&id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance {} not found", id));
    }

    let icon_file = instance_dir.join("icon.png");
    if icon_file.exists() {
        let _ = std::fs::remove_file(&icon_file);
    }

    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    instance.icon = "cube".to_string();

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Strip the Windows `\\?\` extended-length prefix from a path so the value
/// crossing the IPC boundary uses the friendly form (`C:\Users\...`).
/// Same idea as `services::java::strip_extended_prefix` but kept local to
/// avoid a backend-wide dependency from this command module.
fn strip_extended_prefix(s: &str) -> String {
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s.to_string()
    }
}

/// Duplicate an instance's full directory tree (mods, worlds, configs,
/// resource packs, etc.) into a new instance with a fresh UUID and a unique
/// name. Used by the Library / Settings "Clone instance" button.
#[tauri::command]
pub async fn clone_instance(
    id: String,
    new_name: Option<String>,
) -> Result<crate::models::instance::Instance, String> {
    instance_service::clone_instance(&id, new_name)
        .await
        .map_err(|e| e.to_string())
}

/// Pre-download all files needed to launch an instance.
/// Emits `install-progress` events for real-time progress display.
/// On failure, deletes the instance directory so no broken instance lingers.
#[tauri::command]
pub async fn prepare_instance(id: String, window: tauri::WebviewWindow) -> Result<(), String> {
    // This emits `install-progress`, which is what enables the popup's Cancel
    // button — so it needs a scope like the modpack paths, or that button would
    // raise a cancel flag with no install to consume or clear it.
    let _install = crate::services::download::InstallScope::begin();
    let instance = instance_service::get_by_id(&id).await.map_err(|e| e.to_string())?;
    if let Err(e) = crate::services::prepare::prepare(&instance, Some(window)).await {
        // Clean up the broken instance so the library doesn't show a non-launchable entry.
        let instance_dir = crate::util::paths::instances_dir().join(&id);
        if instance_dir.exists() {
            tracing::error!("Instance prepare failed, cleaning up {}: {}", id, e);
            let _ = std::fs::remove_dir_all(&instance_dir);
        }
        return Err(e);
    }
    Ok(())
}

// ───────────────────────── In-game cape ─────────────────────────────────

/// Set the in-game custom cape: store the baked cape (a square frame, or a
/// vertical strip of square frames for an animation) and turn it on. The
/// launcher stores it once in the global cape dir and points supported instances
/// at it via a JVM property at launch — no per-instance copies, no selection.
/// `cape_id` records which library cape this is (UI only); `frame_time_ms` is
/// the per-frame duration for animated strips.
#[tauri::command]
pub async fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png_base64: String,
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    use base64::Engine;
    let b64 = if let Some((_, b64)) = strip_png_base64.split_once(',') { b64 } else { &strip_png_base64 };
    let strip_png = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Invalid base64 cape: {}", e))?;
    instance_cape::set_ingame_cape(cape_id, &strip_png, frame_time_ms).await
}

/// Toggle the in-game cape on/off without re-baking it.
#[tauri::command]
pub async fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    instance_cape::set_ingame_cape_enabled(enabled).await
}

/// Per-instance on/off for the Vermeil companion mod. Persisted on the instance;
/// the launch-time reconcile (`companion_mod::ensure_installed`) keeps the
/// managed jar active or disabled (renamed `.disabled`, not deleted) to match,
/// so flipping it back on needs no re-download.
#[tauri::command]
pub async fn set_instance_companion_enabled(id: String, enabled: bool) -> Result<(), String> {
    let mut instance = instance_service::get_by_id(&id)
        .await
        .map_err(|e| e.to_string())?;
    if instance.companion_enabled == enabled {
        return Ok(());
    }
    instance.companion_enabled = enabled;
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove the in-game cape entirely.
#[tauri::command]
pub async fn clear_ingame_cape() -> Result<(), String> {
    instance_cape::clear_ingame_cape().await
}

/// Read the current in-game cape state, or `None` if none is set.
#[tauri::command]
pub async fn get_ingame_cape() -> Result<Option<IngameCapeSettings>, String> {
    Ok(instance_cape::get_ingame_cape().await)
}

/// MC versions the Vermeil companion mod supports for a given loader. Drives the
/// "supported" hint on the instance creator's version dropdown so a user can see,
/// before creating an instance, which versions get in-game companion support.
#[tauri::command]
pub async fn companion_supported_versions(loader: String) -> Result<Vec<String>, String> {
    Ok(instance_cape::supported_versions_for_loader(&loader))
}

/// Ping a Minecraft multiplayer server asynchronously via Server List Ping (SLP).
#[tauri::command]
pub async fn ping_server(address: String) -> Result<crate::models::instance::ServerPingInfo, String> {
    Ok(crate::services::server_ping::ping_server(&address).await)
}

/// Retrieve saved Quick Join servers from disk.
#[tauri::command]
pub async fn get_quick_servers() -> Result<Vec<crate::models::instance::QuickServerEntry>, String> {
    crate::services::server_ping::get_quick_servers().map_err(|e| e.to_string())
}

/// Save or update a server entry in the Quick Join deck.
#[tauri::command]
pub async fn save_quick_server(entry: crate::models::instance::QuickServerEntry) -> Result<Vec<crate::models::instance::QuickServerEntry>, String> {
    crate::services::server_ping::save_quick_server(entry).map_err(|e| e.to_string())
}

/// Remove a server from the Quick Join deck.
#[tauri::command]
pub async fn remove_quick_server(address: String) -> Result<Vec<crate::models::instance::QuickServerEntry>, String> {
    crate::services::server_ping::remove_quick_server(&address).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_delete_instances_empty_list() {
        let result = delete_instances(vec![]).await;
        assert!(result.is_ok());
    }
}
