// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Bidirectional bridge between the launcher's `GlobalVideoSettings` and a
//! Minecraft instance's `options.txt`.
//!
//! Minecraft owns `options.txt` — it reads it at start and rewrites it on quit.
//! The launcher mirrors a chosen subset of video settings into it:
//!
//! - **Write (pre-launch)** — [`apply`] writes every mirrored key with a concrete
//!   value (the user's setting, or Mojang's vanilla default when unset), so the
//!   launcher and game always agree on launch. There is no "leave alone" state:
//!   the launcher is authoritative at launch time.
//! - **Read (post-exit)** — [`read_back`] parses the file the game just saved and
//!   returns the values for the mirrored keys, so in-game changes flow back into
//!   the launcher. Together these make the settings round-trip.
//!
//! One key map lives here so the write and read directions can never drift apart
//! (a key written but not read, or vice versa, would silently break the
//! round-trip for that setting).
//!
//! `fovEffectScale` is special: it only exists natively from Minecraft 1.16. On
//! older versions the companion mod backports it, reading the value from its own
//! `vermeil-settings.json` (see [`crate::services::companion_settings`]) — not
//! from `options.txt`. The launcher still writes the `fovEffectScale` line here
//! for 1.16+ (where the game reads it natively); on older versions vanilla
//! ignores the unknown key.

use crate::models::settings::GlobalVideoSettings;

/// Mojang's vanilla defaults for each mirrored key. Used when the launcher has
/// no stored value yet, so we still write a concrete line (matching what a fresh
/// `options.txt` would contain) rather than nothing. Sourced from the Minecraft
/// Wiki options.txt reference.
pub mod defaults {
    pub const MAX_FPS: u32 = 120;
    pub const VSYNC: bool = true;
    pub const VIEW_BOBBING: bool = true;
    pub const GUI_SCALE: u32 = 0; // 0 = Auto
    pub const FOV: f64 = 0.0; // 0.0 = 70 degrees
    pub const FOV_EFFECTS: f64 = 1.0;
    pub const GAMMA: f64 = 1.0; // 1.0 = Bright
    pub const SHOW_SUBTITLES: bool = false;
    pub const MOUSE_SENSITIVITY: f64 = 0.5; // 0.5 = 100%
    pub const INVERT_Y_MOUSE: bool = false;
    pub const AUTO_JUMP: bool = false;
    pub const MASTER_VOLUME: f64 = 1.0;
    pub const MUSIC_VOLUME: f64 = 1.0;
    pub const WEATHER_VOLUME: f64 = 1.0;
    pub const HOSTILE_VOLUME: f64 = 1.0;
    pub const BLOCK_VOLUME: f64 = 1.0;
    pub const PLAYER_VOLUME: f64 = 1.0;
}

/// Resolve each mirrored field to a concrete value, falling back to the vanilla
/// default when the launcher has no stored value. Centralises the "no Default
/// state — always a real value" rule so both the writer and the frontend agree.
fn resolved(vs: &GlobalVideoSettings) -> Resolved {
    Resolved {
        max_fps: vs.max_fps.unwrap_or(defaults::MAX_FPS),
        vsync: vs.vsync.unwrap_or(defaults::VSYNC),
        view_bobbing: vs.view_bobbing.unwrap_or(defaults::VIEW_BOBBING),
        gui_scale: vs.gui_scale.unwrap_or(defaults::GUI_SCALE),
        fov: vs.fov.unwrap_or(defaults::FOV),
        fov_effects: vs.fov_effects.unwrap_or(defaults::FOV_EFFECTS),
        gamma: vs.gamma.unwrap_or(defaults::GAMMA),
        show_subtitles: vs.show_subtitles.unwrap_or(defaults::SHOW_SUBTITLES),
        mouse_sensitivity: vs.mouse_sensitivity.unwrap_or(defaults::MOUSE_SENSITIVITY),
        invert_y_mouse: vs.invert_y_mouse.unwrap_or(defaults::INVERT_Y_MOUSE),
        auto_jump: vs.auto_jump.unwrap_or(defaults::AUTO_JUMP),
        master_volume: vs.master_volume.unwrap_or(defaults::MASTER_VOLUME),
        music_volume: vs.music_volume.unwrap_or(defaults::MUSIC_VOLUME),
        weather_volume: vs.weather_volume.unwrap_or(defaults::WEATHER_VOLUME),
        hostile_volume: vs.hostile_volume.unwrap_or(defaults::HOSTILE_VOLUME),
        block_volume: vs.block_volume.unwrap_or(defaults::BLOCK_VOLUME),
        player_volume: vs.player_volume.unwrap_or(defaults::PLAYER_VOLUME),
    }
}

struct Resolved {
    max_fps: u32,
    vsync: bool,
    view_bobbing: bool,
    gui_scale: u32,
    fov: f64,
    fov_effects: f64,
    gamma: f64,
    show_subtitles: bool,
    mouse_sensitivity: f64,
    invert_y_mouse: bool,
    auto_jump: bool,
    master_volume: f64,
    music_volume: f64,
    weather_volume: f64,
    hostile_volume: f64,
    block_volume: f64,
    player_volume: f64,
}

fn bool_str(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

/// Write every mirrored video setting into `content` (the text of an
/// `options.txt`), replacing existing lines in place or appending new ones, and
/// return the updated text. Always writes concrete values in a single streaming pass.
pub fn apply(content: &str, vs: &GlobalVideoSettings) -> String {
    let r = resolved(vs);

    let entries: [(&str, String); 17] = [
        ("maxFps", r.max_fps.to_string()),
        ("enableVsync", bool_str(r.vsync).to_string()),
        ("bobView", bool_str(r.view_bobbing).to_string()),
        ("guiScale", r.gui_scale.to_string()),
        ("fov", format!("{:.6}", r.fov)),
        ("fovEffectScale", format!("{:.6}", r.fov_effects)),
        ("gamma", format!("{:.6}", r.gamma)),
        ("showSubtitles", bool_str(r.show_subtitles).to_string()),
        ("mouseSensitivity", format!("{:.6}", r.mouse_sensitivity)),
        ("invertYMouse", bool_str(r.invert_y_mouse).to_string()),
        ("autoJump", bool_str(r.auto_jump).to_string()),
        ("soundCategory_master", format!("{:.6}", r.master_volume)),
        ("soundCategory_music", format!("{:.6}", r.music_volume)),
        ("soundCategory_weather", format!("{:.6}", r.weather_volume)),
        ("soundCategory_hostile", format!("{:.6}", r.hostile_volume)),
        ("soundCategory_block", format!("{:.6}", r.block_volume)),
        ("soundCategory_player", format!("{:.6}", r.player_volume)),
    ];

    let mut written = [false; 17];
    let mut out = String::with_capacity(content.len() + 512);

    for line in content.lines() {
        if let Some((k, _)) = line.split_once(':') {
            if let Some(idx) = entries.iter().position(|(ek, _)| *ek == k) {
                if !written[idx] {
                    out.push_str(&format!("{}:{}\n", entries[idx].0, entries[idx].1));
                    written[idx] = true;
                }
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }

    for (idx, (k, v)) in entries.iter().enumerate() {
        if !written[idx] {
            out.push_str(&format!("{}:{}\n", k, v));
        }
    }

    out
}

/// Parse `content` (the text of an `options.txt`) and return a
/// `GlobalVideoSettings` whose mirrored fields are populated from the file.
/// Fields whose key is absent or unparseable are left `None`, so the caller can
/// merge only what the game actually wrote and keep its prior value otherwise.
pub fn read_back(content: &str) -> GlobalVideoSettings {
    let mut vs = GlobalVideoSettings::default();
    for line in content.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k {
                "maxFps" => vs.max_fps = v.parse().ok(),
                "enableVsync" => vs.vsync = parse_bool(v),
                "bobView" => vs.view_bobbing = parse_bool(v),
                "guiScale" => vs.gui_scale = v.parse().ok(),
                "fov" => vs.fov = v.parse().ok(),
                "fovEffectScale" => vs.fov_effects = v.parse().ok(),
                "gamma" => vs.gamma = v.parse().ok(),
                "showSubtitles" => vs.show_subtitles = parse_bool(v),
                "mouseSensitivity" => vs.mouse_sensitivity = v.parse().ok(),
                "invertYMouse" => vs.invert_y_mouse = parse_bool(v),
                "autoJump" => vs.auto_jump = parse_bool(v),
                "soundCategory_master" => vs.master_volume = v.parse().ok(),
                "soundCategory_music" => vs.music_volume = v.parse().ok(),
                "soundCategory_weather" => vs.weather_volume = v.parse().ok(),
                "soundCategory_hostile" => vs.hostile_volume = v.parse().ok(),
                "soundCategory_block" => vs.block_volume = v.parse().ok(),
                "soundCategory_player" => vs.player_volume = v.parse().ok(),
                _ => {}
            }
        }
    }
    vs
}

/// Merge the values the game wrote (`from_game`) into `target`, overwriting only
/// the mirrored fields that the game actually provided (a `Some`). Window
/// settings in `from_game` are always `None`, so `target` keeps its own.
pub fn merge_into(target: &mut GlobalVideoSettings, from_game: GlobalVideoSettings) {
    if from_game.max_fps.is_some() { target.max_fps = from_game.max_fps; }
    if from_game.vsync.is_some() { target.vsync = from_game.vsync; }
    if from_game.view_bobbing.is_some() { target.view_bobbing = from_game.view_bobbing; }
    if from_game.gui_scale.is_some() { target.gui_scale = from_game.gui_scale; }
    if from_game.fov.is_some() { target.fov = from_game.fov; }
    if from_game.fov_effects.is_some() { target.fov_effects = from_game.fov_effects; }
    if from_game.gamma.is_some() { target.gamma = from_game.gamma; }
    if from_game.show_subtitles.is_some() { target.show_subtitles = from_game.show_subtitles; }
    if from_game.mouse_sensitivity.is_some() { target.mouse_sensitivity = from_game.mouse_sensitivity; }
    if from_game.invert_y_mouse.is_some() { target.invert_y_mouse = from_game.invert_y_mouse; }
    if from_game.auto_jump.is_some() { target.auto_jump = from_game.auto_jump; }
    if from_game.master_volume.is_some() { target.master_volume = from_game.master_volume; }
    if from_game.music_volume.is_some() { target.music_volume = from_game.music_volume; }
    if from_game.weather_volume.is_some() { target.weather_volume = from_game.weather_volume; }
    if from_game.hostile_volume.is_some() { target.hostile_volume = from_game.hostile_volume; }
    if from_game.block_volume.is_some() { target.block_volume = from_game.block_volume; }
    if from_game.player_volume.is_some() { target.player_volume = from_game.player_volume; }
}

fn parse_bool(v: &str) -> Option<bool> {
    match v {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Return the value of `key` in an `options.txt` body, if present. Used in unit tests.
#[cfg(test)]
pub fn line_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_round_trips_every_field() {
        let vs = GlobalVideoSettings {
            max_fps: Some(60),
            vsync: Some(false),
            view_bobbing: Some(false),
            gui_scale: Some(2),
            fov: Some(0.5),
            fov_effects: Some(0.25),
            gamma: Some(0.8),
            show_subtitles: Some(true),
            mouse_sensitivity: Some(0.65),
            invert_y_mouse: Some(true),
            auto_jump: Some(true),
            master_volume: Some(0.8),
            music_volume: Some(0.1),
            weather_volume: Some(0.4),
            hostile_volume: Some(0.7),
            block_volume: Some(0.9),
            player_volume: Some(0.75),
            window_width: None,
            window_height: None,
            start_maximized: None,
        };
        let written = apply("", &vs);
        let back = read_back(&written);
        assert_eq!(back.max_fps, Some(60));
        assert_eq!(back.vsync, Some(false));
        assert_eq!(back.view_bobbing, Some(false));
        assert_eq!(back.gui_scale, Some(2));
        assert_eq!(back.fov, Some(0.5));
        assert_eq!(back.fov_effects, Some(0.25));
        assert_eq!(back.gamma, Some(0.8));
        assert_eq!(back.show_subtitles, Some(true));
        assert_eq!(back.mouse_sensitivity, Some(0.65));
        assert_eq!(back.invert_y_mouse, Some(true));
        assert_eq!(back.auto_jump, Some(true));
        assert_eq!(back.master_volume, Some(0.8));
        assert_eq!(back.music_volume, Some(0.1));
        assert_eq!(back.weather_volume, Some(0.4));
        assert_eq!(back.hostile_volume, Some(0.7));
        assert_eq!(back.block_volume, Some(0.9));
        assert_eq!(back.player_volume, Some(0.75));
    }

    #[test]
    fn unset_fields_write_vanilla_defaults() {
        let written = apply("", &GlobalVideoSettings::default());
        let back = read_back(&written);
        assert_eq!(back.max_fps, Some(defaults::MAX_FPS));
        assert_eq!(back.vsync, Some(defaults::VSYNC));
        assert_eq!(back.fov_effects, Some(defaults::FOV_EFFECTS));
        assert_eq!(back.gamma, Some(defaults::GAMMA));
        assert_eq!(back.show_subtitles, Some(defaults::SHOW_SUBTITLES));
        assert_eq!(back.mouse_sensitivity, Some(defaults::MOUSE_SENSITIVITY));
        assert_eq!(back.auto_jump, Some(defaults::AUTO_JUMP));
    }

    #[test]
    fn fov_key_does_not_collide_with_fov_effect_scale() {
        // Both keys present; reading `fov` must not pick up `fovEffectScale`.
        let body = "fovEffectScale:0.500000\nfov:1.000000\n";
        assert_eq!(line_value(body, "fov"), Some("1.000000".to_string()));
        assert_eq!(line_value(body, "fovEffectScale"), Some("0.500000".to_string()));
    }

    #[test]
    fn apply_replaces_existing_line_in_place_and_preserves_others() {
        let existing = "maxFps:30\nrenderDistance:8\nfov:0.000000\n";
        let vs = GlobalVideoSettings { max_fps: Some(240), ..Default::default() };
        let out = apply(existing, &vs);
        // The unrelated key the launcher doesn't manage is preserved.
        assert!(out.contains("renderDistance:8"));
        // maxFps was replaced, not duplicated.
        assert_eq!(out.matches("maxFps:").count(), 1);
        assert_eq!(line_value(&out, "maxFps"), Some("240".to_string()));
    }

    #[test]
    fn read_back_leaves_absent_keys_none() {
        let back = read_back("renderDistance:8\n");
        assert_eq!(back.max_fps, None);
        assert_eq!(back.fov, None);
    }
}
