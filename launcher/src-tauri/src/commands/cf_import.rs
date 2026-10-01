// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::instance::Instance;
use crate::services::cf_import;
use crate::services::settings_service;

/// Import a CurseForge modpack from a .zip file.
#[tauri::command]
pub async fn import_cf_zip(
    zip_path: String,
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
    let settings = settings_service::load().await.map_err(|e| e.to_string())?;
    let instance = cf_import::import_zip(&zip_path, &settings.curseforge_api_key, None, None, Some(window)).await?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}

/// Export a Vermeil instance into a compact serverless VML share code.
#[tauri::command]
pub async fn export_share_code(instance_id: String) -> Result<String, String> {
    crate::services::share_code::export_instance_share_code(&instance_id).await
}

/// Decode and preview a share code (supports Cloudflare VML-XXXX-XXXX and offline VML...).
#[tauri::command]
pub async fn preview_share_code(code: String) -> Result<crate::services::share_code::ShareCodePreview, String> {
    crate::services::share_code::preview_share_code(&code).await
}

/// Import a Vermeil instance from a VML share code.
#[tauri::command]
pub async fn import_share_code(
    code: String,
    window: tauri::WebviewWindow,
) -> Result<Instance, String> {
    use tauri::Emitter;
    let _install = crate::services::download::InstallScope::begin();
    let _ = window.emit(
        "install-progress",
        crate::services::prepare::InstallProgressPayload {
            section: "game".to_string(),
            title: "Share Code".to_string(),
            message: "Resolving instance blueprint...".to_string(),
            fraction: 0.0,
            skipped: false,
        },
    );
    let settings = settings_service::load().await.map_err(|e| e.to_string())?;
    let instance = crate::services::share_code::import_share_code(
        &code,
        &settings.curseforge_api_key,
        Some(window),
    )
    .await?;
    crate::util::platform::update_windows_estimated_size();
    Ok(instance)
}
