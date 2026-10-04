// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Tauri commands wrapping the auto-updater service. The frontend never
//! touches the Tauri updater plugin's JS API directly — it goes through
//! these wrappers so we control the install lifecycle (see `app_updater.rs`
//! for why).

use tauri::{AppHandle, ResourceId, Runtime, Webview};

#[tauri::command]
pub async fn start_update_download<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> Result<(), String> {
    crate::services::app_updater::start_update_download(webview, rid).await
}

#[tauri::command]
pub async fn apply_pending_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::services::app_updater::apply_pending_update(app).await
}

#[tauri::command]
pub async fn check_for_updates<R: Runtime>(
    webview: Webview<R>,
    channel: Option<String>,
    allow_downgrades: Option<bool>,
) -> Result<crate::services::app_updater::UpdateCheckResponse, String> {
    crate::services::app_updater::check_for_updates(webview, channel, allow_downgrades).await
}

#[tauri::command]
pub fn clear_pending_update<R: Runtime>(app: AppHandle<R>) {
    crate::services::app_updater::clear_pending_update(&app);
}
