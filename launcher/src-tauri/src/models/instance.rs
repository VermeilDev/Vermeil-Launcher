// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderType {
    Vanilla,
    Fabric,
    Forge,
    Neoforge,
    Quilt,
}

impl LoaderType {
    /// Lowercase loader id used by Modrinth's API and our own URL building.
    /// Avoids `format!("{:?}", x).to_lowercase()` scattered across services.
    pub fn as_str(&self) -> &'static str {
        match self {
            LoaderType::Vanilla => "vanilla",
            LoaderType::Fabric => "fabric",
            LoaderType::Forge => "forge",
            LoaderType::Neoforge => "neoforge",
            LoaderType::Quilt => "quilt",
        }
    }

    /// Human-friendly capitalized loader name (e.g. for UI, logs, Discord RPC).
    pub fn display_name(&self) -> &'static str {
        match self {
            LoaderType::Vanilla => "Vanilla",
            LoaderType::Fabric => "Fabric",
            LoaderType::Forge => "Forge",
            LoaderType::Neoforge => "NeoForge",
            LoaderType::Quilt => "Quilt",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderConfig {
    #[serde(rename = "type")]
    pub loader_type: LoaderType,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaConfig {
    pub override_path: Option<String>,
    pub memory_max_mb: u32,
    pub memory_min_mb: u32,
    pub extra_args: Vec<String>,
    /// Per-instance opt-out for adaptive RAM. When `true`, the launcher skips
    /// the automatic formula for this instance and uses the manual
    /// `memory_max_mb` value verbatim. Toggled by the per-instance "Automatic
    /// memory" switch on the instance's Settings tab. Defaults to `false`
    /// (adaptive on).
    #[serde(default)]
    pub adaptive_override: bool,
}

impl Default for JavaConfig {
    fn default() -> Self {
        Self {
            override_path: None,
            memory_max_mb: 4096,
            memory_min_mb: 512,
            extra_args: Vec::new(),
            adaptive_override: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    pub width: u32,
    pub height: u32,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModEntry {
    pub id: String,
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    pub filename: String,
    /// Human-readable content version (Modrinth `version_number`, e.g.
    /// "0.6.0+mc1.21"; CurseForge file display name). Populated at install time
    /// for mods added directly from Browse. `None` for modpack-bundled mods,
    /// manually-added jars, and entries installed before this field existed —
    /// the Installed card simply omits the version tag in that case.
    #[serde(default)]
    pub version_number: Option<String>,
    pub enabled: bool,
    /// Held at this exact version because another installed mod requires it.
    /// The update checker skips pinned entries and `apply_update` refuses them,
    /// so automatic resolution can't move a version its parent depends on.
    ///
    /// Defaulted rather than required: this field now changes behavior, and a
    /// hand-edited or externally-produced instance.json missing the key would
    /// otherwise fail to deserialize the whole instance rather than just this
    /// flag.
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// Absolute path to a locally-cached copy of `icon_url`. Populated by the
    /// install flow via `services::icon_cache`. The frontend prefers this over
    /// `icon_url` because it's served via Tauri's `asset://` protocol — no
    /// network hit, works offline, no CDN cache-bust surprises.
    #[serde(default)]
    pub local_icon_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_category")]
    pub category: String,
    /// Primary author display name (Modrinth search `author` or first entry
    /// of CurseForge `authors[]`). Cached at install time so the Installed
    /// list and download history can show "by Author" without a fresh API
    /// call.
    #[serde(default)]
    pub author: Option<String>,
}

fn default_category() -> String { "mod".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub icon: String,
    pub icon_custom: Option<String>,
    pub created_at: String,
    pub last_played: Option<String>,
    pub total_play_seconds: u64,
    pub game_version: String,
    pub loader: LoaderConfig,
    pub java: JavaConfig,
    pub window: WindowConfig,
    pub mods: Vec<ModEntry>,
    /// Modrinth or CurseForge project ID if this instance was created from a modpack
    #[serde(default)]
    pub source_project_id: Option<String>,
    /// Which platform(s) this modpack is available on. `["modrinth"]`,
    /// `["curseforge"]`, or both if the same pack is published on both.
    /// Empty for custom-created instances. Populated at install time and
    /// extended during the post-install enrichment pass when a
    /// cross-platform match is found.
    #[serde(default)]
    pub source_platforms: Vec<String>,

    /// The modpack's own version label (Modrinth mrpack `versionId`, or the
    /// CurseForge manifest `version`), when this instance was installed from a
    /// modpack. Shown as a badge on the Library card. `None` for custom
    /// instances and for modpacks whose manifest didn't declare a version.
    #[serde(default)]
    pub source_version: Option<String>,
    /// Per-instance toggle for the Vermeil companion mod. When true (default),
    /// the launcher keeps the managed companion jar active on this instance;
    /// when false, the jar is disabled (renamed `.disabled`, not deleted) so the
    /// mod's in-game features don't run here. Combined with the support gate
    /// (`is_supported`) — the instance must be a supported loader + MC version.
    /// Defaults true so the field is opt-out: every existing instance loaded
    /// without it keeps the companion on.
    #[serde(default = "default_true")]
    pub companion_enabled: bool,
    #[serde(default)]
    pub companion_version: Option<String>,
}

fn default_true() -> bool { true }

/// Lightweight projection of [`Instance`] for library listing. Carries
/// `mod_count` instead of the full `mods: Vec<ModEntry>` so
/// `list_instances` doesn't push megabytes of mod metadata across IPC
/// when the frontend only needs the count for a badge.
#[derive(Debug, Clone, Serialize)]
pub struct InstanceSummary {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub icon: String,
    pub icon_custom: Option<String>,
    pub created_at: String,
    pub last_played: Option<String>,
    pub total_play_seconds: u64,
    pub game_version: String,
    pub loader: LoaderConfig,
    pub java: JavaConfig,
    pub window: WindowConfig,
    pub mod_count: usize,
    pub source_project_id: Option<String>,
    pub source_platforms: Vec<String>,
    pub source_version: Option<String>,
    pub companion_enabled: bool,
    #[serde(default)]
    pub companion_version: Option<String>,
}

impl InstanceSummary {
    pub fn from_instance(inst: Instance) -> Self {
        let mod_count = inst.mods.len();
        Self {
            format_version: inst.format_version,
            id: inst.id,
            name: inst.name,
            icon: inst.icon,
            icon_custom: inst.icon_custom,
            created_at: inst.created_at,
            last_played: inst.last_played,
            total_play_seconds: inst.total_play_seconds,
            game_version: inst.game_version,
            loader: inst.loader,
            java: inst.java,
            window: inst.window,
            mod_count,
            source_project_id: inst.source_project_id,
            source_platforms: inst.source_platforms,
            source_version: inst.source_version,
            companion_enabled: inst.companion_enabled,
            companion_version: inst.companion_version,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInstanceConfig {
    pub name: String,
    pub game_version: String,
    pub loader_type: LoaderType,
    pub loader_version: Option<String>,
    pub icon: Option<String>,
    pub memory_max_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickServerEntry {
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub linked_instance_id: Option<String>,
    #[serde(default)]
    pub last_ping_ms: Option<u64>,
    #[serde(default)]
    pub last_ping_online: Option<u32>,
    #[serde(default)]
    pub last_ping_max: Option<u32>,
    #[serde(default)]
    pub last_ping_version: Option<String>,
    #[serde(default)]
    pub last_ping_motd: Option<String>,
    #[serde(default)]
    pub favicon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerPingInfo {
    pub address: String,
    pub is_online: bool,
    pub ping_ms: Option<u64>,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    pub version_name: Option<String>,
    pub protocol: Option<i32>,
    pub motd: Option<String>,
    pub favicon: Option<String>,
}
