// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherSettings {
    #[serde(default = "default_java_runtime")]
    pub java_runtime: String,
    pub default_memory_mb: u32,
    pub gc_preset: String,
    pub close_on_launch: bool,
    /// Pop the game's logs out into a separate window on launch. Pairs with
    /// `close_on_launch`: when the launcher hides to the tray, this gives the
    /// user a standalone window to watch output. Defaults to `false`.
    #[serde(default)]
    pub popout_logs: bool,
    pub auto_update: bool,
    /// Update release channel: "stable" or "experimental". Defaults to "stable".
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    pub discord_rpc: bool,
    pub show_snapshots: bool,
    /// Show the animated boot splash (turning logo cube + wordmark) when the
    /// launcher window first appears. Defaults to `true`; existing configs
    /// without the field opt in too.
    #[serde(default = "default_splash_screen")]
    pub splash_screen: bool,
    /// Show toast notifications when downloads start and complete.
    /// Defaults to `true`. When disabled, the Floating Dock downloads button
    /// displays an active download count badge instead.
    #[serde(default = "default_download_toasts")]
    pub download_toasts: bool,
    /// Active color theme ID ("neon-aurora", "emerald", "inferno", "stealth", "deep-ocean", "void").
    /// Defaults to "neon-aurora".
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Auto-hide the floating navigation dock across all screens by default.
    /// The dock reveals itself when hovering the bottom-center glowing trigger tab.
    /// Defaults to `true`.
    #[serde(default = "default_auto_hide_dock")]
    pub auto_hide_dock: bool,
    /// Position and orientation of the pagination dock indicator.
    /// Options: "bottom" (default, horizontal), "left" (vertical), "right" (vertical).
    #[serde(default = "default_pagination_position")]
    pub pagination_position: String,
    /// Desktop window size preset ("1100x720", "1280x800", "1440x900", "1600x1000").
    /// Defaults to "1100x720".
    #[serde(default = "default_window_size_preset")]
    pub window_size_preset: String,
    #[serde(default = "default_concurrent_downloads")]
    pub concurrent_downloads: u8,
    /// Maximum simultaneous disk writes. Separated from network concurrency so a slow
    /// disk doesn't starve fetches and vice versa.
    #[serde(default = "default_concurrent_writes")]
    pub concurrent_writes: u8,
    /// Maximum download speed in MB/s across all concurrent transfers.
    /// 0 means unlimited.
    #[serde(default = "default_download_speed_limit_mb")]
    pub download_speed_limit_mb: u32,
    pub mod_sources: Vec<String>,
    #[serde(default)]
    pub force_delete: bool,
    #[serde(default)]
    pub curseforge_api_key: String,
    #[serde(default)]
    pub modrinth_token: String,
    /// Whether the user has completed the first-run onboarding wizard. Defaults
    /// to `false` so existing users who upgrade also see it once (a five-second
    /// detour vs an indefinitely empty Library for new installs).
    #[serde(default)]
    pub onboarded: bool,
    /// User-selected Java executable per major version (e.g. `21 → "C:/Program
    /// Files/Eclipse Adoptium/jdk-21.0.2+13/bin/javaw.exe"`). Populated by the
    /// Settings → Resources → Java section. Falls back to auto-detection /
    /// auto-install when a major isn't pinned. Keys are major versions
    /// (8, 17, 21, 25, etc.).
    #[serde(default)]
    pub java_paths: HashMap<u8, String>,
    /// Instance IDs pinned to the sidebar as quick-launch shortcuts. Capped
    /// at 3 by the UI; we don't enforce server-side because anything saved
    /// here was authored by the launcher itself, not user input.
    #[serde(default)]
    pub sidebar_pinned_instances: Vec<String>,
    /// Global video settings applied to every instance's options.txt before launch.
    /// When a field is `None`, the launcher leaves that setting untouched in options.txt.
    #[serde(default)]
    pub video_settings: GlobalVideoSettings,

    /// In-game custom cape (companion mod). A single global toggle: the chosen
    /// library cape is rendered in-game on supported instances. The baked cape
    /// image itself lives at `<data>/ingame-cape.png` (binary, can't go in JSON);
    /// this just records the on/off state and which cape it is.
    #[serde(default)]
    pub ingame_cape: IngameCapeSettings,

    /// Automatically install Vermeil's companion mod on supported instances.
    /// When disabled, newly created or imported instances will not have the companion mod installed.
    #[serde(default = "default_enable_companion_mod")]
    pub enable_companion_mod: bool,

    /// User-customizable keyboard shortcuts. Map of action ID → key combo
    /// (e.g. `"Ctrl+P"`). Action IDs are defined in `launcher/src/lib/keybinds.ts`
    /// (frontend is the source of truth for the action registry; settings just
    /// store user overrides). Missing entries fall back to hardcoded defaults
    /// in the frontend, so a partial / empty map still works.
    #[serde(default)]
    pub keybinds: HashMap<String, String>,

    /// Adaptive RAM allocation. **Retained for settings-file compatibility
    /// only** — allocation is now always adaptive (see `services::memory`),
    /// so this flag no longer gates behaviour. Old configs still parse.
    #[serde(default)]
    pub adaptive_ram: bool,
    /// Minimum bound for adaptive allocation (MB). The formula's clamped
    /// output never goes below this. `0` means "use the system-derived
    /// default at runtime" — the actual computation lives in
    /// `services::memory::default_min_for_system`.
    #[serde(default)]
    pub adaptive_ram_min_mb: u32,
    /// Maximum bound for adaptive allocation (MB). Same `0`-as-sentinel
    /// pattern as min — `services::memory::default_max_for_system` produces
    /// a sensible value scaled to total system RAM.
    #[serde(default)]
    pub adaptive_ram_max_mb: u32,
    /// Last successful Google Cloud settings backup timestamp (ISO-8601).
    #[serde(default)]
    pub last_cloud_backup: Option<String>,
    /// Cumulative play time in seconds across all instances ever played in Vermeil.
    /// Preserved even when instances are deleted so global stats never reset.
    #[serde(default)]
    pub lifetime_play_seconds: u64,
    /// Timestamp (ISO-8601) of the most recent session launched across any instance.
    /// Preserved even when instances are deleted.
    #[serde(default)]
    pub last_active_at: Option<String>,
    /// Last seen application version. Used to detect transitions between builds
    /// (e.g. automatically ensuring experimental builds track the experimental channel).
    #[serde(default)]
    pub last_app_version: Option<String>,
}

/// Video settings that get written into each instance's options.txt before launch.
/// `None` means "don't override, leave whatever the user set in-game."
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GlobalVideoSettings {
    /// Max framerate (10–260). None = don't override.
    pub max_fps: Option<u32>,
    /// VSync on/off. None = don't override.
    pub vsync: Option<bool>,
    /// View bobbing on/off. None = don't override.
    pub view_bobbing: Option<bool>,
    /// GUI scale (0=auto, 1=small, 2=normal, 3=large, 4=huge). None = don't override.
    pub gui_scale: Option<u32>,
    /// FOV as the options.txt float value (-1.0 to 1.0). Degrees = 40*value + 70.
    /// So 0.0 = 70°, 1.0 = 110°, -1.0 = 30°. None = don't override.
    pub fov: Option<f64>,
    /// FOV Effects scale (0.0 to 1.0). Controls how much speed/slowness affects
    /// the field of view (accessibility setting: fovEffectScale). None = don't override.
    pub fov_effects: Option<f64>,
    /// Brightness/gamma (0.0=Moody to 1.0=Bright). Maps to `gamma` in options.txt.
    #[serde(default)]
    pub gamma: Option<f64>,
    /// Show directional sound subtitles on screen. Maps to `showSubtitles` in options.txt.
    #[serde(default)]
    pub show_subtitles: Option<bool>,
    /// Mouse sensitivity (0.0 to 1.0, where 0.5 is 100%). Maps to `mouseSensitivity` in options.txt.
    #[serde(default)]
    pub mouse_sensitivity: Option<f64>,
    /// Invert mouse Y-axis looking. Maps to `invertYMouse` in options.txt.
    #[serde(default)]
    pub invert_y_mouse: Option<bool>,
    /// Auto-jump when moving into blocks. Maps to `autoJump` in options.txt.
    #[serde(default)]
    pub auto_jump: Option<bool>,
    /// Weather/rain volume (0.0 to 1.0). Maps to `soundCategory_weather` in options.txt.
    #[serde(default)]
    pub weather_volume: Option<f64>,
    /// Hostile mobs volume (0.0 to 1.0). Maps to `soundCategory_hostile` in options.txt.
    #[serde(default)]
    pub hostile_volume: Option<f64>,
    /// Block interactions/placing volume (0.0 to 1.0). Maps to `soundCategory_block` in options.txt.
    #[serde(default)]
    pub block_volume: Option<f64>,
    /// Other players volume (0.0 to 1.0). Maps to `soundCategory_player` in options.txt.
    #[serde(default)]
    pub player_volume: Option<f64>,
    /// Master volume (0.0 to 1.0). Maps to `soundCategory_master` in options.txt.
    /// None = don't override.
    #[serde(default)]
    pub master_volume: Option<f64>,
    /// Music volume (0.0 to 1.0). Maps to `soundCategory_music` in options.txt.
    /// None = don't override.
    #[serde(default)]
    pub music_volume: Option<f64>,
    /// Game window width in pixels. Applied to all instances on launch.
    /// None = use 1280 (launcher default).
    #[serde(default)]
    pub window_width: Option<u32>,
    /// Game window height in pixels. Applied to all instances on launch.
    /// None = use 720 (launcher default).
    #[serde(default)]
    pub window_height: Option<u32>,
    /// Launch the game window maximized (fills screen, but not fullscreen).
    #[serde(default)]
    pub start_maximized: Option<bool>,
}

fn default_java_runtime() -> String { "adoptium".to_string() }
fn default_concurrent_downloads() -> u8 { 10 }
fn default_concurrent_writes() -> u8 { 10 }
fn default_download_speed_limit_mb() -> u32 { 0 }
fn default_splash_screen() -> bool { true }
fn default_download_toasts() -> bool { true }
fn default_theme() -> String { "neon-aurora".to_string() }
fn default_auto_hide_dock() -> bool { true }
fn default_pagination_position() -> String { "bottom".to_string() }
fn default_window_size_preset() -> String { "1100x720".to_string() }
fn default_enable_companion_mod() -> bool { true }
fn default_update_channel() -> String {
    if env!("CARGO_PKG_VERSION").contains('-') {
        "experimental".to_string()
    } else {
        "stable".to_string()
    }
}

/// In-game custom cape state (companion mod). The baked cape image lives at
/// `<data>/ingame-cape.png`; this is just the toggle + which library cape.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IngameCapeSettings {
    /// Whether the in-game cape is shown on supported instances.
    #[serde(default)]
    pub enabled: bool,
    /// Id of the library cape currently set for in-game display.
    #[serde(default)]
    pub cape_id: Option<String>,
    /// Per-frame duration for an animated cape (ms). `None` for a static cape.
    #[serde(default)]
    pub frame_time_ms: Option<u32>,
}

impl LauncherSettings {
    /// Resolves logical width and height (w, h) for a named window preset.
    /// Falls back to 1100.0 x 720.0 if the preset is unrecognized.
    pub fn parse_window_size_preset(preset: &str) -> (f64, f64) {
        match preset {
            "1100x720" => (1100.0, 720.0),
            "1280x800" => (1280.0, 800.0),
            "1440x900" => (1440.0, 900.0),
            "1600x1000" => (1600.0, 1000.0),
            _ => (1100.0, 720.0),
        }
    }
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            java_runtime: default_java_runtime(),
            default_memory_mb: 4096,
            gc_preset: "g1gc".to_string(),
            close_on_launch: false,
            popout_logs: false,
            auto_update: true,
            update_channel: default_update_channel(),
            discord_rpc: false,
            show_snapshots: false,
            splash_screen: true,
            download_toasts: true,
            theme: default_theme(),
            auto_hide_dock: true,
            pagination_position: default_pagination_position(),
            window_size_preset: default_window_size_preset(),
            concurrent_downloads: default_concurrent_downloads(),
            concurrent_writes: default_concurrent_writes(),
            download_speed_limit_mb: default_download_speed_limit_mb(),
            mod_sources: vec!["modrinth".to_string(), "curseforge".to_string()],
            force_delete: false,
            curseforge_api_key: String::new(),
            modrinth_token: String::new(),
            onboarded: false,
            java_paths: HashMap::new(),
            sidebar_pinned_instances: Vec::new(),
            video_settings: GlobalVideoSettings::default(),
            keybinds: HashMap::new(),
            ingame_cape: IngameCapeSettings::default(),
            enable_companion_mod: default_enable_companion_mod(),
            adaptive_ram: false,
            adaptive_ram_min_mb: 0,
            adaptive_ram_max_mb: 0,
            last_cloud_backup: None,
            lifetime_play_seconds: 0,
            last_active_at: None,
            last_app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        }
    }
}
