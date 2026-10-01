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

/// Add or update a server entry in the Quick Join deck (max 5 servers).
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
        if servers.len() >= 5 {
            return Err(AppError::Other(
                "Maximum limit of 5 servers reached in Quick Join deck".into(),
            ));
        }
        servers.push(entry);
    }

    save_quick_servers_internal(&servers)?;
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
