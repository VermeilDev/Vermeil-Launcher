// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! The Vermeil companion mod's own settings file — `vermeil-settings.json` in the
//! shared companion data dir (`<data>/companion/`).
//!
//! This is the single store for everything the mod *does* — cape on/off + frame
//! timing, FOV effects, and future features — as opposed to whether the mod is
//! installed (that's the per-instance toggle in `companion_mod`). It lives once
//! in the shared dir, so a setting changed in-game persists across every
//! supported Minecraft version.
//!
//! Layout convention: settings live here, grouped by feature; bulk/asset data
//! lives in per-feature subfolders (e.g. the cape texture at `companion/cape/`).
//!
//! Round-trip, mirroring the `options.txt` bridge in [`crate::services::video_options`]:
//! - **Write (pre-launch)** — [`write_for_launch`] writes the file from the
//!   launcher's stored settings, so the launcher is authoritative at launch time.
//! - **Live update** — [`update_cape`] rewrites just the cape section while
//!   preserving the rest, so toggling the cape in the launcher live-reloads a
//!   running instance (the mod polls this file).
//! - **Read (post-exit)** — [`read_back`] parses the file the mod may have changed
//!   in-game, so those changes flow back into the launcher's own settings.
//!
//! Best-effort throughout: a cosmetic settings file must never block or fail a
//! launch.

use crate::models::settings::LauncherSettings;
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// `vermeil-settings.json` lives at the root of the companion dir.
fn settings_path() -> PathBuf {
    paths::data_dir().join("companion").join("vermeil-settings.json")
}

/// The mod-facing settings. JSON keys are camelCase to match the mod's reader.
/// Settings are grouped by feature; each field carries a default so a partial /
/// hand-edited file still loads. The launcher creates this file with the full
/// default schema up front (see [`ensure_scaffold`]), so every feature's settings
/// are always present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VermeilSettings {
    /// Custom cape feature settings.
    #[serde(default)]
    pub cape: CapeSettings,
    /// FOV-effects scale in `[0.0, 1.0]`, `1.0` = vanilla. Always present in the
    /// file, but only the **pre-1.16** mod (1.8.9) reads it and only pre-1.16
    /// syncs it back to the launcher — 1.16+ has the setting natively and ignores
    /// this one (its native value round-trips through `options.txt` instead).
    #[serde(rename = "fovEffectsScale", default = "default_scale")]
    pub fov_effects_scale: f64,
}

/// Cape on/off and animation speed. The texture itself lives at
/// `companion/cape/cape.png` (not in this file).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapeSettings {
    /// Whether the cape renders (when a texture is present). Default true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Per-frame duration for an animated cape (ms). Absent for a static cape.
    #[serde(rename = "frameTimeMs", default, skip_serializing_if = "Option::is_none")]
    pub frame_time_ms: Option<u32>,
}

fn default_true() -> bool {
    true
}
fn default_scale() -> f64 {
    1.0
}

impl Default for VermeilSettings {
    fn default() -> Self {
        Self {
            cape: CapeSettings::default(),
            fov_effects_scale: 1.0,
        }
    }
}

impl Default for CapeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            frame_time_ms: None,
        }
    }
}

/// Create the companion dir scaffold — the `cape/` subfolder and a default
/// `vermeil-settings.json` — up front so the layout and a fully-populated settings
/// file always exist, independent of whether a cape has been set. Run once at
/// launcher startup. Idempotent: never overwrites an existing settings file.
pub fn ensure_scaffold() {
    let dir = paths::data_dir().join("companion");
    if let Err(e) = std::fs::create_dir_all(dir.join("cape")) {
        tracing::warn!("Could not create companion scaffold: {}", e);
        return;
    }
    if read_back().is_none() {
        write(&VermeilSettings::default());
    }
}

/// Write `vermeil-settings.json` from the launcher's stored settings, before
/// launch. The launcher is authoritative at launch time (same model as
/// `options.txt`). The FOV-effects value is always written; only the pre-1.16
/// mod reads it. Best-effort — never blocks a launch.
pub fn write_for_launch(settings: &LauncherSettings) {
    let vs = VermeilSettings {
        cape: CapeSettings {
            enabled: settings.ingame_cape.enabled,
            frame_time_ms: settings.ingame_cape.frame_time_ms,
        },
        fov_effects_scale: settings.video_settings.fov_effects.unwrap_or(1.0),
    };
    write(&vs);
}

/// Rewrite just the cape section, preserving everything else in the file (e.g. a
/// pre-1.16 `fovEffectsScale`). Used when the launcher toggles/swaps the cape
/// outside a launch, so a running instance live-reloads (the mod polls the file).
pub fn update_cape(enabled: bool, frame_time_ms: Option<u32>) {
    let mut vs = read_back().unwrap_or_default();
    vs.cape = CapeSettings { enabled, frame_time_ms };
    write(&vs);
}

/// Read `vermeil-settings.json` back, or `None` if it's absent or unreadable. The
/// mod may have changed it in-game; the caller merges the values it owns into
/// launcher settings.
pub fn read_back() -> Option<VermeilSettings> {
    let content = std::fs::read_to_string(settings_path()).ok()?;
    serde_json::from_str(&content).ok()
}

/// Serialize and atomically write the file, creating the companion dir if needed.
/// Best-effort — logs and swallows errors so it never blocks a launch.
fn write(vs: &VermeilSettings) {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Could not create companion dir for vermeil-settings.json: {}", e);
            return;
        }
    }
    match serde_json::to_string_pretty(vs) {
        Ok(json) => {
            if let Err(e) = paths::atomic_write(&path, json.as_bytes()) {
                tracing::warn!("Could not write vermeil-settings.json: {}", e);
            }
        }
        Err(e) => tracing::warn!("Could not serialize vermeil-settings.json: {}", e),
    }
}
