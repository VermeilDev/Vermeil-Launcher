// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::error::AppError;
use crate::models::instance::{QuickServerEntry, ServerPingInfo};
use crate::util::paths;
use std::fs;
use std::sync::Mutex;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

static QUICK_SERVERS_LOCK: Mutex<()> = Mutex::new(());

/// Encode a Minecraft protocol VarInt into a byte buffer.
fn write_varint(mut val: i32, buf: &mut Vec<u8>) {
    loop {
        let mut byte = (val & 0x7F) as u8;
        val >>= 7;
        if val != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if val == 0 {
            break;
        }
    }
}

/// Read a Minecraft protocol VarInt from an async stream.
async fn read_varint<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<i32, std::io::Error> {
    let mut num_read = 0;
    let mut result = 0;
    loop {
        let mut buf = [0u8; 1];
        reader.read_exact(&mut buf).await?;
        let byte = buf[0];
        let value = (byte & 0x7F) as i32;
        result |= value << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "VarInt is too big",
            ));
        }
        if (byte & 0x80) == 0 {
            break;
        }
    }
    Ok(result)
}

/// Ping a Minecraft server using standard Server List Ping (SLP) protocol.
/// Strict 1500ms timeout prevents blocking or hanging on offline servers.
pub async fn ping_server(address: &str) -> ServerPingInfo {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return ServerPingInfo {
            address: address.to_string(),
            is_online: false,
            ping_ms: None,
            players_online: None,
            players_max: None,
            version_name: None,
            protocol: None,
            motd: None,
            favicon: None,
        };
    }

    let (host, port) = match trimmed.split_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().unwrap_or(25565)),
        None => (trimmed, 25565),
    };

    let target = format!("{}:{}", host, port);
    let start_time = Instant::now();

    // 1. Resolve host and connect with 1500ms timeout
    let stream_res = timeout(Duration::from_millis(1500), async {
        let mut addrs = tokio::net::lookup_host(&target).await?;
        if let Some(sock_addr) = addrs.next() {
            TcpStream::connect(sock_addr).await
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Host resolution returned no addresses",
            ))
        }
    })
    .await;

    let mut stream = match stream_res {
        Ok(Ok(s)) => s,
        _ => {
            return ServerPingInfo {
                address: address.to_string(),
                is_online: false,
                ping_ms: None,
                players_online: None,
                players_max: None,
                version_name: None,
                protocol: None,
                motd: None,
                favicon: None,
            };
        }
    };

    let ping_duration = start_time.elapsed().as_millis() as u64;

    // 2. Build Handshake packet (Packet ID 0x00, protocol -1/768, host, port, next state 1)
    let mut handshake_payload = Vec::new();
    write_varint(0x00, &mut handshake_payload); // Packet ID
    write_varint(768, &mut handshake_payload); // Protocol (1.21.4)
    write_varint(host.len() as i32, &mut handshake_payload); // Host length
    handshake_payload.extend_from_slice(host.as_bytes()); // Host string
    handshake_payload.extend_from_slice(&port.to_be_bytes()); // Port u16
    write_varint(1, &mut handshake_payload); // Next state: Status

    let mut handshake_packet = Vec::new();
    write_varint(handshake_payload.len() as i32, &mut handshake_packet);
    handshake_packet.extend_from_slice(&handshake_payload);

    // 3. Status Request packet (Packet ID 0x00, length 1)
    let mut request_packet = Vec::new();
    write_varint(1, &mut request_packet);
    write_varint(0x00, &mut request_packet);

    // 4. Send packets and read response with 1500ms timeout
    let ping_res = timeout(Duration::from_millis(1500), async {
        stream.write_all(&handshake_packet).await?;
        stream.write_all(&request_packet).await?;
        stream.flush().await?;

        // Read response packet length
        let _pkt_len = read_varint(&mut stream).await?;
        let pkt_id = read_varint(&mut stream).await?;
        if pkt_id != 0x00 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Unexpected packet ID",
            ));
        }

        // Read JSON string length and bytes
        let json_len = read_varint(&mut stream).await? as usize;
        let mut json_buf = vec![0u8; json_len];
        stream.read_exact(&mut json_buf).await?;

        let json_str = String::from_utf8(json_buf)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        let parsed: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        Ok(parsed)
    })
    .await;

    match ping_res {
        Ok(Ok(json)) => {
            let players_online = json
                .get("players")
                .and_then(|p| p.get("online"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);

            let players_max = json
                .get("players")
                .and_then(|p| p.get("max"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);

            let version_name = json
                .get("version")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let protocol = json
                .get("version")
                .and_then(|v| v.get("protocol"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            let motd = json.get("description").and_then(|d| {
                if let Some(text) = d.as_str() {
                    Some(text.to_string())
                } else if let Some(text) = d.get("text").and_then(|t| t.as_str()) {
                    Some(text.to_string())
                } else {
                    None
                }
            });

            let favicon = json
                .get("favicon")
                .and_then(|f| f.as_str())
                .filter(|s| s.len() <= 65536 && s.starts_with("data:image/"))
                .map(|s| s.to_string());

            let info = ServerPingInfo {
                address: address.to_string(),
                is_online: true,
                ping_ms: Some(ping_duration),
                players_online,
                players_max,
                version_name,
                protocol,
                motd,
                favicon,
            };
            update_cached_server_ping(&info);
            info
        }
        _ => ServerPingInfo {
            address: address.to_string(),
            is_online: false,
            ping_ms: None,
            players_online: None,
            players_max: None,
            version_name: None,
            protocol: None,
            motd: None,
            favicon: None,
        },
    }
}

/// Load the list of saved Quick Join servers from `%LOCALAPPDATA%/Vermeil/quick_servers.json`.
/// Returns an empty list if none exist, allowing user to curate up to 5 custom servers.
pub fn get_quick_servers() -> Result<Vec<QuickServerEntry>, AppError> {
    let path = paths::data_dir().join("quick_servers.json");
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)?;
    let servers: Vec<QuickServerEntry> = serde_json::from_str(&content).unwrap_or_default();
    Ok(servers)
}

/// Atomically persist quick servers list to disk.
fn save_quick_servers_internal(servers: &[QuickServerEntry]) -> Result<(), AppError> {
    let dir = paths::data_dir();
    fs::create_dir_all(&dir)?;
    let tmp_path = dir.join("quick_servers.json.tmp");
    let final_path = dir.join("quick_servers.json");
    let json = serde_json::to_string_pretty(servers)?;
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

/// Update cached server ping info (favicon, initial metadata) in quick_servers.json.
/// Synchronized via QUICK_SERVERS_LOCK so concurrent pings never race or clobber disk I/O.
/// Only writes to disk when favicon is newly discovered or changed, preventing unnecessary disk I/O on latency jitter.
pub fn update_cached_server_ping(info: &ServerPingInfo) {
    if !info.is_online {
        return;
    }
    let _lock = QUICK_SERVERS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut servers) = get_quick_servers() else { return; };
    let normalized = info.address.trim().to_lowercase();
    let mut modified = false;

    if let Some(existing) = servers.iter_mut().find(|s| s.address.trim().to_lowercase() == normalized) {
        if info.favicon.is_some() && existing.favicon != info.favicon {
            existing.favicon = info.favicon.clone();
            modified = true;
        }
        if info.version_name.is_some() && existing.last_ping_version != info.version_name {
            existing.last_ping_version = info.version_name.clone();
            modified = true;
        }
        if info.motd.is_some() && existing.last_ping_motd != info.motd {
            existing.last_ping_motd = info.motd.clone();
            modified = true;
        }
    }

    if modified {
        let _ = save_quick_servers_internal(&servers);
    }
}

/// Add or update a server entry in the Quick Join deck (max 6 servers).
pub fn save_quick_server(entry: QuickServerEntry) -> Result<Vec<QuickServerEntry>, AppError> {
    let _lock = QUICK_SERVERS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut servers = get_quick_servers().unwrap_or_default();
    let normalized = entry.address.trim().to_lowercase();

    if let Some(existing) = servers.iter_mut().find(|s| s.address.trim().to_lowercase() == normalized) {
        if !entry.name.trim().is_empty() {
            existing.name = entry.name;
        }
        if entry.linked_instance_id.is_some() {
            existing.linked_instance_id = entry.linked_instance_id;
        }
        if entry.last_ping_ms.is_some() {
            existing.last_ping_ms = entry.last_ping_ms;
        }
        if entry.last_ping_online.is_some() {
            existing.last_ping_online = entry.last_ping_online;
        }
        if entry.last_ping_max.is_some() {
            existing.last_ping_max = entry.last_ping_max;
        }
        if entry.last_ping_version.is_some() {
            existing.last_ping_version = entry.last_ping_version;
        }
        if entry.last_ping_motd.is_some() {
            existing.last_ping_motd = entry.last_ping_motd;
        }
        if entry.favicon.is_some() {
            existing.favicon = entry.favicon;
        }
    } else {
        if servers.len() >= 6 {
            return Err(AppError::Other(
                "Maximum limit of 6 servers reached in Quick Join deck".into(),
            ));
        }
        servers.push(entry);
    }

    save_quick_servers_internal(&servers)?;
    sync_quick_servers_to_all_instances();
    Ok(servers)
}

/// Remove a server entry from the Quick Join deck.
pub fn remove_quick_server(address: &str) -> Result<Vec<QuickServerEntry>, AppError> {
    let _lock = QUICK_SERVERS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut servers = get_quick_servers().unwrap_or_default();
    let normalized = address.trim().to_lowercase();
    servers.retain(|s| s.address.trim().to_lowercase() != normalized);
    save_quick_servers_internal(&servers)?;
    Ok(servers)
}

/// Represents a parsed server entry from Minecraft's binary `servers.dat` (uncompressed NBT).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDatEntry {
    pub name: String,
    pub ip: String,
    pub accept_textures: Option<i8>,
    pub icon: Option<String>,
    pub hidden: Option<i8>,
    pub extra_tags: Vec<Vec<u8>>,
}

/// Skips a single NBT payload given its tag type byte.
fn skip_nbt_tag(tag_type: u8, data: &[u8], cursor: &mut usize) -> bool {
    match tag_type {
        0x01 => {
            if *cursor + 1 > data.len() { return false; }
            *cursor += 1;
        }
        0x02 => {
            if *cursor + 2 > data.len() { return false; }
            *cursor += 2;
        }
        0x03 | 0x05 => {
            if *cursor + 4 > data.len() { return false; }
            *cursor += 4;
        }
        0x04 | 0x06 => {
            if *cursor + 8 > data.len() { return false; }
            *cursor += 8;
        }
        0x07 => {
            if *cursor + 4 > data.len() { return false; }
            let len = i32::from_be_bytes([data[*cursor], data[*cursor + 1], data[*cursor + 2], data[*cursor + 3]]);
            *cursor += 4;
            if len > 0 {
                let bytes = len as usize;
                if *cursor + bytes > data.len() { return false; }
                *cursor += bytes;
            }
        }
        0x08 => {
            if *cursor + 2 > data.len() { return false; }
            let len = u16::from_be_bytes([data[*cursor], data[*cursor + 1]]) as usize;
            *cursor += 2;
            if *cursor + len > data.len() { return false; }
            *cursor += len;
        }
        0x09 => {
            if *cursor + 5 > data.len() { return false; }
            let elem_type = data[*cursor];
            let len = i32::from_be_bytes([data[*cursor + 1], data[*cursor + 2], data[*cursor + 3], data[*cursor + 4]]);
            *cursor += 5;
            if len > 0 {
                for _ in 0..len {
                    if !skip_nbt_tag(elem_type, data, cursor) { return false; }
                }
            }
        }
        0x0a => {
            while *cursor < data.len() {
                let sub_type = data[*cursor];
                *cursor += 1;
                if sub_type == 0x00 { break; }
                if *cursor + 2 > data.len() { return false; }
                let name_len = u16::from_be_bytes([data[*cursor], data[*cursor + 1]]) as usize;
                if *cursor + 2 + name_len > data.len() { return false; }
                *cursor += 2 + name_len;
                if !skip_nbt_tag(sub_type, data, cursor) { return false; }
            }
        }
        0x0b => {
            if *cursor + 4 > data.len() { return false; }
            let len = i32::from_be_bytes([data[*cursor], data[*cursor + 1], data[*cursor + 2], data[*cursor + 3]]);
            *cursor += 4;
            if len > 0 {
                let bytes = (len as usize) * 4;
                if *cursor + bytes > data.len() { return false; }
                *cursor += bytes;
            }
        }
        0x0c => {
            if *cursor + 4 > data.len() { return false; }
            let len = i32::from_be_bytes([data[*cursor], data[*cursor + 1], data[*cursor + 2], data[*cursor + 3]]);
            *cursor += 4;
            if len > 0 {
                let bytes = (len as usize) * 8;
                if *cursor + bytes > data.len() { return false; }
                *cursor += bytes;
            }
        }
        _ => return false,
    }
    true
}

/// Parses an uncompressed NBT `servers.dat` byte buffer into a list of `ServerDatEntry`.
pub fn parse_servers_dat(data: &[u8]) -> Vec<ServerDatEntry> {
    let mut servers = Vec::new();
    if data.len() < 3 || data[0] != 0x0a {
        return servers;
    }
    const SERVERS_LIST_PREFIX: &[u8] = b"\x09\x00\x07servers";
    let Some(pos) = data.windows(SERVERS_LIST_PREFIX.len()).position(|w| w == SERVERS_LIST_PREFIX) else {
        return servers;
    };

    let elem_type_pos = pos + SERVERS_LIST_PREFIX.len();
    if elem_type_pos + 5 > data.len() {
        return servers;
    }
    let elem_type = data[elem_type_pos];
    let count = i32::from_be_bytes([
        data[elem_type_pos + 1],
        data[elem_type_pos + 2],
        data[elem_type_pos + 3],
        data[elem_type_pos + 4],
    ]);
    if count <= 0 || elem_type != 0x0a {
        return servers;
    }

    let mut cursor = elem_type_pos + 5;
    for _ in 0..count {
        if cursor >= data.len() {
            break;
        }
        let mut name: Option<String> = None;
        let mut ip: Option<String> = None;
        let mut accept_textures: Option<i8> = None;
        let mut icon: Option<String> = None;
        let mut hidden: Option<i8> = None;
        let mut extra_tags: Vec<Vec<u8>> = Vec::new();

        while cursor < data.len() {
            let tag_start = cursor;
            let tag_type = data[cursor];
            cursor += 1;
            if tag_type == 0x00 {
                break;
            }
            if cursor + 2 > data.len() {
                break;
            }
            let name_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
            cursor += 2;
            if cursor + name_len > data.len() {
                break;
            }
            let tag_name = String::from_utf8_lossy(&data[cursor..cursor + name_len]).to_string();
            cursor += name_len;

            match (tag_type, tag_name.as_str()) {
                (0x01, "hidden") => {
                    if cursor < data.len() {
                        hidden = Some(data[cursor] as i8);
                        cursor += 1;
                    }
                }
                (0x01, "acceptTextures") => {
                    if cursor < data.len() {
                        accept_textures = Some(data[cursor] as i8);
                        cursor += 1;
                    }
                }
                (0x08, "name") => {
                    if cursor + 2 > data.len() {
                        break;
                    }
                    let str_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
                    cursor += 2;
                    if cursor + str_len > data.len() {
                        break;
                    }
                    name = Some(String::from_utf8_lossy(&data[cursor..cursor + str_len]).to_string());
                    cursor += str_len;
                }
                (0x08, "ip") => {
                    if cursor + 2 > data.len() {
                        break;
                    }
                    let str_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
                    cursor += 2;
                    if cursor + str_len > data.len() {
                        break;
                    }
                    ip = Some(String::from_utf8_lossy(&data[cursor..cursor + str_len]).to_string());
                    cursor += str_len;
                }
                (0x08, "icon") => {
                    if cursor + 2 > data.len() {
                        break;
                    }
                    let str_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
                    cursor += 2;
                    if cursor + str_len > data.len() {
                        break;
                    }
                    icon = Some(String::from_utf8_lossy(&data[cursor..cursor + str_len]).to_string());
                    cursor += str_len;
                }
                _ => {
                    if !skip_nbt_tag(tag_type, data, &mut cursor) {
                        break;
                    }
                    extra_tags.push(data[tag_start..cursor].to_vec());
                }
            }
        }

        if let Some(ip) = ip {
            servers.push(ServerDatEntry {
                name: name.unwrap_or_else(|| ip.clone()),
                ip,
                accept_textures,
                icon,
                hidden,
                extra_tags,
            });
        }
    }

    servers
}

/// Writes a list of `ServerDatEntry` into an uncompressed NBT `servers.dat` file atomically.
pub fn write_servers_dat(path: &std::path::Path, servers: &[ServerDatEntry]) -> std::io::Result<()> {
    let mut buf = Vec::new();

    // TAG_Compound (0x0a), name "" (length 0)
    buf.push(0x0a);
    buf.extend_from_slice(&0u16.to_be_bytes());

    // TAG_List "servers"
    buf.push(0x09);
    buf.extend_from_slice(&(7u16).to_be_bytes());
    buf.extend_from_slice(b"servers");

    // Element type: TAG_Compound (0x0a)
    buf.push(0x0a);

    // List count: i32 BE
    buf.extend_from_slice(&(servers.len() as i32).to_be_bytes());

    for s in servers {
        // "hidden": TAG_Byte (0x01) — only written if explicitly hidden (Minecraft 1.20+ Quick Play)
        if let Some(h) = s.hidden {
            if h == 1 {
                buf.push(0x01);
                buf.extend_from_slice(&(6u16).to_be_bytes());
                buf.extend_from_slice(b"hidden");
                buf.push(0x01);
            }
        }

        // "name": TAG_String (0x08)
        buf.push(0x08);
        buf.extend_from_slice(&(4u16).to_be_bytes());
        buf.extend_from_slice(b"name");
        let name_bytes = s.name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_be_bytes());
        buf.extend_from_slice(name_bytes);

        // "ip": TAG_String (0x08)
        buf.push(0x08);
        buf.extend_from_slice(&(2u16).to_be_bytes());
        buf.extend_from_slice(b"ip");
        let ip_bytes = s.ip.as_bytes();
        buf.extend_from_slice(&(ip_bytes.len() as u16).to_be_bytes());
        buf.extend_from_slice(ip_bytes);

        // "icon": TAG_String (0x08)
        if let Some(ref icon) = s.icon {
            if !icon.is_empty() {
                buf.push(0x08);
                buf.extend_from_slice(&(4u16).to_be_bytes());
                buf.extend_from_slice(b"icon");
                let icon_bytes = icon.as_bytes();
                buf.extend_from_slice(&(icon_bytes.len() as u16).to_be_bytes());
                buf.extend_from_slice(icon_bytes);
            }
        }

        // "acceptTextures": TAG_Byte (0x01)
        buf.push(0x01);
        buf.extend_from_slice(&(14u16).to_be_bytes());
        buf.extend_from_slice(b"acceptTextures");
        buf.push(s.accept_textures.unwrap_or(1) as u8);

        // Any custom tags from mods (e.g. preset flags, custom metadata) preserved losslessly
        for extra in &s.extra_tags {
            buf.extend_from_slice(extra);
        }

        // TAG_End
        buf.push(0x00);
    }

    // Root TAG_End
    buf.push(0x00);

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp_path = path.with_extension("tmp");
    std::fs::write(&temp_path, &buf)?;
    if let Err(_) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        std::fs::write(path, &buf)?;
    }

    Ok(())
}

/// Synchronizes the launcher's Quick Join servers into an instance's `.minecraft/servers.dat`.
/// Preserves any existing servers already present in `servers.dat` while ensuring all Quick Join servers are available.
pub fn sync_quick_servers_to_instance(game_dir: &std::path::Path) {
    let quick_servers = match get_quick_servers() {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };

    let servers_dat_path = game_dir.join("servers.dat");
    let mut current_servers = if servers_dat_path.exists() {
        if let Ok(bytes) = std::fs::read(&servers_dat_path) {
            parse_servers_dat(&bytes)
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let mut modified = false;

    for qs in &quick_servers {
        let qs_addr_norm = qs.address.trim().to_lowercase();
        if qs_addr_norm.is_empty() {
            continue;
        }

        if let Some(existing) = current_servers.iter_mut().find(|s| {
            let existing_addr = s.ip.trim().to_lowercase();
            existing_addr == qs_addr_norm
                || (qs_addr_norm.ends_with(":25565") && existing_addr == qs_addr_norm.trim_end_matches(":25565"))
                || (existing_addr.ends_with(":25565") && existing_addr.trim_end_matches(":25565") == qs_addr_norm)
        }) {
            // If the server was previously hidden by Minecraft's --quickPlayMultiplayer, unhide it so it shows in Multiplayer
            if existing.hidden == Some(1) {
                existing.hidden = None;
                modified = true;
            }
            if !qs.name.trim().is_empty() && (existing.name == "Minecraft Server" || existing.name.is_empty()) {
                existing.name = qs.name.clone();
                modified = true;
            }
            if existing.icon.is_none() && qs.favicon.is_some() {
                existing.icon = qs.favicon.clone();
                modified = true;
            }
        } else {
            current_servers.push(ServerDatEntry {
                name: if qs.name.trim().is_empty() { qs.address.clone() } else { qs.name.clone() },
                ip: qs.address.clone(),
                accept_textures: Some(1),
                icon: qs.favicon.clone(),
                hidden: None,
                extra_tags: Vec::new(),
            });
            modified = true;
        }
    }

    if modified || !servers_dat_path.exists() {
        if let Err(e) = write_servers_dat(&servers_dat_path, &current_servers) {
            tracing::warn!("Failed to sync servers.dat for instance at {:?}: {}", game_dir, e);
        } else {
            tracing::info!("Synced {} Quick Join servers into {:?}", current_servers.len(), servers_dat_path);
        }
    }
}

/// Synchronizes the launcher's Quick Join servers into all existing instances on disk.
pub fn sync_quick_servers_to_all_instances() {
    let instances_dir = crate::util::paths::instances_dir();
    let Ok(entries) = std::fs::read_dir(instances_dir) else { return; };
    for entry in entries.flatten() {
        let game_dir = entry.path().join(".minecraft");
        if game_dir.exists() {
            sync_quick_servers_to_instance(&game_dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_and_write_servers_dat_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("vermeil_test_servers_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let servers_path = temp_dir.join("servers.dat");

        let sample_servers = vec![
            ServerDatEntry {
                name: "Hypixel Network".to_string(),
                ip: "mc.hypixel.net".to_string(),
                accept_textures: Some(1),
                icon: Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==".to_string()),
                hidden: None,
                extra_tags: vec![
                    // Custom mod tag: TAG_Byte "mod_preset" = 1
                    vec![0x01, 0x00, 0x0a, b'm', b'o', b'd', b'_', b'p', b'r', b'e', b's', b'e', b't', 0x01],
                ],
            },
            ServerDatEntry {
                name: "DonutSMP".to_string(),
                ip: "donutsmp.net".to_string(),
                accept_textures: Some(2),
                icon: None,
                hidden: None,
                extra_tags: Vec::new(),
            },
        ];

        let write_res = write_servers_dat(&servers_path, &sample_servers);
        assert!(write_res.is_ok());

        // Repeated write to existing file succeeds
        let write_res_repeat = write_servers_dat(&servers_path, &sample_servers);
        assert!(write_res_repeat.is_ok());

        let raw_bytes = std::fs::read(&servers_path).expect("Failed to read test servers.dat");
        let parsed = parse_servers_dat(&raw_bytes);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Hypixel Network");
        assert_eq!(parsed[0].ip, "mc.hypixel.net");
        assert_eq!(parsed[0].accept_textures, Some(1));
        assert_eq!(parsed[0].icon.as_deref(), Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="));
        assert_eq!(parsed[0].hidden, None);
        assert_eq!(parsed[0].extra_tags.len(), 1);
        assert_eq!(parsed[0].extra_tags[0], vec![0x01, 0x00, 0x0a, b'm', b'o', b'd', b'_', b'p', b'r', b'e', b's', b'e', b't', 0x01]);

        assert_eq!(parsed[1].name, "DonutSMP");
        assert_eq!(parsed[1].ip, "donutsmp.net");
        assert_eq!(parsed[1].accept_textures, Some(2));
        assert_eq!(parsed[1].icon, None);
        assert_eq!(parsed[1].hidden, None);
        assert!(parsed[1].extra_tags.is_empty());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_parse_real_hypixel_servers_dat() {
        // Raw bytes extracted from real vanilla servers.dat containing Hypixel
        let raw: &[u8] = &[
            0x0a, 0x00, 0x00, 0x09, 0x00, 0x07, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0x73, 0x0a, 0x00, 0x00,
            0x00, 0x01, 0x01, 0x00, 0x06, 0x68, 0x69, 0x64, 0x64, 0x65, 0x6e, 0x01, 0x08, 0x00, 0x02, 0x69,
            0x70, 0x00, 0x0e, 0x6d, 0x63, 0x2e, 0x68, 0x79, 0x70, 0x69, 0x78, 0x65, 0x6c, 0x2e, 0x6e, 0x65,
            0x74, 0x08, 0x00, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x00, 0x10, 0x4d, 0x69, 0x6e, 0x65, 0x63, 0x72,
            0x61, 0x66, 0x74, 0x20, 0x53, 0x65, 0x72, 0x76, 0x65, 0x72, 0x01, 0x00, 0x0e, 0x61, 0x63, 0x63,
            0x65, 0x70, 0x74, 0x54, 0x65, 0x78, 0x74, 0x75, 0x72, 0x65, 0x73, 0x01, 0x00, 0x00,
        ];

        let parsed = parse_servers_dat(raw);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].ip, "mc.hypixel.net");
        assert_eq!(parsed[0].name, "Minecraft Server");
        assert_eq!(parsed[0].accept_textures, Some(1));
        assert_eq!(parsed[0].hidden, Some(1));
        assert!(parsed[0].extra_tags.is_empty());
    }

    #[test]
    fn test_servers_dat_corrupt_and_empty_buffers() {
        let corrupt: &[u8] = &[0x0a, 0x00, 0x00, 0x09, 0x00, 0x07, 0x73, 0x65];
        let parsed = parse_servers_dat(corrupt);
        assert!(parsed.is_empty());

        assert!(parse_servers_dat(&[]).is_empty());

        // Empty list tag (type 0x00, count 0)
        let empty_list: &[u8] = &[0x0a, 0x00, 0x00, 0x09, 0x00, 0x07, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0x73, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert!(parse_servers_dat(empty_list).is_empty());
    }
}
