// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::settings::LauncherSettings;
use crate::util::paths;
use std::fs;

pub async fn load() -> Result<LauncherSettings, Box<dyn std::error::Error + Send + Sync>> {
    let config_path = paths::data_dir().join("config.json");

    if !config_path.exists() {
        let defaults = LauncherSettings::default();
        save(&defaults).await?;
        return Ok(defaults);
    }

    let content = fs::read_to_string(&config_path)?;
    let mut settings: LauncherSettings = serde_json::from_str(&content)?;

    // Self-heal `sidebar_pinned_instances` — drop any IDs whose instance
    // folder no longer exists on disk. Without this, deleting an instance
    // through some path that bypasses the delete command (manual rm,
    // partial migration, app-crash mid-create) would leave a ghost pin
    // that bumps the count toward the 3-pin cap and prevents adding new
    // ones. The check is cheap (one `exists()` call per pinned ID) so we
    // run it on every load.
    let before = settings.sidebar_pinned_instances.len();
    settings.sidebar_pinned_instances.retain(|id| {
        paths::instances_dir().join(id).exists()
    });
    if settings.sidebar_pinned_instances.len() != before {
        // Persist the cleanup so subsequent reads aren't doing the same
        // work. Best-effort — a save failure just means we'll re-prune
        // next launch.
        let _ = save(&settings).await;
    }

    // Detect version transition: if running an experimental build and
    // either last_app_version is unset or differs from current, ensure
    // the user defaults to the experimental update channel.
    let cur_version = env!("CARGO_PKG_VERSION");
    let is_experimental = cur_version.contains('-');
    let mut version_changed = false;

    if settings.last_app_version.as_deref() != Some(cur_version) {
        if is_experimental && settings.update_channel != "experimental" {
            settings.update_channel = "experimental".to_string();
        }
        settings.last_app_version = Some(cur_version.to_string());
        version_changed = true;
    }

    if !content.contains("\"update_channel\"") {
        version_changed = true;
    }

    if settings.curseforge_api_key == crate::commands::mods::DEFAULT_CURSEFORGE_KEY {
        settings.curseforge_api_key.clear();
        version_changed = true;
    }

    if version_changed {
        let _ = save(&settings).await;
    }

    // Synchronize lifetime_play_seconds and last_active_at monotonically:
    // If instances currently on disk have a higher combined playtime (e.g. from existing
    // instances or newly imported instances), ensure lifetime_play_seconds never lags behind.
    let instances_dir = paths::instances_dir();
    if instances_dir.exists() {
        let mut sum_play = 0u64;
        let mut latest_played: Option<String> = None;
        if let Ok(entries) = fs::read_dir(&instances_dir) {
            for entry in entries.flatten() {
                let meta_path = entry.path().join("instance.json");
                if let Ok(content) = fs::read_to_string(&meta_path) {
                    if let Ok(inst) = serde_json::from_str::<crate::models::instance::Instance>(&content) {
                        sum_play = sum_play.saturating_add(inst.total_play_seconds);
                        if let Some(lp) = inst.last_played {
                            if latest_played.as_ref().is_none_or(|cur| lp > *cur) {
                                latest_played = Some(lp);
                            }
                        }
                    }
                }
            }
        }
        let mut changed = false;
        if sum_play > settings.lifetime_play_seconds {
            settings.lifetime_play_seconds = sum_play;
            changed = true;
        }
        if let Some(lp) = latest_played {
            if settings.last_active_at.as_ref().is_none_or(|cur| lp > *cur) {
                settings.last_active_at = Some(lp);
                changed = true;
            }
        }
        if changed {
            let _ = save(&settings).await;
        }
    }

    Ok(settings)
}

pub async fn save(settings: &LauncherSettings) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let data_dir = paths::data_dir();
    fs::create_dir_all(&data_dir)?;

    let config_path = data_dir.join("config.json");
    let mut to_save = settings.clone();

    // Monotonic guard: never allow an older in-memory frontend snapshot (e.g. from
    // Settings.tsx or OnboardingWizard.tsx) to overwrite higher lifetime_play_seconds
    // or a newer last_active_at already persisted on disk.
    if let Ok(existing_raw) = fs::read_to_string(&config_path) {
        if let Ok(existing) = serde_json::from_str::<LauncherSettings>(&existing_raw) {
            if existing.lifetime_play_seconds > to_save.lifetime_play_seconds {
                to_save.lifetime_play_seconds = existing.lifetime_play_seconds;
            }
            if let Some(ref existing_last) = existing.last_active_at {
                let should_keep_existing = match to_save.last_active_at {
                    Some(ref incoming_last) => {
                        crate::services::google_cloud::is_timestamp_newer(existing_last, incoming_last)
                    }
                    None => true,
                };
                if should_keep_existing {
                    to_save.last_active_at = Some(existing_last.clone());
                }
            }
            // Also preserve last_cloud_backup if the caller passed None while a backup timestamp exists
            // (except when sign_out / disconnect explicitly clears google_cloud.enc first)
            if to_save.last_cloud_backup.is_none()
                && existing.last_cloud_backup.is_some()
                && crate::services::google_cloud::is_cloud_connected()
            {
                to_save.last_cloud_backup = existing.last_cloud_backup;
            }
        }
    }

    let json = serde_json::to_string_pretty(&to_save)?;
    paths::atomic_write(&config_path, json.as_bytes())?;
    Ok(())
}

