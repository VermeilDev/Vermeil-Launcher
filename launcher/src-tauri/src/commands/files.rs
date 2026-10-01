// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::util::paths;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Serialize)]
pub struct WorldEntry {
    pub name: String,
    pub folder_name: String,
    pub size_mb: f64,
    pub last_played: String,
    pub game_mode: String,
    /// The world's `icon.png` (the in-game world thumbnail) as a
    /// `data:image/png;base64,...` URL, or `None` when the world has no icon
    /// yet. Re-read on every listing so a changed icon shows up automatically.
    pub icon: Option<String>,
    /// Total play time in seconds for this world.
    pub play_time_seconds: u64,
}

#[derive(Serialize, Clone)]
pub struct ScreenshotEntry {
    pub path: String,
    pub file_name: String,
    pub instance_id: String,
    pub instance_name: String,
    pub modified_ms: u64,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn list_instance_files(instance_id: String, sub_path: Option<String>) -> Result<Vec<FileEntry>, String> {
    let base = paths::instances_dir().join(&instance_id).join(".minecraft");
    let dir = match &sub_path {
        Some(p) => base.join(p),
        None => base,
    };

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in read_dir.flatten() {
        let meta = entry.metadata().unwrap_or_else(|_| fs::metadata(entry.path()).unwrap());
        let modified = meta.modified()
            .map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().strip_prefix(paths::instances_dir().join(&instance_id).join(".minecraft"))
                .unwrap_or(entry.path().as_path())
                .to_string_lossy().to_string().replace('\\', "/"),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn list_instance_worlds(instance_id: String) -> Result<Vec<WorldEntry>, String> {
    let saves_dir = paths::instances_dir().join(&instance_id).join(".minecraft").join("saves");

    if !saves_dir.exists() {
        return Ok(Vec::new());
    }

    let mut worlds = Vec::new();

    for entry in fs::read_dir(&saves_dir).map_err(|e| e.to_string())?.flatten() {
        if !entry.path().is_dir() { continue; }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let world_dir = entry.path();

        let level_info = parse_level_dat(&world_dir);
        let name = level_info.name.unwrap_or_else(|| folder_name.clone());
        let game_mode = level_info.game_mode;

        // Player playtime from stats/*.json or level.dat Time ticks
        let play_time_seconds = read_player_play_time(&world_dir)
            .unwrap_or(level_info.play_time_seconds);

        // World thumbnail (saves/<world>/icon.png), inlined as a data URL.
        let icon = read_world_icon(&world_dir);

        // Calculate directory size
        let size = dir_size(&world_dir);
        let size_mb = size as f64 / (1024.0 * 1024.0);

        // Last played from level.dat or folder mtime
        let last_played = level_info.last_played.unwrap_or_else(|| {
            fs::metadata(&world_dir)
                .and_then(|m| m.modified())
                .map(|t| {
                    let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
                .unwrap_or_default()
        });

        worlds.push(WorldEntry {
            name,
            folder_name,
            size_mb: (size_mb * 10.0).round() / 10.0,
            last_played,
            game_mode,
            icon,
            play_time_seconds,
        });
    }

    // Sort by last played (most recent first)
    worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));

    Ok(worlds)
}

fn dir_size(path: &PathBuf) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata().unwrap_or_else(|_| fs::metadata(entry.path()).unwrap());
            if meta.is_dir() {
                size += dir_size(&entry.path());
            } else {
                size += meta.len();
            }
        }
    }
    size
}

/// Read a world's `icon.png` (the in-game thumbnail) and return it as a
/// `data:image/png;base64,...` URL. Returns `None` when the world has no icon
/// (never opened, or a dimension-only folder). Icons are small (64×64), so
/// inlining is cheap and avoids exposing the saves path over the asset
/// protocol.
fn read_world_icon(world_dir: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let bytes = fs::read(world_dir.join("icon.png")).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

struct LevelDatInfo {
    name: Option<String>,
    play_time_seconds: u64,
    game_mode: String,
    last_played: Option<String>,
}

/// Parse `level.dat` once to extract display name (`LevelName`), world playtime
/// (`Time` tag ticks / 20), game mode (`GameType` / `hardcore`), and last played timestamp (`LastPlayed`).
fn parse_level_dat(world_dir: &std::path::Path) -> LevelDatInfo {
    use std::io::Read;
    let mut info = LevelDatInfo {
        name: None,
        play_time_seconds: 0,
        game_mode: "Survival".to_string(),
        last_played: None,
    };

    let Ok(raw) = fs::read(world_dir.join("level.dat")) else {
        return info;
    };
    let mut data = Vec::new();
    if flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut data).is_err() {
        return info;
    }

    // 1. LevelName: TAG_String (0x08) · length 9 · "LevelName"
    const NAME_SIG: &[u8] = b"\x08\x00\x09LevelName";
    if let Some(pos) = data.windows(NAME_SIG.len()).position(|w| w == NAME_SIG) {
        let len_at = pos + NAME_SIG.len();
        if len_at + 2 <= data.len() {
            let len = u16::from_be_bytes([data[len_at], data[len_at + 1]]) as usize;
            let start = len_at + 2;
            if start + len <= data.len() {
                if let Ok(s) = std::str::from_utf8(&data[start..start + len]) {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        info.name = Some(trimmed.to_string());
                    }
                }
            }
        }
    }

    // 2. Time: TAG_Long (0x04) · length 4 · "Time" (world ticks since creation)
    const TIME_SIG: &[u8] = b"\x04\x00\x04Time";
    if let Some(pos) = data.windows(TIME_SIG.len()).position(|w| w == TIME_SIG) {
        let val_at = pos + TIME_SIG.len();
        if val_at + 8 <= data.len() {
            if let Ok(bytes) = data[val_at..val_at + 8].try_into() {
                let ticks = i64::from_be_bytes(bytes);
                if ticks > 0 {
                    info.play_time_seconds = (ticks as u64) / 20;
                }
            }
        }
    }

    // 3. GameType: TAG_Int (0x03) · length 8 · "GameType" + hardcore: TAG_Byte (0x01)
    let mut is_hardcore = false;
    const HC_SIG: &[u8] = b"\x01\x00\x08hardcore";
    if let Some(pos) = data.windows(HC_SIG.len()).position(|w| w == HC_SIG) {
        let val_at = pos + HC_SIG.len();
        if val_at < data.len() && data[val_at] == 1 {
            is_hardcore = true;
        }
    }

    if is_hardcore {
        info.game_mode = "Hardcore".to_string();
    } else {
        const GT_SIG: &[u8] = b"\x03\x00\x08GameType";
        if let Some(pos) = data.windows(GT_SIG.len()).position(|w| w == GT_SIG) {
            let val_at = pos + GT_SIG.len();
            if val_at + 4 <= data.len() {
                if let Ok(bytes) = data[val_at..val_at + 4].try_into() {
                    let gt = i32::from_be_bytes(bytes);
                    info.game_mode = match gt {
                        0 => "Survival".to_string(),
                        1 => "Creative".to_string(),
                        2 => "Adventure".to_string(),
                        3 => "Spectator".to_string(),
                        _ => "Survival".to_string(),
                    };
                }
            }
        }
    }

    // 4. LastPlayed: TAG_Long (0x04) · length 10 · "LastPlayed" (epoch millis)
    const LP_SIG: &[u8] = b"\x04\x00\x0aLastPlayed";
    if let Some(pos) = data.windows(LP_SIG.len()).position(|w| w == LP_SIG) {
        let val_at = pos + LP_SIG.len();
        if val_at + 8 <= data.len() {
            if let Ok(bytes) = data[val_at..val_at + 8].try_into() {
                let millis = i64::from_be_bytes(bytes);
                if millis > 0 {
                    if let Some(dt) = chrono::DateTime::from_timestamp_millis(millis) {
                        info.last_played = Some(dt.to_rfc3339());
                    }
                }
            }
        }
    }

    info
}

/// Read player playtime ticks from `saves/<world>/stats/*.json` if available.
/// Returns playtime in seconds.
fn read_player_play_time(world_dir: &std::path::Path) -> Option<u64> {
    let stats_dir = world_dir.join("stats");
    if !stats_dir.is_dir() {
        return None;
    }
    let mut max_ticks: u64 = 0;
    if let Ok(entries) = fs::read_dir(stats_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                        // Modern 1.13+: stats["minecraft:custom"]["minecraft:play_time"] or "minecraft:total_world_time"
                        if let Some(ticks) = v.pointer("/stats/minecraft:custom/minecraft:play_time").and_then(|n| n.as_u64()) {
                            max_ticks = max_ticks.max(ticks);
                        } else if let Some(ticks) = v.pointer("/stats/minecraft:custom/minecraft:total_world_time").and_then(|n| n.as_u64()) {
                            max_ticks = max_ticks.max(ticks);
                        }
                        // Legacy 1.7-1.12: stat.playOneMinute
                        if let Some(ticks) = v.get("stat.playOneMinute").and_then(|n| n.as_u64()) {
                            max_ticks = max_ticks.max(ticks);
                        }
                    }
                }
            }
        }
    }
    if max_ticks > 0 {
        Some(max_ticks / 20)
    } else {
        None
    }
}

#[tauri::command]
pub async fn open_instance_folder(instance_id: String, sub_path: Option<String>) -> Result<(), String> {
    let base = paths::instances_dir().join(&instance_id).join(".minecraft");
    let dir = match &sub_path {
        Some(p) => base.join(p),
        None => base,
    };

    if dir.exists() {
        let _ = open::that(&dir);
    }
    Ok(())
}

fn strip_extended_prefix(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

#[tauri::command]
pub async fn get_recent_screenshots(limit: Option<usize>) -> Result<Vec<ScreenshotEntry>, String> {
    let instances_base = paths::instances_dir();
    if !instances_base.exists() {
        return Ok(Vec::new());
    }

    let mut screenshots = Vec::new();

    let read_instances = match fs::read_dir(&instances_base) {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()),
    };

    for inst_entry in read_instances.flatten() {
        let inst_path = inst_entry.path();
        if !inst_path.is_dir() {
            continue;
        }

        let instance_id = inst_entry.file_name().to_string_lossy().to_string();

        let instance_name = {
            let meta_path = inst_path.join("instance.json");
            if meta_path.exists() {
                fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                    .unwrap_or_else(|| instance_id.clone())
            } else {
                instance_id.clone()
            }
        };

        let screenshots_dir = inst_path.join(".minecraft").join("screenshots");
        if !screenshots_dir.exists() || !screenshots_dir.is_dir() {
            continue;
        }

        if let Ok(rd_shots) = fs::read_dir(&screenshots_dir) {
            for shot_entry in rd_shots.flatten() {
                let shot_path = shot_entry.path();
                if !shot_path.is_file() {
                    continue;
                }

                let ext = shot_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if ext != "png" && ext != "jpg" && ext != "jpeg" {
                    continue;
                }

                let file_name = shot_entry.file_name().to_string_lossy().to_string();
                let meta = match shot_entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let modified_ms = meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                let path_str = strip_extended_prefix(&shot_path.to_string_lossy());

                screenshots.push(ScreenshotEntry {
                    path: path_str,
                    file_name,
                    instance_id: instance_id.clone(),
                    instance_name: instance_name.clone(),
                    modified_ms,
                    size_bytes: meta.len(),
                });
            }
        }
    }

    screenshots.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));

    let max_count = limit.unwrap_or(50);
    if screenshots.len() > max_count {
        screenshots.truncate(max_count);
    }

    Ok(screenshots)
}

#[tauri::command]
pub async fn get_instances_storage_footprint() -> Result<u64, String> {
    let instances_base = paths::instances_dir();
    if !instances_base.exists() {
        return Ok(0);
    }
    Ok(paths::dir_size(&instances_base))
}

#[tauri::command]
pub async fn open_file_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        let _ = open::that(&p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn test_parse_level_dat() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_world_{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&temp);
        let mut raw = Vec::new();
        // TAG_Compound (0x0a) + name length (0x00, 0x04) + "Data"
        raw.extend_from_slice(b"\x0a\x00\x04Data");
        // LevelName: "TestWorld"
        raw.extend_from_slice(b"\x08\x00\x09LevelName\x00\x09TestWorld");
        // Time: 24000 ticks = 1200 seconds
        raw.extend_from_slice(b"\x04\x00\x04Time");
        raw.extend_from_slice(&24000i64.to_be_bytes());
        // GameType: 1 (Creative)
        raw.extend_from_slice(b"\x03\x00\x08GameType");
        raw.extend_from_slice(&1i32.to_be_bytes());
        // LastPlayed: 1716300000000
        raw.extend_from_slice(b"\x04\x00\x0aLastPlayed");
        raw.extend_from_slice(&1716300000000i64.to_be_bytes());
        // TAG_End
        raw.push(0);

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw).unwrap();
        let gzipped = encoder.finish().unwrap();

        fs::write(temp.join("level.dat"), gzipped).unwrap();

        let info = parse_level_dat(&temp);
        assert_eq!(info.name.as_deref(), Some("TestWorld"));
        assert_eq!(info.play_time_seconds, 1200);
        assert_eq!(info.game_mode, "Creative");
        assert!(info.last_played.is_some());
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_parse_level_dat_hardcore() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_world_{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&temp);
        let mut raw = Vec::new();
        raw.extend_from_slice(b"\x0a\x00\x04Data");
        raw.extend_from_slice(b"\x08\x00\x09LevelName\x00\x08Hardcore");
        raw.extend_from_slice(b"\x01\x00\x08hardcore\x01");
        raw.extend_from_slice(b"\x03\x00\x08GameType");
        raw.extend_from_slice(&0i32.to_be_bytes());
        raw.push(0);

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw).unwrap();
        let gzipped = encoder.finish().unwrap();

        fs::write(temp.join("level.dat"), gzipped).unwrap();

        let info = parse_level_dat(&temp);
        assert_eq!(info.name.as_deref(), Some("Hardcore"));
        assert_eq!(info.game_mode, "Hardcore");
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_read_player_play_time() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_world_{}", uuid::Uuid::new_v4()));
        let stats_dir = temp.join("stats");
        fs::create_dir_all(&stats_dir).unwrap();
        // 72000 ticks = 3600 seconds
        let json = r#"{"stats":{"minecraft:custom":{"minecraft:play_time":72000}}}"#;
        fs::write(stats_dir.join("player-uuid.json"), json).unwrap();

        let secs = read_player_play_time(&temp);
        assert_eq!(secs, Some(3600));
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_strip_extended_prefix() {
        assert_eq!(strip_extended_prefix(r"\\?\C:\Users\test"), r"C:\Users\test");
        assert_eq!(strip_extended_prefix(r"C:\Users\test"), r"C:\Users\test");
        assert_eq!(strip_extended_prefix("/home/user/test"), "/home/user/test");
    }
}
