// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::google_cloud::{
    self, CloudBackupSummary, CloudConnectSummary, CloudRestoreSummary,
};
use crate::services::settings_service;
use tauri::Manager;

#[tauri::command]
pub async fn connect_google_cloud(app: tauri::AppHandle) -> Result<CloudConnectSummary, String> {
    let summary = google_cloud::connect_google_account(Some(&app)).await?;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(summary)
}

#[tauri::command]
pub async fn disconnect_google_cloud(app: tauri::AppHandle) -> Result<(), String> {
    google_cloud::disconnect_google_account(Some(&app)).await
}

#[tauri::command]
pub async fn sign_out_google_cloud(app: tauri::AppHandle) -> Result<(), String> {
    google_cloud::sign_out_google_account(Some(&app)).await
}

#[tauri::command]
pub fn is_google_cloud_connected() -> bool {
    google_cloud::is_cloud_connected()
}

#[tauri::command]
pub async fn backup_to_google_cloud() -> Result<CloudBackupSummary, String> {
    google_cloud::backup_to_google_cloud().await
}

#[tauri::command]
pub async fn restore_from_google_cloud(app: tauri::AppHandle) -> Result<CloudRestoreSummary, String> {
    google_cloud::restore_from_google_cloud(Some(&app)).await
}

#[tauri::command]
pub async fn get_last_cloud_backup_time() -> Result<Option<String>, String> {
    let settings = settings_service::load().await.map_err(|e| e.to_string())?;
    Ok(settings.last_cloud_backup)
}

#[tauri::command]
pub async fn cancel_google_cloud() -> Result<(), String> {
    google_cloud::cancel_google_oauth();
    Ok(())
}
