// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! In-game custom cape integration with the Vermeil companion mod.
//!
//! This is a **global, single-toggle** feature. The state (on/off, which library
//! cape, frame timing) lives in the launcher settings (`config.json` →
//! `ingame_cape`), and the cape texture is stored **once** at
//! `<data>/companion/cape/cape.png`. The on/off + frame timing are mirrored into
//! the mod's settings file `<data>/companion/vermeil-settings.json` (see
//! [`crate::services::companion_settings`]), which the mod reads — there's no
//! separate `cape.json`. There are no per-instance copies. The `companion` dir is
//! the mod's data home generally; per-feature data lives in its own subfolder
//! (`cape/`).
//!
//! The companion mod reads its data dir from the `vermeil.dataDir` system
//! property. At launch we inject `-Dvermeil.dataDir=<that dir>` for **supported**
//! instances with the companion enabled — see [`jvm_property`]. So every instance
//! (custom, modpack, imported, pre-existing or new) is pointed at the same global
//! data dir uniformly, and a running supported instance live-reloads when the
//! files change. Unsupported instances get no property, so they're never touched.
//!
//! The cape PNG is baked **by the frontend** (canvas — the backend has no image
//! library) into the mod's texture layout: a square 64×64 cape frame, or a
//! vertical strip of square frames for an animation (`height == width * frames`).

use crate::models::instance::{Instance, LoaderType};
use crate::models::settings::IngameCapeSettings;
use crate::services::{companion_settings, instance_service, settings_service};
use crate::util::paths;
use std::fs;
use std::path::PathBuf;

/// Largest cape strip we'll store — bounds an untrusted/baked PNG on disk.
const MAX_STRIP_BYTES: usize = 32 * 1024 * 1024;
/// Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64).
const MAX_FRAME_SIZE: u32 = 2048;
/// Largest frame count we'll accept in a strip.
const MAX_FRAMES: u32 = 300;

/// The launcher's data directory for the companion mod (`vermeil.dataDir`). Holds
/// the mod's settings file and the per-feature data subfolders (e.g. `cape/`).
fn companion_dir() -> PathBuf {
    paths::data_dir().join("companion")
}

/// The cape texture lives in its own subfolder under the companion dir; on/off
/// and frame timing are settings in `vermeil-settings.json`, not next to it.
fn global_cape_png() -> PathBuf {
    companion_dir().join("cape").join("cape.png")
}

/// One-time rename of an earlier companion dir name (`<data>/ingame-cape/` or
/// `<data>/mod-data/`) to the current `companion/`, so a cape set before a rename
/// keeps working without re-toggling. Idempotent and best-effort.
fn migrate_legacy_dir() {
    let new = companion_dir();
    if new.exists() {
        return;
    }
    for old_name in ["mod-data", "ingame-cape"] {
        let old = paths::data_dir().join(old_name);
        if old.is_dir() {
            let _ = fs::rename(&old, &new);
            return;
        }
    }
}

// ───────────────────────── Toggle / store (settings-backed) ─────────────

/// Set the in-game cape: store the baked strip + meta in the companion dir and
/// record it in settings (on). Running supported instances live-reload it.
pub async fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png: &[u8],
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    validate_strip(strip_png)?;
    migrate_legacy_dir();
    let png_path = global_cape_png();
    if let Some(parent) = png_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create cape dir: {}", e))?;
    }
    paths::atomic_write(&png_path, strip_png).map_err(|e| format!("write cape.png: {}", e))?;
    // Mirror on/off + frame timing into vermeil-settings.json so a running
    // instance live-reloads (the mod polls that file).
    companion_settings::update_cape(true, frame_time_ms);

    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.ingame_cape = IngameCapeSettings { enabled: true, cape_id, frame_time_ms };
    settings_service::save(&settings).await.map_err(|e| e.to_string())?;

    cleanup_legacy_instance_capes().await;
    Ok(())
}

/// Flip the toggle without re-baking. Errors if no cape has been set yet.
pub async fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    if settings.ingame_cape.cape_id.is_none() {
        return Err("No in-game cape has been set yet.".to_string());
    }
    settings.ingame_cape.enabled = enabled;
    let frame_time_ms = settings.ingame_cape.frame_time_ms;
    settings_service::save(&settings).await.map_err(|e| e.to_string())?;

    // Mirror into vermeil-settings.json so running instances live-reload.
    migrate_legacy_dir();
    companion_settings::update_cape(enabled, frame_time_ms);
    Ok(())
}

/// Remove the in-game cape entirely (texture + cape settings), leaving the rest
/// of `vermeil-settings.json` (e.g. FOV) intact.
pub async fn clear_ingame_cape() -> Result<(), String> {
    let cape_subdir = companion_dir().join("cape");
    if cape_subdir.exists() {
        let _ = fs::remove_dir_all(&cape_subdir);
    }
    // Record the cape as off in the mod's settings file without disturbing other
    // feature settings stored alongside it.
    companion_settings::update_cape(false, None);

    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.ingame_cape = IngameCapeSettings::default();
    settings_service::save(&settings).await.map_err(|e| e.to_string())
}

/// Current in-game cape state, or `None` if none has been set.
pub async fn get_ingame_cape() -> Option<IngameCapeSettings> {
    let settings = settings_service::load().await.ok()?;
    settings.ingame_cape.cape_id.as_ref()?;
    Some(settings.ingame_cape)
}

// ───────────────────────── Support gate + launch wiring ──────────────────

/// MC versions the **Fabric/Quilt** companion jars target — the union of every
/// Fabric target's supported Minecraft versions.
const FABRIC_SUPPORTED: &[&str] = &[
    "26.1", "26.1.1", "26.1.2", "26.2", "26.3",
    "1.21.11",
];

/// MC versions the **NeoForge** companion jars target.
const NEOFORGE_SUPPORTED: &[&str] = &[
    "26.1", "26.1.1", "26.1.2", "26.2", "26.3",
    "1.21.11",
];

/// MC versions the **Forge** companion jar targets (companion/forge/1.8.9).
const FORGE_SUPPORTED: &[&str] = &["1.8.9"];

/// Minecraft versions the Fabric/Quilt companion jars support.
fn fabric_version_supported(version: &str) -> bool {
    FABRIC_SUPPORTED.contains(&version)
}

/// Minecraft versions the NeoForge companion jars support.
fn neoforge_version_supported(version: &str) -> bool {
    NEOFORGE_SUPPORTED.contains(&version)
}

/// Minecraft versions the Forge companion jar targets. 1.8.9 only — the legacy
/// PvP audience runs Forge there (companion/forge/1.8.9).
fn forge_version_supported(version: &str) -> bool {
    FORGE_SUPPORTED.contains(&version)
}

/// Companion-supported MC versions for a loader, named as the frontend names it
/// (`"fabric"`/`"quilt"`/`"neoforge"`/`"forge"`). Drives the "supported" hint on the
/// instance creator's version dropdown. Empty for loaders with no companion build.
pub fn supported_versions_for_loader(loader: &str) -> Vec<String> {
    match loader {
        "fabric" | "quilt" => FABRIC_SUPPORTED.iter().map(|s| s.to_string()).collect(),
        "neoforge" => NEOFORGE_SUPPORTED.iter().map(|s| s.to_string()).collect(),
        "forge" => FORGE_SUPPORTED.iter().map(|s| s.to_string()).collect(),
        "all" | "any" | "" => {
            let mut all = Vec::new();
            for v in FABRIC_SUPPORTED {
                if !all.contains(&v.to_string()) {
                    all.push(v.to_string());
                }
            }
            for v in NEOFORGE_SUPPORTED {
                if !all.contains(&v.to_string()) {
                    all.push(v.to_string());
                }
            }
            for v in FORGE_SUPPORTED {
                if !all.contains(&v.to_string()) {
                    all.push(v.to_string());
                }
            }
            all
        }
        _ => Vec::new(),
    }
}

/// Whether the companion mod can render a cape on this instance. Support is
/// loader-aware: modern versions run on Fabric (and Quilt) or NeoForge;
/// the separate legacy Forge build runs on 1.8.9.
pub fn is_supported_loader(loader_type: &LoaderType, game_version: &str) -> bool {
    match loader_type {
        LoaderType::Fabric | LoaderType::Quilt => {
            fabric_version_supported(game_version)
        }
        LoaderType::Neoforge => neoforge_version_supported(game_version),
        LoaderType::Forge => forge_version_supported(game_version),
        _ => false,
    }
}

/// Convenience wrapper for callers that have a full [`Instance`].
pub fn is_supported(instance: &Instance) -> bool {
    is_supported_loader(&instance.loader.loader_type, &instance.game_version)
}

/// The `-Dvermeil.dataDir=…` JVM argument to inject at launch, or `None` when the
/// companion mod is off for this instance (`companion_enabled`) or the instance
/// isn't supported. Pointing every supported instance at the one companion dir
/// is what replaces per-instance file copies: the mod reads its shared data
/// (cape, `vermeil-settings.json`) from there and live-reloads when the files
/// change. No longer gated on a cape existing — the dir also carries the mod's
/// settings, and a cape can be added later without relaunching.
pub fn jvm_property(instance: &Instance) -> Option<String> {
    migrate_legacy_dir();
    if !instance.companion_enabled || !is_supported(instance) {
        return None;
    }
    Some(format!("-Dvermeil.dataDir={}", companion_dir().display()))
}

/// Best-effort removal of cape files written by the earlier per-instance design
/// (`instances/<id>/.minecraft/vermeil/cape.{png,json}`) and the old single-file
/// global cape (`<data>/ingame-cape.png`). The mod now reads the `companion/` dir
/// via `vermeil.dataDir`, so these are obsolete; clean them up the next time the
/// user touches the cape so no stale folders linger. Never propagates errors.
async fn cleanup_legacy_instance_capes() {
    // Old single-file global cape (superseded by the companion/ dir).
    let legacy_global = paths::data_dir().join("ingame-cape.png");
    if legacy_global.is_file() {
        let _ = fs::remove_file(&legacy_global);
    }

    let instances = match instance_service::list_all().await {
        Ok(v) => v,
        Err(_) => return,
    };
    for inst in &instances {
        let vermeil_dir = paths::instances_dir().join(&inst.id).join(".minecraft").join("vermeil");
        if !vermeil_dir.exists() {
            continue;
        }
        for name in ["cape.png", "cape.json"] {
            let f = vermeil_dir.join(name);
            if f.exists() {
                let _ = fs::remove_file(&f);
            }
        }
        // Drop the dir if it's now empty (don't disturb it if the user put other files there).
        if let Ok(mut entries) = fs::read_dir(&vermeil_dir) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(&vermeil_dir);
            }
        }
    }
}

// ───────────────────────── Validation ───────────────────────────────────

/// Validate the baked cape PNG: a square frame, or a vertical strip of square
/// frames (`height == width * n`), within sane size bounds. Mirrors the mod's
/// own frame-strip interpretation so a stored cape renders there.
fn validate_strip(png: &[u8]) -> Result<(), String> {
    if png.len() > MAX_STRIP_BYTES {
        return Err(format!(
            "Cape image is too large ({} MB). Max is {} MB.",
            png.len() / (1024 * 1024),
            MAX_STRIP_BYTES / (1024 * 1024)
        ));
    }
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Cape image isn't a valid PNG".to_string());
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    if width == 0 || height == 0 || width > MAX_FRAME_SIZE {
        return Err(format!("Cape frame size out of range — got {}x{}", width, height));
    }
    if !height.is_multiple_of(width) {
        return Err(format!(
            "Cape image must be a square frame or a vertical strip of square frames — got {}x{}",
            width, height
        ));
    }
    let frames = height / width;
    if frames > MAX_FRAMES {
        return Err(format!("Cape animation has too many frames ({}). Max is {}.", frames, MAX_FRAMES));
    }
    Ok(())
}
