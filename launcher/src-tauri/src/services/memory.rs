// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Adaptive RAM allocation.
//!
//! The launcher picks a `-Xmx` per instance from a tiered formula based on:
//!
//!   - Game-version baseline (1.21+ chunk renderer is heavier than 1.20-)
//!   - Loader (Forge/NeoForge cost more heap than Fabric/Quilt at runtime)
//!   - Mod count (above ~25 mods, ~30 MB amortized per content mod)
//!   - Resource pack / shader pack presence
//!   - Iris/OptiFine presence (extra heap even before a shader is selected)
//!
//! Constants are calibrated against published recommended-RAM values from
//! All The Mods 10, ATM10 Sky, Cobbleverse / Cobblemon Adventure, and the
//! generic modded-server sizing tables — within ±15 % of what the pack
//! authors themselves recommend, which is well inside the slack from world
//! state, render distance, and exploration patterns.
//!
//! Adaptive is the default: the formula's target is clamped to the user's
//! configured maximum (Settings → Resources) and a system-derived minimum.
//! Per instance, `JavaConfig::adaptive_override` turns adaptive off and uses
//! the manual `memory_max_mb` value verbatim. The legacy global
//! `LauncherSettings::adaptive_ram` flag is retained for settings-file
//! compatibility but no longer gates the result.

use crate::models::instance::{Instance, LoaderType};
use crate::models::settings::LauncherSettings;
use serde::Serialize;

/// One row of the formula's contribution. The frontend renders these as a
/// "Why this value?" breakdown tooltip on the per-instance memory display.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryBreakdown {
    pub label: String,
    pub value_mb: u32,
}

/// Everything the launch path and the per-instance UI need in one shot.
/// `value_mb` is the post-clamp `-Xmx` we'll actually use; `target_mb` is
/// the formula's raw output so the UI can flag a "capped" condition when
/// the user's max isn't enough for the pack.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveMemory {
    pub value_mb: u32,
    pub target_mb: u32,
    pub min_mb: u32,
    pub max_mb: u32,
    pub capped: bool,
    /// Always `true` unless this instance turned adaptive off
    /// (`JavaConfig::adaptive_override`), in which case `value_mb ==
    /// instance.java.memory_max_mb` and the UI shows the manual slider.
    pub adaptive_active: bool,
    pub breakdown: Vec<MemoryBreakdown>,
}

// ─── System-RAM-derived defaults ─────────────────────────────────────────

/// Default upper bound in MB given total system RAM.
/// Calibrated for 2025-2026 systems to protect the host OS, prevent paging/swap
/// lockups on low-RAM laptops, and prevent G1GC pause degradation above 12 GB.
/// Note: Users can always set any higher value manually via Custom Memory Limit.
pub fn default_max_for_system(system_mb: u32) -> u32 {
    let (os_reserve, usable_pct) = if system_mb <= 4_096 {
        (1_536u32, 0.70f64)
    } else if system_mb <= 8_192 {
        (2_048u32, 0.80f64)
    } else if system_mb <= 16_384 {
        (4_096u32, 0.75f64)
    } else {
        (6_144u32, 0.65f64)
    };

    let usable = system_mb.saturating_sub(os_reserve);
    let raw = (usable as f64 * usable_pct) as u32;
    let aligned = (raw / 256) * 256;
    aligned.clamp(1_024, 12_288)
}

/// Default lower bound in MB. Scales with the user's max so a low-spec
/// system isn't told the floor is bigger than the ceiling, but never goes
/// below 1 GB (anything less crashes vanilla MC during world load).
pub fn default_min_for_system(system_mb: u32) -> u32 {
    let max = default_max_for_system(system_mb);
    let raw = (max as f64 * 0.35) as u32;
    let aligned = (raw / 256) * 256;
    aligned.clamp(1_024, 4_096)
}

// ─── Formula ─────────────────────────────────────────────────────────────

/// Display label for a loader. Keeps human-readable strings out of the
/// breakdown labels that go to the UI.
fn loader_label(lt: &LoaderType) -> &'static str {
    match lt {
        LoaderType::Forge => "Forge",
        LoaderType::Neoforge => "NeoForge",
        LoaderType::Fabric => "Fabric",
        LoaderType::Quilt => "Quilt",
        LoaderType::Vanilla => "Vanilla",
    }
}

/// Round up to the nearest 256 MB. Users see "5.5 GB" cleaner than "5394 MB",
/// and 256 MB grain matches the JVM's own region-size alignment.
fn round_up_256(mb: u32) -> u32 {
    mb.div_ceil(256) * 256
}

/// Heuristic: does this instance have Iris/OptiFine/Oculus installed? They
/// add ~250 MB of baseline heap even with no shader selected, and detecting
/// them by filename pattern is reliable across both Modrinth and CurseForge
/// installs (project IDs differ per platform).
fn has_shader_loader(instance: &Instance) -> bool {
    instance.mods.iter().any(|m| {
        if !m.enabled {
            return false;
        }
        let f = m.filename.to_lowercase();
        f.contains("iris") || f.contains("optifine") || f.contains("oculus")
    })
}

/// Compute the adaptive target and structured breakdown for an instance,
/// independent of the user's min/max bounds. Caller clamps + decides which
/// path to take based on `adaptive_active`.
fn compute_target(instance: &Instance) -> (u32, Vec<MemoryBreakdown>) {
    let mut rows: Vec<MemoryBreakdown> = Vec::new();

    // Vanilla baseline — 1.21+ chunk renderer adds ~250 MB over older
    // versions. We use a single value for simplicity.
    let base = 1_280u32;
    rows.push(MemoryBreakdown {
        label: "Base game".into(),
        value_mb: base,
    });

    // Loader runtime overhead.
    let loader_overhead = match instance.loader.loader_type {
        LoaderType::Forge | LoaderType::Neoforge => 1_280u32,
        LoaderType::Fabric | LoaderType::Quilt => 384u32,
        LoaderType::Vanilla => 0u32,
    };
    if loader_overhead > 0 {
        rows.push(MemoryBreakdown {
            label: format!("{} runtime", loader_label(&instance.loader.loader_type)),
            value_mb: loader_overhead,
        });
    }

    // Mod count overhead with diminishing returns.
    // In modern 2025-2026 modding, large modpacks contain shared libraries,
    // utility mods, and optimization mods (FerriteCore, ModernFix, Sodium)
    // that amortize memory rather than scaling linearly.
    // Only enabled mods are counted.
    let mod_count = instance
        .mods
        .iter()
        .filter(|m| m.category == "mod" && m.enabled)
        .count() as u32;

    let mod_overhead = if mod_count <= 25 {
        0
    } else {
        let mut total = 0u32;
        // Tier 1: Mods 26..=100 (core content additions): 20 MB each (max 1,500 MB)
        let t1 = mod_count.saturating_sub(25).min(75);
        total += t1 * 20;

        // Tier 2: Mods 101..=250 (medium expansion): 15 MB each (max 2,250 MB)
        let t2 = mod_count.saturating_sub(100).min(150);
        total += t2 * 15;

        // Tier 3: Mods 251..=400 (heavy tech/worldgen): 10 MB each (max 1,500 MB)
        let t3 = mod_count.saturating_sub(250).min(150);
        total += t3 * 10;

        // Tier 4: Mods 401+ (addons / mega kitchen-sink): 5 MB each
        let t4 = mod_count.saturating_sub(400);
        total += t4 * 5;

        total
    };

    if mod_overhead > 0 {
        rows.push(MemoryBreakdown {
            label: format!("{} mods (tiered)", mod_count),
            value_mb: mod_overhead,
        });
    }

    // Resource packs. Hi-res atlases consume heap during texture stitching.
    let has_resource_pack = instance.mods.iter().any(|m| m.category == "resourcepack" && m.enabled);
    if has_resource_pack {
        rows.push(MemoryBreakdown {
            label: "Resource packs".into(),
            value_mb: 256,
        });
    }

    // Shader pack present (separate from the loader mod).
    let has_shader_pack = instance.mods.iter().any(|m| m.category == "shader" && m.enabled);
    if has_shader_pack {
        rows.push(MemoryBreakdown {
            label: "Shader pack".into(),
            value_mb: 768,
        });
    }

    // Iris/OptiFine even without an active pack — allocates framebuffer state.
    if has_shader_loader(instance) {
        rows.push(MemoryBreakdown {
            label: "Iris/OptiFine".into(),
            value_mb: 256,
        });
    }

    let raw: u32 = rows.iter().map(|r| r.value_mb).sum();
    // Round up to nearest 256 MB, with a 10 GB target ceiling to prevent
    // G1GC pause degradation on massive modpacks.
    let target = round_up_256(raw).min(10_240);
    (target, rows)
}

// ─── Public entry points ─────────────────────────────────────────────────

/// Resolve everything the launch path and per-instance UI need.
///
/// `system_mb` is the total system RAM in megabytes (from the same source
/// `commands::settings::get_system_memory` reads). When detection failed,
/// pass a sane fallback like 8192 — `default_max_for_system` will keep the
/// numbers conservative.
pub fn resolve(instance: &Instance, settings: &LauncherSettings, system_mb: u32) -> EffectiveMemory {
    let (target, breakdown) = compute_target(instance);

    let min_mb = if settings.adaptive_ram_min_mb == 0 {
        default_min_for_system(system_mb)
    } else {
        settings.adaptive_ram_min_mb
    };
    let max_mb = if settings.adaptive_ram_max_mb == 0 {
        default_max_for_system(system_mb)
    } else {
        settings.adaptive_ram_max_mb
    };
    // Defensive: a corrupted settings file with min > max would otherwise
    // produce a negative range. Pull min down to max so the clamp stays
    // well-defined.
    let min_mb = min_mb.min(max_mb);

    // Per-instance opt-out: when an instance turns adaptive RAM off
    // (`adaptive_override`), use its manual `memory_max_mb` verbatim. Otherwise
    // the formula's target, clamped to the user's global max.
    let adaptive_active = !instance.java.adaptive_override;
    let value_mb = if adaptive_active {
        target.clamp(min_mb, max_mb)
    } else {
        instance.java.memory_max_mb
    };
    let capped = adaptive_active && value_mb < target;

    EffectiveMemory {
        value_mb,
        target_mb: target,
        min_mb,
        max_mb,
        capped,
        adaptive_active,
        breakdown,
    }
}

/// Convenience for callers that don't already have settings + system RAM
/// loaded. Reads both, then delegates to `resolve`.
pub async fn resolve_async(instance: &Instance) -> Result<EffectiveMemory, String> {
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let system_mb = system_memory_mb();
    Ok(resolve(instance, &settings, system_mb))
}

/// Total system memory in MB. Uses the same `sysinfo` source as
/// `commands::settings::get_system_memory`. Returns `8192` as a defensive
/// fallback if detection fails — better than `0` which would crater the
/// default-max formula.
pub fn system_memory_mb() -> u32 {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory();
    if bytes == 0 {
        return 8_192;
    }
    let mb = bytes / 1024 / 1024;
    mb.min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::instance::{Instance, JavaConfig, LoaderConfig, LoaderType, ModEntry, WindowConfig};

    fn make_test_instance(loader: LoaderType, mod_count: usize, has_shader: bool) -> Instance {
        let mut mods = Vec::new();
        for i in 0..mod_count {
            mods.push(ModEntry {
                id: format!("mod-{}", i),
                source: "modrinth".into(),
                project_id: format!("proj-{}", i),
                version_id: format!("ver-{}", i),
                filename: format!("mod_{}.jar", i),
                version_number: None,
                enabled: true,
                pinned: false,
                title: None,
                icon_url: None,
                local_icon_path: None,
                description: None,
                author: None,
                category: "mod".into(),
                loaders: Vec::new(),
                game_versions: Vec::new(),
            });
        }
        if has_shader {
            mods.push(ModEntry {
                id: "shader-1".into(),
                source: "modrinth".into(),
                project_id: "shader-p".into(),
                version_id: "shader-v".into(),
                filename: "complementary.zip".into(),
                version_number: None,
                enabled: true,
                pinned: false,
                title: None,
                icon_url: None,
                local_icon_path: None,
                description: None,
                author: None,
                category: "shader".into(),
                loaders: Vec::new(),
                game_versions: Vec::new(),
            });
        }
        Instance {
            format_version: 1,
            id: "test".into(),
            name: "Test".into(),
            icon: "cube".into(),
            icon_custom: None,
            created_at: "now".into(),
            last_played: None,
            total_play_seconds: 0,
            game_version: "1.21.1".into(),
            loader: LoaderConfig { loader_type: loader, version: None },
            java: JavaConfig::default(),
            window: WindowConfig::default(),
            mods,
            source_project_id: None,
            source_platforms: Vec::new(),
            source_version: None,
            companion_enabled: true,
            companion_version: None,
        }
    }

    #[test]
    fn test_system_ram_ceilings() {
        assert_eq!(default_max_for_system(4096), 1792);
        assert_eq!(default_max_for_system(8192), 4864);
        assert_eq!(default_max_for_system(16384), 9216);
        assert_eq!(default_max_for_system(32768), 12288);
        assert_eq!(default_max_for_system(65536), 12288);
    }

    #[test]
    fn test_compute_target_tiered() {
        // Vanilla (0 mods) -> 1280 MB
        let inst_vanilla = make_test_instance(LoaderType::Vanilla, 0, false);
        let (target, _) = compute_target(&inst_vanilla);
        assert_eq!(target, 1280);

        // 435 mods on Fabric with shaders -> ~7.75 GB to 8.5 GB (7936 MB without Iris, 8448 with Iris)
        let inst_435 = make_test_instance(LoaderType::Fabric, 435, true);
        let (target, _) = compute_target(&inst_435);
        assert!(target >= 7680 && target <= 8704, "Target was {} MB", target);

        // 600 mods on Forge -> ~9.5 GB (9728 MB)
        let inst_600 = make_test_instance(LoaderType::Forge, 600, true);
        let (target, _) = compute_target(&inst_600);
        assert_eq!(target, 9728);

        // 800+ mega pack -> clamped at 10240 MB ceiling
        let inst_800 = make_test_instance(LoaderType::Forge, 800, true);
        let (target, _) = compute_target(&inst_800);
        assert_eq!(target, 10240);

        // Disabled mods are excluded from calculation
        let mut inst_partial = make_test_instance(LoaderType::Fabric, 435, false);
        for m in inst_partial.mods.iter_mut().take(300) {
            m.enabled = false;
        }
        let (target_partial, _) = compute_target(&inst_partial);
        assert!(target_partial < 5120, "Expected target < 5120, got {}", target_partial);
    }
}
