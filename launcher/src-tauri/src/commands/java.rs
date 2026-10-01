// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Tauri commands for Java location management.
//!
//! Thin wrappers around `services::java`. All heavy work (subprocess spawn,
//! registry access, archive extraction) lives in the service.

use crate::services::java::{self, JavaInstall};
use crate::services::settings_service;

/// Re-scan the system for installed JREs across all five sources.
#[tauri::command]
pub async fn detect_java_installations() -> Result<Vec<JavaInstall>, String> {
    Ok(java::detect_installations().await)
}

/// Validate a user-picked path and return the parsed [`JavaInstall`] if it
/// resolves to a runnable JRE. The frontend uses this to verify the file
/// chosen via the Browse button before saving it.
#[tauri::command]
pub async fn validate_java_path(path: String) -> Result<JavaInstall, String> {
    java::validate_path(&path).await
}

/// Persist a per-major Java path override into `LauncherSettings`. Pass
/// `path = None` to clear the override (which falls back to auto-detection /
/// auto-install).
#[tauri::command]
pub async fn set_java_path(major: u8, path: Option<String>) -> Result<(), String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    match path {
        Some(p) if !p.is_empty() => {
            settings.java_paths.insert(major, p);
        }
        _ => {
            settings.java_paths.remove(&major);
        }
    }
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())
}

/// Trigger an Adoptium download for the given major version and store the
/// resulting executable path on `LauncherSettings::java_paths` so subsequent
/// launches use it without re-detection.
#[tauri::command]
pub async fn install_recommended_java(app: tauri::AppHandle, major: u8) -> Result<JavaInstall, String> {
    let install = java::install_recommended(Some(&app), major).await?;
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.java_paths.insert(major, install.path.clone());
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())?;
    crate::util::platform::update_windows_estimated_size();
    Ok(install)
}

/// Delete the Vermeil-downloaded JRE for a major version. Refuses to touch
/// externally-installed JREs — those are managed by the user's OS and the
/// safety check in `services::java::delete_auto_installed` enforces this.
///
/// If the configured `java_paths` entry pointed at the deleted directory,
/// it's cleared so the next launch can fall back to auto-detection or
/// trigger a fresh `install_recommended`.
#[tauri::command]
pub async fn delete_java_install(major: u8) -> Result<String, String> {
    let deleted = java::delete_auto_installed(major).await?;

    // Clear the override only if it pointed inside the directory we just
    // removed — leave any unrelated user override untouched.
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    let should_clear = settings
        .java_paths
        .get(&major)
        .map(|p| p.starts_with(&deleted))
        .unwrap_or(false);
    if should_clear {
        settings.java_paths.remove(&major);
        settings_service::save(&settings)
            .await
            .map_err(|e| e.to_string())?;
    }
    crate::util::platform::update_windows_estimated_size();
    Ok(deleted)
}

/// Walk every configured per-major Java path and drop entries whose
/// underlying file no longer exists on disk. Covers two real cases:
///
///   1. The user manually deleted a Vermeil-managed `<data>/java/jdk-N/`
///      folder from the file system. Settings still remembered the path,
///      so the UI showed a string that pointed at nothing.
///   2. The user uninstalled a JDK they had previously pointed Vermeil at
///      (Oracle Java, an external Adoptium install, etc.).
///
/// Returns the list of major versions that were cleared so the frontend can
/// surface a toast per slot. Called from the Settings tab + Onboarding step
/// on mount; also safe to call after Install / Browse if we ever want a
/// belt-and-braces cleanup pass.
#[tauri::command]
pub async fn prune_invalid_java_paths() -> Result<Vec<u8>, String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    let majors: Vec<u8> = settings.java_paths.keys().copied().collect();
    let mut cleared: Vec<u8> = Vec::new();

    for major in majors {
        let Some(path) = settings.java_paths.get(&major).cloned() else { continue };
        // `Path::exists()` follows symlinks — broken symlinks resolve to
        // false, which is what we want (the target JDK is gone).
        if !std::path::Path::new(&path).exists() {
            settings.java_paths.remove(&major);
            cleared.push(major);
        }
    }

    if !cleared.is_empty() {
        settings_service::save(&settings)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(cleared)
}
