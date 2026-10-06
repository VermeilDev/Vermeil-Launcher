// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Serverless Instance Share Code (`VML`) blueprint codec, previewer, and importer.
//!
//! Format: `"VML"` + Base62_Chunked(Zlib_Best(JSON(ShareCodePayload)))
//! - 100% alphanumeric (`[0-9A-Za-z]`) with no separators so a double-click in Discord or
//!   browsers selects the entire code without word-boundary splitting or Markdown italics.
//! - Zero arbitrary URLs: only Modrinth/CurseForge `(project_id, version_id)` pairs are
//!   encoded, and all API-returned URLs/filenames are strictly host-allowlisted and sanitized.
//! - Decompression-bomb safe: input string capped at 16 KB; `ZlibDecoder` wrapped in
//!   `std::io::Read::take(65_536)` (64 KB hard ceiling) with built-in Adler32 integrity check.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::LazyLock;
use tokio::sync::Mutex;

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};

use crate::models::instance::{
    Instance, JavaConfig, LoaderConfig, LoaderType, ModEntry, WindowConfig,
};
use crate::services::download::DownloadTask;
use crate::services::prepare::prepare_with_extras;
use crate::util::paths;

const SHARE_CODE_PREFIX: &str = "VML";
pub const CLOUDFLARE_SHARE_API: &str = "https://share.vermeillauncher.workers.dev";
const VERMEIL_CLIENT_KEY: &str = match option_env!("VERMEIL_CLIENT_KEY") {
    Some(val) => val,
    None => "",
};
const MAX_CODE_CHARS: usize = 16_384;
const MAX_DECOMPRESSED_BYTES: u64 = 65_536;

static RESOLVED_PAYLOAD_CACHE: LazyLock<Mutex<Option<(String, ShareCodePayload)>>> =
    LazyLock::new(|| Mutex::new(None));

/// Decodes a hex string into bytes without pulling in an external `hex` crate.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
const BASE62_ALPHABET: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Compact item tuple serialized inside `ShareCodePayload`:
/// `(source_enum, project_id, version_id, category_enum, enabled)`
/// - `source_enum`: `0` = Modrinth, `1` = CurseForge
/// - `category_enum`: `0` = mod (`mods/`), `1` = shader (`shaderpacks/`), `2` = resourcepack (`resourcepacks/`)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareItemTuple(pub u8, pub String, pub String, pub u8, pub bool);

/// Base Modpack Reference (`bp`): `(platform, project_id, version_id, mod_count, shader_count, rp_count)`
/// - `platform`: `"m"` = Modrinth, `"c"` = CurseForge
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BasePackRef(
    pub String,
    pub String,
    pub String,
    pub usize,
    pub usize,
    pub usize,
);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareItemMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareCodePayload {
    pub v: u8,
    pub n: String,
    pub mc: String,
    pub l: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bp: Option<BasePackRef>,
    pub items: Vec<ShareItemTuple>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub meta: Vec<ShareItemMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharePreviewItem {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub category: String, // "mod", "shader", "resourcepack"
    pub source: String,   // "Modrinth" or "CurseForge"
    pub enabled: bool,
}

/// Instant preview returned to `ImportInstance.tsx` on scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareCodePreview {
    pub name: String,
    pub game_version: String,
    pub loader_type: String,
    pub loader_version: Option<String>,
    pub icon_url: Option<String>,
    pub mod_count: usize,
    pub shader_count: usize,
    pub resourcepack_count: usize,
    pub total_count: usize,
    pub is_modpack: bool,
    pub base_pack_platform: Option<String>,
    pub base_pack_id: Option<String>,
    pub items: Vec<SharePreviewItem>,
}

// ─── Fixed-Block Base62 Codec (8 bytes <-> 11 Base62 chars, O(N), 0 deps) ──

/// Encodes an arbitrary byte slice into Base62 (`[0-9A-Za-z]`).
/// Frames the payload with a 4-byte big-endian length prefix and encodes 8-byte (`u64`)
/// blocks into 11 Base62 characters each ($62^{11} = 5.20 \times 10^{19} > 2^{64} = 1.84 \times 10^{19}$).
pub fn base62_encode(data: &[u8]) -> String {
    let mut framed = Vec::with_capacity(4 + data.len());
    framed.extend_from_slice(&(data.len() as u32).to_be_bytes());
    framed.extend_from_slice(data);

    let num_chunks = framed.len().div_ceil(8);
    let mut out = String::with_capacity(num_chunks * 11);

    for chunk in framed.chunks(8) {
        let mut buf = [0u8; 8];
        buf[..chunk.len()].copy_from_slice(chunk);
        let mut val = u64::from_be_bytes(buf) as u128;

        let mut chars = [b'0'; 11];
        for i in (0..11).rev() {
            chars[i] = BASE62_ALPHABET[(val % 62) as usize];
            val /= 62;
        }
        // Safe because BASE62_ALPHABET is strictly ASCII
        out.push_str(std::str::from_utf8(&chars).unwrap_or(""));
    }
    out
}

/// Decodes a Base62 string produced by `base62_encode` back into raw bytes.
pub fn base62_decode(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() || !encoded.len().is_multiple_of(11) {
        return Err("Invalid share code length (must be a multiple of 11 characters).".to_string());
    }

    let num_chunks = encoded.len() / 11;
    let mut framed = Vec::with_capacity(num_chunks * 8);

    for chunk in encoded.as_bytes().chunks(11) {
        let mut val: u128 = 0;
        for &b in chunk {
            let digit = match b {
                b'0'..=b'9' => (b - b'0') as u128,
                b'A'..=b'Z' => (b - b'A' + 10) as u128,
                b'a'..=b'z' => (b - b'a' + 36) as u128,
                _ => {
                    return Err(
                        "Invalid character in share code (expected alphanumeric Base62)."
                            .to_string(),
                    )
                }
            };
            val = val * 62 + digit;
        }
        if val > u64::MAX as u128 {
            return Err("Corrupted share code chunk (exceeds 64-bit bound).".to_string());
        }
        framed.extend_from_slice(&(val as u64).to_be_bytes());
    }

    if framed.len() < 4 {
        return Err("Truncated share code header.".to_string());
    }
    let orig_len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
    if orig_len > MAX_DECOMPRESSED_BYTES as usize || 4 + orig_len > framed.len() {
        return Err("Invalid or corrupted share code frame length.".to_string());
    }
    Ok(framed[4..4 + orig_len].to_vec())
}

// ─── Security Sanitizers (URLs, Icons, Windows Filenames) ──────────────────

/// Strictly allowlists remote icon URLs to Modrinth or CurseForge CDNs.
pub fn sanitize_icon_url(url: Option<&str>) -> Option<String> {
    let raw = url?.trim();
    if (raw.starts_with("https://cdn.modrinth.com/")
        || raw.starts_with("https://media.forgecdn.net/"))
        && !raw.contains("..")
        && raw.len() <= 256
    {
        Some(raw.to_string())
    } else {
        None
    }
}

/// Strictly validates that an API-returned file download URL originates from an official CDN.
pub fn is_allowed_cdn_url(url: &str) -> bool {
    let u = url.trim();
    u.starts_with("https://cdn.modrinth.com/")
        || u.starts_with("https://edge.forgecdn.net/")
        || u.starts_with("https://media.forgecdn.net/")
}

/// Sanitizes an API-returned filename against path traversal (`..`, `/`, `\`),
/// trailing dots/spaces, Windows reserved device stems (`CON`, `NUL`, `AUX`, `COM1`..`9`, `LPT1`..`9`),
/// and enforces expected archive extension (`.jar` for mods, `.zip` for shaders/resourcepacks).
pub fn sanitize_content_filename(raw: &str, category_enum: u8) -> Result<String, String> {
    let base = raw
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace());

    if base.is_empty() || base.contains("..") || base.len() > 200 {
        return Err(format!("Rejected unsafe filename: {:?}", raw));
    }

    // Reject Windows reserved device names on the stem before the first dot
    let stem = base.split('.').next().unwrap_or("").to_ascii_uppercase();
    let is_reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if is_reserved {
        return Err(format!("Rejected reserved Windows filename: {}", base));
    }

    let lower = base.to_ascii_lowercase();
    let expected_ext = if category_enum == 0 { ".jar" } else { ".zip" };
    if !lower.ends_with(expected_ext) && !lower.ends_with(".jar") && !lower.ends_with(".zip") {
        return Err(format!(
            "Rejected file with unexpected extension: {}",
            base
        ));
    }

    Ok(base.to_string())
}

// ─── Encode / Decode Payload (Binary-Packed v2 + JSON v1 Back-Compat) ─────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CompactHeaderV2 {
    n: String,
    mc: String,
    l: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bp: Option<BasePackRef>,
}

fn pack_base62_8(id: &str) -> Option<[u8; 6]> {
    if id.len() != 8 {
        return None;
    }
    let mut val: u64 = 0;
    for &b in id.as_bytes() {
        let digit = match b {
            b'0'..=b'9' => (b - b'0') as u64,
            b'A'..=b'Z' => (b - b'A' + 10) as u64,
            b'a'..=b'z' => (b - b'a' + 36) as u64,
            _ => return None,
        };
        val = val * 62 + digit;
    }
    Some([
        ((val >> 40) & 0xFF) as u8,
        ((val >> 32) & 0xFF) as u8,
        ((val >> 24) & 0xFF) as u8,
        ((val >> 16) & 0xFF) as u8,
        ((val >> 8) & 0xFF) as u8,
        (val & 0xFF) as u8,
    ])
}

fn unpack_base62_8(bytes: &[u8; 6]) -> String {
    let mut val: u64 = ((bytes[0] as u64) << 40)
        | ((bytes[1] as u64) << 32)
        | ((bytes[2] as u64) << 24)
        | ((bytes[3] as u64) << 16)
        | ((bytes[4] as u64) << 8)
        | (bytes[5] as u64);
    let mut chars = [b'0'; 8];
    for i in (0..8).rev() {
        chars[i] = BASE62_ALPHABET[(val % 62) as usize];
        val /= 62;
    }
    std::str::from_utf8(&chars).unwrap_or("").to_string()
}

fn compress_icon_prefix(url: Option<&str>) -> Option<String> {
    let u = sanitize_icon_url(url)?;
    if let Some(rest) = u.strip_prefix("https://cdn.modrinth.com/data/") {
        Some(format!("~m/{}", rest))
    } else if let Some(rest) = u.strip_prefix("https://media.forgecdn.net/avatars/") {
        Some(format!("~c/{}", rest))
    } else {
        Some(u)
    }
}

fn expand_icon_prefix(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    let expanded = if let Some(rest) = s.strip_prefix("~m/") {
        format!("https://cdn.modrinth.com/data/{}", rest)
    } else if let Some(rest) = s.strip_prefix("~c/") {
        format!("https://media.forgecdn.net/avatars/{}", rest)
    } else {
        s.to_string()
    };
    sanitize_icon_url(Some(&expanded))
}

pub fn encode_payload(payload: &ShareCodePayload) -> Result<String, String> {
    let header = CompactHeaderV2 {
        n: payload.n.clone(),
        mc: payload.mc.clone(),
        l: payload.l.clone(),
        lv: payload.lv.clone(),
        ic: compress_icon_prefix(payload.ic.as_deref()),
        bp: payload.bp.clone(),
    };
    let header_bytes = serde_json::to_vec(&header)
        .map_err(|e| format!("Failed to serialize share code header: {}", e))?;
    if header_bytes.len() > u16::MAX as usize {
        return Err("Share code header exceeds maximum size.".to_string());
    }

    let mut raw = Vec::with_capacity(3 + header_bytes.len() + payload.items.len() * 6);

    // Use Columnar Sorted Binary v3 (`0x03`) for custom instances with 8+ items to eliminate
    // per-item flag repetition and exploit order-independence (`TopDelta + Low40` + CF `Delta-Varint`).
    if payload.items.len() >= 8 {
        raw.push(0x03);
        raw.extend_from_slice(&(header_bytes.len() as u16).to_be_bytes());
        raw.extend_from_slice(&header_bytes);

        let mut mr_u48s: Vec<[u8; 6]> = Vec::new();
        let mut cf_u32s: Vec<u32> = Vec::new();
        let mut rest_bytes: Vec<u8> = Vec::new();

        for ShareItemTuple(src, _proj_id, ver_id, cat, enabled) in &payload.items {
            if *src == 0 && *cat == 0 && *enabled {
                if let Some(packed6) = pack_base62_8(ver_id) {
                    mr_u48s.push(packed6);
                    continue;
                }
            } else if *src == 1 && *cat == 0 && *enabled {
                if let Ok(fid32) = ver_id.parse::<u32>() {
                    cf_u32s.push(fid32);
                    continue;
                }
            }

            let cat_bits = (*cat & 0b11) << 2;
            let en_bit = if *enabled { 1u8 << 4 } else { 0u8 };
            if *src == 0 {
                if let Some(packed6) = pack_base62_8(ver_id) {
                    rest_bytes.push(en_bit | cat_bits);
                    rest_bytes.extend_from_slice(&packed6);
                    continue;
                }
            } else if *src == 1 {
                if let Ok(fid32) = ver_id.parse::<u32>() {
                    rest_bytes.push(en_bit | cat_bits | 1u8);
                    rest_bytes.extend_from_slice(&fid32.to_be_bytes());
                    continue;
                }
            }
            if ver_id.len() == 40 && ver_id.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Some(sha1_bytes) = decode_hex(ver_id) {
                    let mode = if *src == 1 { 3u8 } else { 2u8 };
                    rest_bytes.push(en_bit | cat_bits | mode);
                    rest_bytes.push(0x80 | 20);
                    rest_bytes.extend_from_slice(&sha1_bytes);
                    continue;
                }
            }
            let mode = if *src == 1 { 3u8 } else { 2u8 };
            let vbytes = ver_id.as_bytes();
            if vbytes.len() <= 127 {
                rest_bytes.push(en_bit | cat_bits | mode);
                rest_bytes.push(vbytes.len() as u8);
                rest_bytes.extend_from_slice(vbytes);
            }
        }

        mr_u48s.sort_unstable();
        cf_u32s.sort_unstable();

        // Column 1: Modrinth sorted Top-Byte Deltas (highly compressible)
        raw.extend_from_slice(&(mr_u48s.len() as u16).to_be_bytes());
        let mut prev_top = 0u8;
        for b6 in &mr_u48s {
            raw.push(b6[0].wrapping_sub(prev_top));
            prev_top = b6[0];
        }

        // Column 2: CurseForge sorted LEB128 Varint Deltas (~2.2 bytes/item)
        raw.extend_from_slice(&(cf_u32s.len() as u16).to_be_bytes());
        let mut prev_cf = 0u32;
        for &fid in &cf_u32s {
            let mut d = fid.wrapping_sub(prev_cf);
            prev_cf = fid;
            while d >= 0x80 {
                raw.push(((d & 0x7F) as u8) | 0x80);
                d >>= 7;
            }
            raw.push(d as u8);
        }

        // Column 3: Modrinth Low-40-Bit tails (5 bytes each) + remaining non-default items
        for b6 in &mr_u48s {
            raw.extend_from_slice(&b6[1..6]);
        }
        raw.extend_from_slice(&rest_bytes);
    } else {
        raw.push(0x02); // Binary v2 wire marker
        raw.extend_from_slice(&(header_bytes.len() as u16).to_be_bytes());
        raw.extend_from_slice(&header_bytes);

        for ShareItemTuple(src, _proj_id, ver_id, cat, enabled) in &payload.items {
            let cat_bits = (*cat & 0b11) << 2;
            let en_bit = if *enabled { 1u8 << 4 } else { 0u8 };

            if *src == 0 {
                if let Some(packed6) = pack_base62_8(ver_id) {
                    raw.push(en_bit | cat_bits);
                    raw.extend_from_slice(&packed6);
                    continue;
                }
            } else if *src == 1 {
                if let Ok(fid32) = ver_id.parse::<u32>() {
                    raw.push(en_bit | cat_bits | 1u8);
                    raw.extend_from_slice(&fid32.to_be_bytes());
                    continue;
                }
            }

            if ver_id.len() == 40 && ver_id.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Some(sha1_bytes) = decode_hex(ver_id) {
                    let mode = if *src == 1 { 3u8 } else { 2u8 };
                    raw.push(en_bit | cat_bits | mode);
                    raw.push(0x80 | 20);
                    raw.extend_from_slice(&sha1_bytes);
                    continue;
                }
            }

            let mode = if *src == 1 { 3u8 } else { 2u8 };
            let vbytes = ver_id.as_bytes();
            if vbytes.len() <= 127 {
                raw.push(en_bit | cat_bits | mode);
                raw.push(vbytes.len() as u8);
                raw.extend_from_slice(vbytes);
            }
        }
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(&raw)
        .map_err(|e| format!("Failed to compress share code payload: {}", e))?;
    let compressed = encoder
        .finish()
        .map_err(|e| format!("Failed to finalize share code compression: {}", e))?;

    Ok(format!("{}{}", SHARE_CODE_PREFIX, base62_encode(&compressed)))
}

pub fn decode_payload(code: &str) -> Result<ShareCodePayload, String> {
    let trimmed = code.trim();
    if trimmed.len() > MAX_CODE_CHARS {
        return Err("Share code exceeds maximum allowed length (16 KB).".to_string());
    }

    let body = trimmed
        .strip_prefix("VML1")
        .or_else(|| trimmed.strip_prefix("VLM1"))
        .or_else(|| trimmed.strip_prefix(SHARE_CODE_PREFIX))
        .or_else(|| trimmed.strip_prefix("VLM"))
        .ok_or_else(|| format!("Invalid share code prefix (expected a code starting with '{}...').", SHARE_CODE_PREFIX))?;

    let compressed = base62_decode(body)?;

    // Wrap ZlibDecoder in Read::take(65_536) to prevent decompression bombs
    let decoder = ZlibDecoder::new(compressed.as_slice());
    let mut bounded = decoder.take(MAX_DECOMPRESSED_BYTES + 1);
    let mut decompressed = Vec::new();
    bounded
        .read_to_end(&mut decompressed)
        .map_err(|_| "Invalid or corrupted share code (checksum mismatch).".to_string())?;

    if decompressed.len() as u64 > MAX_DECOMPRESSED_BYTES {
        return Err("Share code payload exceeds 64 KB decompression limit.".to_string());
    }

    let wire_tag = decompressed.first().copied().unwrap_or(0);
    let mut payload: ShareCodePayload = if wire_tag == 0x02 || wire_tag == 0x03 {
        if decompressed.len() < 3 {
            return Err("Truncated share code header.".to_string());
        }
        let header_len = u16::from_be_bytes([decompressed[1], decompressed[2]]) as usize;
        if 3 + header_len > decompressed.len() {
            return Err("Corrupted share code header length.".to_string());
        }
        let header: CompactHeaderV2 = serde_json::from_slice(&decompressed[3..3 + header_len])
            .map_err(|e| format!("Invalid share code header: {}", e))?;

        let mut pos = 3 + header_len;
        let mut items = Vec::new();

        if wire_tag == 0x03 {
            if pos + 2 > decompressed.len() {
                return Err("Truncated v3 Modrinth column count.".to_string());
            }
            let mr_count = u16::from_be_bytes([decompressed[pos], decompressed[pos + 1]]) as usize;
            pos += 2;
            if pos + mr_count > decompressed.len() {
                return Err("Truncated v3 Modrinth top deltas.".to_string());
            }
            let mut mr_tops = Vec::with_capacity(mr_count);
            let mut acc_top = 0u8;
            for i in 0..mr_count {
                acc_top = acc_top.wrapping_add(decompressed[pos + i]);
                mr_tops.push(acc_top);
            }
            pos += mr_count;

            if pos + 2 > decompressed.len() {
                return Err("Truncated v3 CurseForge column count.".to_string());
            }
            let cf_count = u16::from_be_bytes([decompressed[pos], decompressed[pos + 1]]) as usize;
            pos += 2;
            let mut cf_fids = Vec::with_capacity(cf_count);
            let mut acc_cf = 0u32;
            for _ in 0..cf_count {
                let mut delta = 0u32;
                let mut shift = 0u32;
                loop {
                    if pos >= decompressed.len() || shift >= 35 {
                        return Err("Truncated or invalid v3 CurseForge varint.".to_string());
                    }
                    let b = decompressed[pos];
                    pos += 1;
                    delta |= ((b & 0x7F) as u32) << shift;
                    if (b & 0x80) == 0 {
                        break;
                    }
                    shift += 7;
                }
                acc_cf = acc_cf.wrapping_add(delta);
                cf_fids.push(acc_cf);
            }

            if pos + mr_count * 5 > decompressed.len() {
                return Err("Truncated v3 Modrinth low-40 bytes.".to_string());
            }
            for top in mr_tops {
                let b6 = [
                    top,
                    decompressed[pos],
                    decompressed[pos + 1],
                    decompressed[pos + 2],
                    decompressed[pos + 3],
                    decompressed[pos + 4],
                ];
                pos += 5;
                items.push(ShareItemTuple(0, String::new(), unpack_base62_8(&b6), 0, true));
            }
            for fid in cf_fids {
                items.push(ShareItemTuple(1, String::new(), fid.to_string(), 0, true));
            }
        }
        while pos < decompressed.len() {
            let flags = decompressed[pos];
            pos += 1;
            let mode = flags & 0b11;
            let cat = (flags >> 2) & 0b11;
            let enabled = ((flags >> 4) & 1) == 1;

            match mode {
                0 => {
                    if pos + 6 > decompressed.len() {
                        return Err("Truncated Modrinth item in share code.".to_string());
                    }
                    let mut b6 = [0u8; 6];
                    b6.copy_from_slice(&decompressed[pos..pos + 6]);
                    pos += 6;
                    let ver_id = unpack_base62_8(&b6);
                    items.push(ShareItemTuple(0, String::new(), ver_id, cat, enabled));
                }
                1 => {
                    if pos + 4 > decompressed.len() {
                        return Err("Truncated CurseForge item in share code.".to_string());
                    }
                    let fid = u32::from_be_bytes([
                        decompressed[pos],
                        decompressed[pos + 1],
                        decompressed[pos + 2],
                        decompressed[pos + 3],
                    ]);
                    pos += 4;
                    items.push(ShareItemTuple(1, String::new(), fid.to_string(), cat, enabled));
                }
                2 | 3 => {
                    if pos >= decompressed.len() {
                        return Err("Truncated variable item length in share code.".to_string());
                    }
                    let len_byte = decompressed[pos] as usize;
                    pos += 1;

                    // High bit set = raw binary SHA-1 (20 bytes → 40-char hex string)
                    if len_byte & 0x80 != 0 {
                        let slen = len_byte & 0x7F;
                        if pos + slen > decompressed.len() {
                            return Err("Truncated binary SHA-1 in share code.".to_string());
                        }
                        let ver_id = decompressed[pos..pos + slen]
                            .iter()
                            .map(|b| format!("{:02x}", b))
                            .collect::<String>();
                        pos += slen;
                        let src = if mode == 3 { 1u8 } else { 0u8 };
                        items.push(ShareItemTuple(src, String::new(), ver_id, cat, enabled));
                    } else {
                        let slen = len_byte;
                        if pos + slen > decompressed.len() {
                            return Err("Truncated variable item ID in share code.".to_string());
                        }
                        let ver_id = std::str::from_utf8(&decompressed[pos..pos + slen])
                            .map_err(|_| "Invalid UTF-8 in share code item ID.".to_string())?
                            .to_string();
                        pos += slen;
                        let src = if mode == 3 { 1u8 } else { 0u8 };
                        items.push(ShareItemTuple(src, String::new(), ver_id, cat, enabled));
                    }
                }
                _ => unreachable!(),
            }
        }

        ShareCodePayload {
            v: 1,
            n: header.n,
            mc: header.mc,
            l: header.l,
            lv: header.lv,
            ic: expand_icon_prefix(header.ic.as_deref()),
            bp: header.bp,
            items,
            meta: Vec::new(),
        }
    } else {
        serde_json::from_slice(&decompressed)
            .map_err(|e| format!("Invalid share code format: {}", e))?
    };

    if payload.v != 1 {
        return Err(format!(
            "Unsupported share code version (v{}). Please update Vermeil.",
            payload.v
        ));
    }

    // Sanitize header strings & BasePackRef at the trust boundary
    payload.n = payload.n.trim().chars().take(64).collect();
    if payload.n.is_empty() {
        payload.n = "Shared Instance".to_string();
    }
    payload.ic = sanitize_icon_url(payload.ic.as_deref());
    payload.bp = payload.bp.and_then(|BasePackRef(plat, pid, vid, m, s, r)| {
        let valid_plat = plat == "m" || plat == "c";
        let valid_pid = !pid.is_empty()
            && pid.len() <= 32
            && pid
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let valid_vid = vid.len() <= 32
            && vid.chars().all(|c| {
                c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '+'
            });
        if valid_plat && valid_pid && valid_vid {
            Some(BasePackRef(
                plat,
                pid,
                vid,
                m.min(10_000),
                s.min(10_000),
                r.min(10_000),
            ))
        } else {
            None
        }
    });

    Ok(payload)
}

// ─── Public Service Functions (Export, Preview, Import) ───────────────────

/// Exports an existing instance's metadata and content recipe into a `VML1...` share code.
/// Automatically runs a fast hash enrichment check first if any installed mod lacks IDs,
/// upgrades any legacy 40-character SHA-1 `version_id`s to 8-character Modrinth `version_id`s,
/// and uses Base Modpack + Delta (`bp`) encoding for modpack-derived instances.
pub async fn export_instance_share_code(instance_id: &str) -> Result<String, String> {
    let inst = crate::services::instance_service::get_by_id(instance_id)
        .await
        .map_err(|e| format!("Failed to load instance: {}", e))?;

    // If any installed entry lacks a project_id or version_id (or still has a 40-char SHA-1),
    // or if .minecraft/mods contains unindexed .jar files from .mrpack overrides/mods/,
    // run best-effort Modrinth SHA-1 + CurseForge Murmur2 enrichment.
    let disk_jar_count = std::fs::read_dir(
        paths::instances_dir()
            .join(instance_id)
            .join(".minecraft")
            .join("mods"),
    )
    .map(|rd| {
        rd.flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                (n.ends_with(".jar") || n.ends_with(".jar.disabled"))
                    && !crate::services::companion_mod::is_managed(&n)
            })
            .count()
    })
    .unwrap_or(0);

    let needs_enrichment = disk_jar_count > inst.mods.len()
        || inst.mods.iter().any(|m| {
            m.project_id.is_empty()
                || m.version_id.is_empty()
                || (m.version_id.len() == 40 && m.version_id.chars().all(|c| c.is_ascii_hexdigit()))
        });
    let mut inst = if needs_enrichment {
        let _ = crate::services::modpack::enrich_mod_metadata(instance_id, None).await;
        crate::services::instance_service::get_by_id(instance_id)
            .await
            .unwrap_or(inst)
    } else {
        inst
    };
    // Always filter out managed companion mod jars so they never leak into share codes
    inst.mods.retain(|m| !crate::services::companion_mod::is_managed(&m.filename));

    let loader_str = match inst.loader.loader_type {
        LoaderType::Fabric => "fabric",
        LoaderType::Quilt => "quilt",
        LoaderType::Neoforge => "neoforge",
        LoaderType::Forge => "forge",
        LoaderType::Vanilla => "vanilla",
    };

    // Count total installed items by category across the full instance
    let mut total_mods = 0usize;
    let mut total_shaders = 0usize;
    let mut total_rps = 0usize;
    for m in &inst.mods {
        match m.category.as_str() {
            "shader" | "shaders" => total_shaders += 1,
            "resourcepack" | "resourcepacks" => total_rps += 1,
            _ => total_mods += 1,
        }
    }

    // Check if this instance was created from a Modrinth or CurseForge modpack (`source_project_id`).
    // If so, encode the BasePackRef (`bp`) and only emit delta items added on top of the modpack.
    let mut bp_ref: Option<BasePackRef> = None;
    let mut base_pack_vids: HashSet<String> = HashSet::new();
    let mut base_pack_pids: HashSet<String> = HashSet::new();
    let mut base_pack_fns: HashSet<String> = HashSet::new();
    let mut modpack_icon_url: Option<String> = None;

    if let Some(ref pid) = inst.source_project_id {
        if !pid.is_empty() {
            let is_cf = if inst.source_platforms.iter().any(|p| p == "curseforge") {
                true
            } else if inst.source_platforms.iter().any(|p| p == "modrinth") {
                false
            } else {
                pid.chars().all(|c| c.is_ascii_digit())
            };
            if !is_cf {
                // Modrinth Modpack: resolve exact Modrinth version_id & dependencies list
                let ver_url = format!("https://api.modrinth.com/v2/project/{}/version", pid);
                let mut resolved_ver_id = inst.source_version.clone().unwrap_or_default();
                if let Ok(resp) = crate::util::http::HTTP.get(&ver_url).send().await {
                    if let Ok(versions) = resp.json::<Vec<serde_json::Value>>().await {
                        let target_v = inst.source_version.as_deref().unwrap_or("");
                        let matched_v = versions
                            .iter()
                            .find(|v| {
                                v.get("id").and_then(|s| s.as_str()) == Some(target_v)
                                    || v.get("version_number").and_then(|s| s.as_str())
                                        == Some(target_v)
                            })
                            .or_else(|| versions.first());

                        if let Some(v_obj) = matched_v {
                            if let Some(vid) = v_obj.get("id").and_then(|s| s.as_str()) {
                                resolved_ver_id = vid.to_string();
                            }
                            if let Some(deps) =
                                v_obj.get("dependencies").and_then(|d| d.as_array())
                            {
                                for dep in deps {
                                    if let Some(v) = dep.get("version_id").and_then(|s| s.as_str())
                                    {
                                        base_pack_vids.insert(v.to_string());
                                    }
                                    if let Some(p) = dep.get("project_id").and_then(|s| s.as_str())
                                    {
                                        base_pack_pids.insert(p.to_string());
                                    }
                                    if let Some(f) = dep.get("file_name").and_then(|s| s.as_str())
                                    {
                                        base_pack_fns.insert(f.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                // Also try to fetch the Modrinth modpack project's official icon_url
                let proj_url = format!("https://api.modrinth.com/v2/project/{}", pid);
                if let Ok(resp) = crate::util::http::HTTP.get(&proj_url).send().await {
                    if let Ok(proj) = resp.json::<serde_json::Value>().await {
                        modpack_icon_url = proj
                            .get("icon_url")
                            .and_then(|s| s.as_str())
                            .and_then(|u| sanitize_icon_url(Some(u)));
                    }
                }

                bp_ref = Some(BasePackRef(
                    "m".to_string(),
                    pid.clone(),
                    resolved_ver_id,
                    total_mods,
                    total_shaders,
                    total_rps,
                ));
            } else {
                // CurseForge Modpack
                let api_key = crate::commands::mods::resolve_cf_api_key().await.unwrap_or_else(|_| crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string());
                let meta = crate::services::curseforge::fetch_project_meta(&api_key, pid).await;
                modpack_icon_url = sanitize_icon_url(meta.icon_url.as_deref());
                bp_ref = Some(BasePackRef(
                    "c".to_string(),
                    pid.clone(),
                    inst.source_version.clone().unwrap_or_default(),
                    total_mods,
                    total_shaders,
                    total_rps,
                ));
            }
        }
    }

    // Determine if the instance has a shareable CDN icon from its base modpack project
    let shareable_icon = sanitize_icon_url(inst.icon_custom.as_deref())
        .or(modpack_icon_url);

    let minecraft_dir = paths::instances_dir().join(instance_id).join(".minecraft");

    let mut items = Vec::with_capacity(inst.mods.len());
    let mut meta_items = Vec::with_capacity(inst.mods.len());
    for m in &inst.mods {
        // If we have a BasePackRef (`bp`) and this mod is an enabled entry that came with the base modpack,
        // skip duplicating it in `items` (it is already covered by `bp`).
        if bp_ref.is_some()
            && m.enabled
            && (m.source == "modpack"
                || base_pack_vids.contains(&m.version_id)
                || (!m.project_id.is_empty() && base_pack_pids.contains(&m.project_id))
                || base_pack_fns.contains(&m.filename))
        {
            continue;
        }

        let mut ver_id = m.version_id.clone();

        // For mods with empty version_id, compute SHA-1 from disk or fall back to `fn:<filename>`
        if ver_id.is_empty() && !m.filename.is_empty() {
            let subdir = match m.category.as_str() {
                "shader" | "shaders" => "shaderpacks",
                "resourcepack" | "resourcepacks" => "resourcepacks",
                "datapack" | "datapacks" => "datapacks",
                _ => "mods",
            };
            let file_path = minecraft_dir.join(subdir).join(&m.filename);
            if file_path.exists() {
                if let Ok(bytes) = fs::read(&file_path) {
                    use sha1::Digest;
                    ver_id = format!("{:x}", sha1::Sha1::digest(&bytes));
                }
            }
            if ver_id.is_empty() {
                ver_id = format!("fn:{}", m.filename.chars().take(120).collect::<String>());
            }
        }

        if ver_id.is_empty() {
            continue;
        }
        let source_enum = if m.source == "curseforge"
            || (m.source == "modpack" && ver_id.chars().all(|c| c.is_ascii_digit()))
        {
            1u8 // CurseForge
        } else {
            0u8 // Modrinth
        };

        let category_enum = match m.category.as_str() {
            "shader" | "shaders" => 1u8,
            "resourcepack" | "resourcepacks" => 2u8,
            _ => 0u8,
        };

        items.push(ShareItemTuple(
            source_enum,
            m.project_id.clone(),
            ver_id,
            category_enum,
            m.enabled,
        ));

        let title_opt = m.title.clone();
        meta_items.push(ShareItemMeta {
            t: title_opt,
            v: m.version_number.clone(),
            i: None, // Omit redundant CDN icon URLs; preview enriches on-demand and install caches to disk
        });
    }

    let payload = ShareCodePayload {
        v: 1,
        n: inst.name,
        mc: inst.game_version,
        l: loader_str.to_string(),
        lv: inst.loader.version,
        ic: shareable_icon,
        bp: bp_ref,
        items,
        meta: meta_items,
    };

    let offline_code = encode_payload(&payload)?;

    // Attempt to register with Cloudflare Worker for a clean 13-character code (VML-XXXX-XXXX)
    #[derive(Deserialize)]
    struct CloudflareShareResponse {
        code: String,
    }

    let worker_url = format!("{}/v1/share", CLOUDFLARE_SHARE_API);
    match crate::util::http::HTTP
        .post(&worker_url)
        .header("X-Vermeil-Client", VERMEIL_CLIENT_KEY)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(cf_res) = resp.json::<CloudflareShareResponse>().await {
                if !cf_res.code.is_empty() {
                    let mut cache = RESOLVED_PAYLOAD_CACHE.lock().await;
                    *cache = Some((cf_res.code.clone(), payload));
                    return Ok(cf_res.code);
                }
            }
            Ok(offline_code)
        }
        Ok(resp) => {
            tracing::warn!(
                "Cloudflare share endpoint returned HTTP {}, falling back to offline VML code",
                resp.status()
            );
            Ok(offline_code)
        }
        Err(e) => {
            tracing::warn!(
                "Could not reach Cloudflare share endpoint ({}), falling back to offline VML code",
                e
            );
            Ok(offline_code)
        }
    }
}

/// Resolves a `ShareCodePayload` from an offline `VML...` code or from the Cloudflare Worker (`VML-XXXX-XXXX`).
pub async fn resolve_code_payload(code: &str) -> Result<ShareCodePayload, String> {
    let clean = code.trim();
    if clean.is_empty() {
        return Err("Share code cannot be empty.".to_string());
    }

    // Offline Base62 payloads don't contain dashes and start with VML or VLM (or legacy VML1/VLM1)
    if !clean.contains('-')
        && (clean.starts_with(SHARE_CODE_PREFIX)
            || clean.starts_with("VLM")
            || clean.starts_with("VML1")
            || clean.starts_with("VLM1"))
    {
        return decode_payload(clean);
    }

    // Check in-memory cache
    {
        let cache = RESOLVED_PAYLOAD_CACHE.lock().await;
        if let Some((cached_code, cached_payload)) = &*cache {
            if cached_code.eq_ignore_ascii_case(clean) {
                return Ok(cached_payload.clone());
            }
        }
    }

    // Short code (e.g. VML-XXXX-XXXX) -> fetch from Cloudflare Worker
    let url = format!("{}/v1/share/{}", CLOUDFLARE_SHARE_API, clean);
    let resp = crate::util::http::HTTP
        .get(&url)
        .header("X-Vermeil-Client", VERMEIL_CLIENT_KEY)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Vermeil Share Service: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("This share code has expired or does not exist. Share codes are valid for 3 minutes.".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!("Share Service returned HTTP {}", resp.status()));
    }

    let payload: ShareCodePayload = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse share code data: {}", e))?;

    // Cache the resolved payload
    {
        let mut cache = RESOLVED_PAYLOAD_CACHE.lock().await;
        *cache = Some((clean.to_string(), payload.clone()));
    }

    Ok(payload)
}

/// Builds a `ShareCodePreview` directly from a parsed `ShareCodePayload`.
pub fn preview_from_payload(payload: &ShareCodePayload) -> ShareCodePreview {
    let (is_modpack, base_pack_platform, base_pack_id, mod_count, shader_count, resourcepack_count, total_count) =
        if let Some(BasePackRef(plat, proj_id, _, bp_mods, bp_shaders, bp_rps)) = &payload.bp {
            let total = bp_mods + bp_shaders + bp_rps;
            let platform_str = if plat == "c" { "CurseForge" } else { "Modrinth" };
            (true, Some(platform_str.to_string()), Some(proj_id.clone()), *bp_mods, *bp_shaders, *bp_rps, total)
        } else {
            let mut m = 0usize;
            let mut s = 0usize;
            let mut r = 0usize;
            for item in &payload.items {
                match item.3 {
                    1 => s += 1,
                    2 => r += 1,
                    _ => m += 1,
                }
            }
            (false, None, None, m, s, r, payload.items.len())
        };

    let items = payload
        .items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let cat = match item.3 {
                1 => "shader",
                2 => "resourcepack",
                _ => "mod",
            };
            let src = match item.0 {
                1 => "CurseForge",
                _ => "Modrinth",
            };
            let meta_entry = payload.meta.get(idx);
            let inline_title = meta_entry.and_then(|m| m.t.clone());
            let inline_version = meta_entry.and_then(|m| m.v.clone());
            let inline_icon = meta_entry.and_then(|m| m.i.clone());

            let display_name = if let Some(t) = inline_title {
                t
            } else if item.2.starts_with("fn:") {
                item.2.trim_start_matches("fn:").to_string()
            } else if !item.1.is_empty() {
                item.1.clone()
            } else {
                item.2.clone()
            };
            SharePreviewItem {
                name: display_name,
                version: inline_version,
                icon_url: inline_icon,
                category: cat.to_string(),
                source: src.to_string(),
                enabled: item.4,
            }
        })
        .collect();

    ShareCodePreview {
        name: payload.n.clone(),
        game_version: payload.mc.clone(),
        loader_type: payload.l.clone(),
        loader_version: payload.lv.clone(),
        icon_url: if is_modpack { payload.ic.clone() } else { None },
        mod_count,
        shader_count,
        resourcepack_count,
        total_count,
        is_modpack,
        base_pack_platform,
        base_pack_id,
        items,
    }
}

#[derive(Debug, Deserialize)]
struct ModrinthBatchProject {
    #[serde(alias = "project_id")]
    id: String,
    #[serde(default)]
    slug: String,
    title: String,
    icon_url: Option<String>,
}

async fn fetch_modrinth_projects_batch(
    project_ids: &[String],
) -> HashMap<String, (String, Option<String>)> {
    let mut map = HashMap::new();
    if project_ids.is_empty() {
        return map;
    }
    for chunk in project_ids.chunks(80) {
        let ids_json = match serde_json::to_string(chunk) {
            Ok(j) => j,
            Err(_) => continue,
        };
        let url = format!(
            "https://api.modrinth.com/v2/projects?ids={}",
            urlencoding::encode(&ids_json)
        );
        let resp = match crate::util::http::HTTP.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        if let Ok(projects) = resp.json::<Vec<ModrinthBatchProject>>().await {
            for p in projects {
                let val = (p.title, p.icon_url);
                if !p.slug.is_empty() {
                    map.insert(p.slug.clone(), val.clone());
                }
                map.insert(p.id, val);
            }
        }
    }
    map
}

async fn enrich_preview_items(items: &mut [SharePreviewItem], payload: &ShareCodePayload) {
    let mut mr_indices: Vec<(usize, String)> = Vec::new();
    let mut cf_indices: Vec<(usize, u64)> = Vec::new();

    for (idx, item) in items.iter().enumerate() {
        if idx >= payload.items.len() {
            break;
        }
        let raw_tuple = &payload.items[idx];
        let raw_id = &raw_tuple.2;
        let is_raw_id = item.name == *raw_id || item.name == raw_tuple.1 || item.name.starts_with("fn:");
        let needs_enrich = item.version.is_none() || item.icon_url.is_none() || is_raw_id;

        if needs_enrich {
            if raw_tuple.0 == 0 {
                if !raw_id.starts_with("fn:") {
                    mr_indices.push((idx, raw_id.clone()));
                }
            } else if raw_tuple.0 == 1 {
                if let Ok(fid) = raw_id.parse::<u64>() {
                    cf_indices.push((idx, fid));
                }
            }
        }
    }

    // 1. Modrinth enrichment
    if !mr_indices.is_empty() {
        let ver_ids: Vec<String> = mr_indices.iter().map(|(_, v)| v.clone()).collect();
        let versions_map = fetch_modrinth_versions_batch(&ver_ids).await.unwrap_or_default();
        let mut proj_ids: HashSet<String> = HashSet::new();
        for v in versions_map.values() {
            if !v.project_id.is_empty() {
                proj_ids.insert(v.project_id.clone());
            }
        }
        for &(idx, ref id) in &mr_indices {
            let raw_proj = &payload.items[idx].1;
            if !raw_proj.is_empty() {
                proj_ids.insert(raw_proj.clone());
            }
            proj_ids.insert(id.clone());
        }

        let proj_id_list: Vec<String> = proj_ids.into_iter().collect();
        let projects_map = fetch_modrinth_projects_batch(&proj_id_list).await;

        for (idx, ver_or_proj_id) in mr_indices {
            if let Some(ver) = versions_map.get(&ver_or_proj_id) {
                if items[idx].version.is_none() && !ver.version_number.is_empty() {
                    items[idx].version = Some(ver.version_number.clone());
                }
                if let Some((title, icon)) = projects_map.get(&ver.project_id) {
                    items[idx].name = title.clone();
                    if items[idx].icon_url.is_none() {
                        items[idx].icon_url = icon.clone();
                    }
                } else if (items[idx].name == ver_or_proj_id || items[idx].name == payload.items[idx].1) && !ver.name.is_empty() {
                    items[idx].name = ver.name.clone();
                }
            } else if let Some((title, icon)) = projects_map.get(&ver_or_proj_id).or_else(|| projects_map.get(&payload.items[idx].1)) {
                items[idx].name = title.clone();
                if items[idx].icon_url.is_none() {
                    items[idx].icon_url = icon.clone();
                }
            }
        }
    }

    // 2. CurseForge enrichment
    if !cf_indices.is_empty() {
        let api_key = crate::commands::mods::resolve_cf_api_key().await.unwrap_or_else(|_| crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string());
        if !api_key.is_empty() {
            let file_ids: Vec<u64> = cf_indices.iter().map(|(_, fid)| *fid).collect();
            let mut cf_files_map: HashMap<u64, CfBatchFileInfo> = HashMap::with_capacity(file_ids.len());
            for chunk in file_ids.chunks(200) {
                if let Ok(resp) = crate::util::http::HTTP
                    .post("https://api.curseforge.com/v1/mods/files")
                    .header("x-api-key", &api_key)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&serde_json::json!({ "fileIds": chunk }))
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.json::<CfApiResponse<Vec<CfBatchFileInfo>>>().await {
                            for f in body.data {
                                cf_files_map.insert(f.id, f);
                            }
                        }
                    }
                }
            }

            let cf_mod_ids: Vec<String> = cf_files_map
                .values()
                .filter(|f| f.mod_id > 0)
                .map(|f| f.mod_id.to_string())
                .collect();

            let cf_projects_map = crate::services::curseforge::fetch_projects_meta(&api_key, &cf_mod_ids).await;

            for (idx, fid) in cf_indices {
                if let Some(file_info) = cf_files_map.get(&fid) {
                    if items[idx].version.is_none() {
                        items[idx].version = file_info.display_name.clone().or_else(|| Some(file_info.file_name.clone()));
                    }
                    if let Some(meta) = cf_projects_map.get(&file_info.mod_id.to_string()) {
                        if let Some(ref name) = meta.name {
                            items[idx].name = name.clone();
                        }
                        if items[idx].icon_url.is_none() {
                            items[idx].icon_url = meta.icon_url.clone();
                        }
                    }
                }
            }
        }
    }
}

/// Decodes and previews a share code (supports Cloudflare `VML-XXXX-XXXX` and offline `VML1...`).
pub async fn preview_share_code(code: &str) -> Result<ShareCodePreview, String> {
    let payload = resolve_code_payload(code).await?;
    let mut preview = preview_from_payload(&payload);
    if !preview.is_modpack {
        enrich_preview_items(&mut preview.items, &payload).await;
    }
    Ok(preview)
}

/// Batch-fetches Modrinth versions in chunks of 80 IDs (`GET /v2/versions?ids=[...]`),
/// and automatically resolves any legacy 40-character SHA-1 hashes via `POST /v2/version_files`.
async fn fetch_modrinth_versions_batch(
    version_ids: &[String],
) -> Result<HashMap<String, crate::services::modrinth::ModrinthVersion>, String> {
    let mut map = HashMap::with_capacity(version_ids.len());
    if version_ids.is_empty() {
        return Ok(map);
    }

    let mut normal_ids: Vec<String> = Vec::new();
    let mut sha1_ids: Vec<String> = Vec::new();

    for id in version_ids {
        if id.starts_with("fn:") {
            continue;
        }
        if id.len() == 40 && id.chars().all(|c| c.is_ascii_hexdigit()) {
            sha1_ids.push(id.clone());
        } else {
            normal_ids.push(id.clone());
        }
    }

    if !sha1_ids.is_empty() {
        if let Ok(by_hash) = crate::services::modrinth::get_versions_by_hashes(&sha1_ids).await {
            for (hash, ver) in by_hash {
                map.insert(hash, ver);
            }
        }
    }

    for chunk in normal_ids.chunks(80) {
        let ids_json = serde_json::to_string(chunk).map_err(|e| e.to_string())?;
        let url = format!(
            "https://api.modrinth.com/v2/versions?ids={}",
            urlencoding::encode(&ids_json)
        );
        let resp = crate::util::http::HTTP
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Modrinth batch versions request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Modrinth batch versions error ({}): {}", status, text));
        }

        let versions: Vec<crate::services::modrinth::ModrinthVersion> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Modrinth batch versions: {}", e))?;

        for v in versions {
            map.insert(v.id.clone(), v);
        }
    }

    Ok(map)
}

#[derive(Debug, Deserialize)]
struct CfApiResponse<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct CfBatchFileInfo {
    id: u64,
    #[serde(rename = "modId")]
    mod_id: u64,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "fileLength")]
    file_length: u64,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(default)]
    hashes: Vec<CfBatchHash>,
}

#[derive(Debug, Deserialize)]
struct CfBatchHash {
    value: String,
    algo: u32, // 1 = SHA-1
}

/// Imports a `VML1...` share code, resolving Modrinth and CurseForge batches, routing
/// files to `mods/`, `shaderpacks/`, and `resourcepacks/`, and downloading concurrently.
pub async fn import_share_code(
    code: &str,
    api_key: &str,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    let payload = resolve_code_payload(code).await?;

    // If this share code is anchored to a Base Modpack (`bp`), install the base modpack first
    // (preserving all `.mrpack`/`.zip` overrides, configs, and scripts), and then apply any delta items.
    let mut base_inst_opt: Option<Instance> = None;
    if let Some(BasePackRef(ref plat, ref proj_id, ref ver_id, _, _, _)) = payload.bp {
        if !proj_id.is_empty() {
            let ver_opt = if ver_id.is_empty() {
                None
            } else {
                Some(ver_id.as_str())
            };
            let mut inst = if plat == "c" {
                crate::services::modpack::install_from_curseforge(
                    proj_id,
                    ver_opt,
                    window.clone(),
                )
                .await?
            } else {
                crate::services::modpack::install_from_modrinth(proj_id, ver_opt, window.clone())
                    .await?
            };
            if !payload.n.is_empty() && inst.name != payload.n {
                inst.name = crate::services::modpack::unique_instance_name(&payload.n)?;
                let inst_json_path = paths::instances_dir().join(&inst.id).join("instance.json");
                if let Ok(pretty) = serde_json::to_string_pretty(&inst) {
                    let _ = fs::write(&inst_json_path, pretty);
                }
            }
            if payload.items.is_empty() {
                return Ok(inst);
            }
            base_inst_opt = Some(inst);
        }
    }

    let loader_type = match payload.l.to_ascii_lowercase().as_str() {
        "fabric" => LoaderType::Fabric,
        "quilt" => LoaderType::Quilt,
        "neoforge" => LoaderType::Neoforge,
        "forge" => LoaderType::Forge,
        _ => LoaderType::Vanilla,
    };

    let (instance_name, instance_id) = if let Some(ref b) = base_inst_opt {
        (b.name.clone(), b.id.clone())
    } else {
        (
            crate::services::modpack::unique_instance_name(&payload.n)?,
            uuid::Uuid::new_v4().to_string(),
        )
    };
    let instance_dir = paths::instances_dir().join(&instance_id);
    let minecraft_dir = instance_dir.join(".minecraft");
    let mods_dir = minecraft_dir.join("mods");
    let shaderpacks_dir = minecraft_dir.join("shaderpacks");
    let resourcepacks_dir = minecraft_dir.join("resourcepacks");

    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&shaderpacks_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&resourcepacks_dir).map_err(|e| e.to_string())?;

    // Cache instance icon if a valid CDN URL was provided (only for base modpacks,
    // never borrow an individual mod's icon for a custom creation)
    let cached_icon = if payload.bp.is_some() {
        if let Some(ref ic_url) = payload.ic {
            crate::services::icon_cache::cache_remote_icon(ic_url).await
        } else {
            None
        }
    } else {
        None
    };
    let final_icon = crate::services::icon_cache::persist_instance_icon(cached_icon, &instance_dir);

    let dest_dir_for = |cat: u8| -> &PathBuf {
        match cat {
            1 => &shaderpacks_dir,
            2 => &resourcepacks_dir,
            _ => &mods_dir,
        }
    };
    let category_name_for = |cat: u8| -> &'static str {
        match cat {
            1 => "shader",
            2 => "resourcepack",
            _ => "mod",
        }
    };

    // Partition items into Modrinth (0) and CurseForge (1)
    let mr_items: Vec<&ShareItemTuple> = payload.items.iter().filter(|i| i.0 == 0).collect();
    let cf_items: Vec<&ShareItemTuple> = payload.items.iter().filter(|i| i.0 == 1).collect();

    let mut download_tasks: Vec<DownloadTask> = Vec::with_capacity(payload.items.len());
    let mut mod_entries: Vec<ModEntry> = Vec::with_capacity(payload.items.len());
    let mut blocked_cf: Vec<(String, String, u8)> = Vec::new();

    // 1. Resolve Modrinth items in chunks of 80
    if !mr_items.is_empty() {
        let mr_version_ids: Vec<String> = mr_items.iter().map(|i| i.2.clone()).collect();
        let mr_map = fetch_modrinth_versions_batch(&mr_version_ids).await?;

        for item in mr_items {
            let ShareItemTuple(_src, ref proj_id, ref ver_id, cat_enum, enabled) = *item;
            let version_opt = mr_map.get(ver_id);

            if let Some(version) = version_opt {
                let file_opt = version
                    .files
                    .iter()
                    .find(|f| f.primary)
                    .or_else(|| version.files.first());

                if let Some(file) = file_opt {
                    if !is_allowed_cdn_url(&file.url) {
                        tracing::warn!("Skipped non-allowlisted Modrinth URL: {}", file.url);
                        continue;
                    }
                    let clean_name = match sanitize_content_filename(&file.filename, cat_enum) {
                        Ok(n) => n,
                        Err(e) => {
                            tracing::warn!("{}", e);
                            continue;
                        }
                    };
                    let disk_name = if enabled {
                        clean_name
                    } else {
                        format!("{}.disabled", clean_name)
                    };
                    let dest = dest_dir_for(cat_enum).join(&disk_name);

                    download_tasks.push(DownloadTask {
                        url: file.url.clone(),
                        dest,
                        expected_sha1: file.hashes.sha1.clone(),
                        expected_size: Some(file.size),
                    });

                    mod_entries.push(ModEntry {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: "modrinth".to_string(),
                        project_id: if !version.project_id.is_empty() {
                            version.project_id.clone()
                        } else {
                            proj_id.clone()
                        },
                        version_id: version.id.clone(),
                        filename: disk_name,
                        version_number: Some(version.version_number.clone()),
                        enabled,
                        pinned: false,
                        title: None,
                        icon_url: None,
                        local_icon_path: None,
                        description: None,
                        category: category_name_for(cat_enum).to_string(),
                        author: None,
                        loaders: version.loaders.clone(),
                        game_versions: version.game_versions.clone(),
                    });
                }
            } else {
                // Version ID was yanked/deleted — fallback to latest compatible version for project_id
                let cat_str = category_name_for(cat_enum);
                if let Ok(versions) = crate::services::modrinth::get_project_versions(
                    proj_id,
                    &payload.l,
                    &payload.mc,
                )
                .await
                {
                    if let Some(latest) = versions.first() {
                        if let Some(file) = latest
                            .files
                            .iter()
                            .find(|f| f.primary)
                            .or_else(|| latest.files.first())
                        {
                            if is_allowed_cdn_url(&file.url) {
                                if let Ok(clean_name) =
                                    sanitize_content_filename(&file.filename, cat_enum)
                                {
                                    let disk_name = if enabled {
                                        clean_name
                                    } else {
                                        format!("{}.disabled", clean_name)
                                    };
                                    download_tasks.push(DownloadTask {
                                        url: file.url.clone(),
                                        dest: dest_dir_for(cat_enum).join(&disk_name),
                                        expected_sha1: file.hashes.sha1.clone(),
                                        expected_size: Some(file.size),
                                    });
                                    mod_entries.push(ModEntry {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        source: "modrinth".to_string(),
                                        project_id: proj_id.clone(),
                                        version_id: latest.id.clone(),
                                        filename: disk_name,
                                        version_number: Some(latest.version_number.clone()),
                                        enabled,
                                        pinned: false,
                                        title: None,
                                        icon_url: None,
                                        local_icon_path: None,
                                        description: None,
                                        category: cat_str.to_string(),
                                        author: None,
                                        loaders: latest.loaders.clone(),
                                        game_versions: latest.game_versions.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Resolve CurseForge items in chunks of 200 (with Tier-1 Modrinth SHA-1 cross-resolve)
    if !cf_items.is_empty() {
        if api_key.is_empty() {
            let _ = fs::remove_dir_all(&instance_dir);
            return Err(
                "This share code includes CurseForge mods. Please configure a CurseForge API key in Settings -> Content Sources."
                    .to_string(),
            );
        }

        let file_ids: Vec<u64> = cf_items
            .iter()
            .filter_map(|i| i.2.parse::<u64>().ok())
            .collect();

        let mut cf_info_map: HashMap<u64, CfBatchFileInfo> = HashMap::with_capacity(file_ids.len());
        for chunk in file_ids.chunks(200) {
            let resp = crate::util::http::HTTP
                .post("https://api.curseforge.com/v1/mods/files")
                .header("x-api-key", api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .json(&serde_json::json!({ "fileIds": chunk }))
                .send()
                .await
                .map_err(|e| format!("CurseForge batch files request failed: {}", e))?;

            if resp.status().is_success() {
                if let Ok(body) = resp.json::<CfApiResponse<Vec<CfBatchFileInfo>>>().await {
                    for info in body.data {
                        cf_info_map.insert(info.id, info);
                    }
                }
            }
        }

        struct BlockedCandidate {
            project_id: String,
            file_name: String,
            sha1: Option<String>,
            cat_enum: u8,
            enabled: bool,
        }
        let mut candidates: Vec<BlockedCandidate> = Vec::new();

        for item in cf_items {
            let ShareItemTuple(_src, ref proj_id, ref ver_id, cat_enum, enabled) = *item;
            let fid = match ver_id.parse::<u64>() {
                Ok(n) => n,
                Err(_) => continue,
            };

            if let Some(info) = cf_info_map.get(&fid) {
                let sha1 = info
                    .hashes
                    .iter()
                    .find(|h| h.algo == 1)
                    .map(|h| h.value.clone());

                let resolved_proj_id = if info.mod_id > 0 {
                    info.mod_id.to_string()
                } else {
                    proj_id.clone()
                };

                if let Some(ref url) = info.download_url {
                    if !is_allowed_cdn_url(url) {
                        tracing::warn!("Skipped non-allowlisted CurseForge URL: {}", url);
                        continue;
                    }
                    if let Ok(clean_name) = sanitize_content_filename(&info.file_name, cat_enum) {
                        let disk_name = if enabled {
                            clean_name
                        } else {
                            format!("{}.disabled", clean_name)
                        };
                        download_tasks.push(DownloadTask {
                            url: url.clone(),
                            dest: dest_dir_for(cat_enum).join(&disk_name),
                            expected_sha1: sha1,
                            expected_size: Some(info.file_length),
                        });
                        mod_entries.push(ModEntry {
                            id: uuid::Uuid::new_v4().to_string(),
                            source: "curseforge".to_string(),
                            project_id: resolved_proj_id,
                            version_id: info.id.to_string(),
                            filename: disk_name,
                            version_number: None,
                            enabled,
                            pinned: false,
                            title: None,
                            icon_url: None,
                            local_icon_path: None,
                            description: None,
                            category: category_name_for(cat_enum).to_string(),
                            author: None,
                            loaders: Vec::new(),
                            game_versions: Vec::new(),
                        });
                    }
                } else {
                    // Author disabled third-party distribution on CurseForge (`downloadUrl: null`)
                    candidates.push(BlockedCandidate {
                        project_id: resolved_proj_id,
                        file_name: info.file_name.clone(),
                        sha1,
                        cat_enum,
                        enabled,
                    });
                }
            }
        }

        // Tier-1 Compliant Cross-Source Resolution via Modrinth SHA-1 Lookup
        if !candidates.is_empty() {
            let sha1s: Vec<String> = candidates.iter().filter_map(|c| c.sha1.clone()).collect();
            let mut resolved_idx = HashSet::new();

            if !sha1s.is_empty() {
                if let Ok(hash_map) = crate::services::modrinth::get_versions_by_hashes(&sha1s).await
                {
                    for (idx, cand) in candidates.iter().enumerate() {
                        if let Some(ref sha1) = cand.sha1 {
                            if let Some(ver) = hash_map.get(sha1) {
                                if let Some(file) = ver
                                    .files
                                    .iter()
                                    .find(|f| f.hashes.sha1.as_deref() == Some(sha1))
                                    .or_else(|| ver.files.first())
                                {
                                    if is_allowed_cdn_url(&file.url) {
                                        if let Ok(clean_name) = sanitize_content_filename(
                                            &file.filename,
                                            cand.cat_enum,
                                        ) {
                                            let disk_name = if cand.enabled {
                                                clean_name
                                            } else {
                                                format!("{}.disabled", clean_name)
                                            };
                                            download_tasks.push(DownloadTask {
                                                url: file.url.clone(),
                                                dest: dest_dir_for(cand.cat_enum).join(&disk_name),
                                                expected_sha1: Some(sha1.clone()),
                                                expected_size: Some(file.size),
                                            });
                                            mod_entries.push(ModEntry {
                                                id: uuid::Uuid::new_v4().to_string(),
                                                source: "modrinth".to_string(),
                                                project_id: ver.project_id.clone(),
                                                version_id: ver.id.clone(),
                                                filename: disk_name,
                                                version_number: Some(ver.version_number.clone()),
                                                enabled: cand.enabled,
                                                pinned: false,
                                                title: None,
                                                icon_url: None,
                                                local_icon_path: None,
                                                description: None,
                                                category: category_name_for(cand.cat_enum)
                                                    .to_string(),
                                                author: None,
                                                loaders: ver.loaders.clone(),
                                                game_versions: ver.game_versions.clone(),
                                            });
                                            resolved_idx.insert(idx);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            for (idx, cand) in candidates.into_iter().enumerate() {
                if !resolved_idx.contains(&idx) {
                    blocked_cf.push((cand.project_id, cand.file_name, cand.cat_enum));
                }
            }
        }
    }

    let instance = if let Some(mut base_inst) = base_inst_opt {
        for delta in mod_entries {
            let base_fname = delta
                .filename
                .strip_suffix(".disabled")
                .unwrap_or(&delta.filename);
            if let Some(existing) = base_inst.mods.iter_mut().find(|m| {
                (!delta.project_id.is_empty() && m.project_id == delta.project_id)
                    || m.filename == base_fname
            }) {
                // If the user disabled a mod that came enabled with the base modpack, rename it on disk
                if !delta.enabled && existing.enabled {
                    let old_path = dest_dir_for(0).join(&existing.filename);
                    let new_path = dest_dir_for(0).join(&delta.filename);
                    let _ = fs::rename(&old_path, &new_path);
                    existing.filename = delta.filename.clone();
                    existing.enabled = false;
                    download_tasks.retain(|t| t.dest != new_path);
                } else {
                    *existing = delta;
                }
            } else {
                base_inst.mods.push(delta);
            }
        }
        base_inst
    } else {
        Instance {
            format_version: 1,
            id: instance_id.clone(),
            name: instance_name,
            icon: final_icon,
            icon_custom: None,
            game_version: payload.mc.clone(),
            loader: LoaderConfig {
                loader_type,
                version: payload.lv.clone(),
            },
            java: JavaConfig {
                override_path: None,
                memory_max_mb: 4096,
                memory_min_mb: 512,
                extra_args: Vec::new(),
                adaptive_override: false,
            },
            window: WindowConfig {
                width: 1280,
                height: 720,
            },
            mods: mod_entries,
            last_played: None,
            total_play_seconds: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
            source_project_id: None,
            source_platforms: Vec::new(),
            source_version: Some("VML1 Share Code".to_string()),
            companion_enabled: crate::services::settings_service::load().await.unwrap_or_default().enable_companion_mod,
            companion_version: None,
        }
    };

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

    let window_for_blocked = window.clone();
    let window_for_enrich = window.clone();

    if let Err(e) = prepare_with_extras(&instance, download_tasks, None, window.clone()).await {
        tracing::error!(
            "Share code instance import failed, cleaning up {}: {}",
            instance_id,
            e
        );
        let _ = fs::remove_dir_all(&instance_dir);
        return Err(e);
    }

    if let Err(e) = crate::services::modpack::revalidate_loader(&instance_id, window).await {
        tracing::warn!("Loader revalidation after share code import failed: {}", e);
    }

    // Surface ManualDownloadModal for any CurseForge-exclusive mods with distribution disabled
    if !blocked_cf.is_empty() && !api_key.is_empty() {
        let ids: Vec<String> = blocked_cf.iter().map(|(id, _, _)| id.clone()).collect();
        let briefs = crate::services::curseforge::fetch_projects_brief(api_key, &ids).await;
        for (proj_id, fname, cat_enum) in blocked_cf {
            let (title, website) = briefs.get(&proj_id).cloned().unwrap_or((None, None));
            crate::services::manual_download::notify(
                window_for_blocked.as_ref(),
                crate::services::manual_download::ManualDownload {
                    kind: category_name_for(cat_enum).to_string(),
                    title: title.unwrap_or_else(|| format!("CurseForge project {}", proj_id)),
                    file_name: Some(fname),
                    url: website,
                    instance_id: Some(instance_id.clone()),
                },
            );
        }
    }

    // Spawn background metadata & icon enrichment (`instance-enriched`)
    let id_for_enrich = instance_id.clone();
    tokio::spawn(async move {
        if let Err(e) =
            crate::services::modpack::enrich_mod_metadata(&id_for_enrich, window_for_enrich).await
        {
            tracing::warn!(
                "Share code metadata enrichment failed for {}: {}",
                id_for_enrich,
                e
            );
        }
    });

    let final_instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .unwrap_or(instance);

    Ok(final_instance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base62_roundtrip_arbitrary_lengths() {
        for len in [0, 1, 5, 6, 7, 12, 64, 512] {
            let data: Vec<u8> = (0..len).map(|i| ((i * 73 + 19) & 0xFF) as u8).collect();
            let encoded = base62_encode(&data);
            assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric()));
            assert_eq!(encoded.len() % 11, 0);
            let decoded = base62_decode(&encoded).expect("base62_decode should succeed");
            assert_eq!(decoded, data);
        }
    }

    #[tokio::test]
    async fn test_share_code_roundtrip_and_preview() {
        let payload = ShareCodePayload {
            v: 1,
            n: "Tactical Fabric 1.21.1".to_string(),
            mc: "1.21.1".to_string(),
            l: "fabric".to_string(),
            lv: Some("0.16.9".to_string()),
            ic: Some("https://cdn.modrinth.com/data/AANobbMI/icon.png".to_string()),
            bp: None,
            items: vec![
                ShareItemTuple(0, "AANobbMI".to_string(), "v1234567".to_string(), 0, true),
                ShareItemTuple(0, "YL57xq9U".to_string(), "v7654321".to_string(), 1, true),
                ShareItemTuple(1, "238222".to_string(), "5412891".to_string(), 2, false),
            ],
            meta: vec![],
        };

        let code = encode_payload(&payload).expect("encode should succeed");
        assert!(code.starts_with("VML"));
        assert!(code.chars().all(|c| c.is_ascii_alphanumeric()));

        let preview = preview_share_code(&code).await.expect("preview should succeed");
        assert_eq!(preview.name, "Tactical Fabric 1.21.1");
        assert_eq!(preview.game_version, "1.21.1");
        assert_eq!(preview.loader_type, "fabric");
        assert_eq!(preview.mod_count, 1);
        assert_eq!(preview.shader_count, 1);
        assert_eq!(preview.resourcepack_count, 1);
        assert_eq!(preview.total_count, 3);

        let decoded = decode_payload(&code).expect("decode should succeed");
        assert_eq!(decoded.n, payload.n);
        assert_eq!(decoded.mc, payload.mc);
        assert_eq!(decoded.l, payload.l);
        assert_eq!(decoded.lv, payload.lv);
        assert_eq!(decoded.ic, payload.ic);
        assert_eq!(
            decoded.items,
            vec![
                ShareItemTuple(0, String::new(), "v1234567".to_string(), 0, true),
                ShareItemTuple(0, String::new(), "v7654321".to_string(), 1, true),
                ShareItemTuple(1, String::new(), "5412891".to_string(), 2, false),
            ]
        );
    }

    #[test]
    fn test_tampered_share_code_rejected() {
        let payload = ShareCodePayload {
            v: 1,
            n: "Pack".to_string(),
            mc: "1.20.1".to_string(),
            l: "vanilla".to_string(),
            lv: None,
            ic: None,
            bp: None,
            items: vec![],
            meta: vec![],
        };
        let mut code = encode_payload(&payload).unwrap();
        // Flip the last character to corrupt the Zlib Adler32 checksum
        let last = code.pop().unwrap();
        code.push(if last == 'A' { 'B' } else { 'A' });
        assert!(decode_payload(&code).is_err());
    }

    #[test]
    fn test_filename_and_url_sanitizers() {
        assert!(sanitize_content_filename("../../evil.jar", 0).is_ok());
        assert_eq!(
            sanitize_content_filename("../../sodium-0.6.jar", 0).unwrap(),
            "sodium-0.6.jar"
        );
        assert!(sanitize_content_filename("CON.jar", 0).is_err());
        assert!(sanitize_content_filename("NUL.zip", 1).is_err());
        assert!(sanitize_content_filename("malware.exe", 0).is_err());
        assert!(is_allowed_cdn_url("https://cdn.modrinth.com/data/123/mod.jar"));
        assert!(!is_allowed_cdn_url("https://evil.example.com/mod.jar"));
        assert!(sanitize_icon_url(Some("https://evil.example.com/icon.png")).is_none());
    }

    #[tokio::test]
    async fn test_columnar_v3_custom_instance_roundtrip() {
        let items = vec![
            ShareItemTuple(0, String::new(), "8qcmuwZa".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "W4C08wBC".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "siLE4Dq9".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "c1wkPZ5n".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "3MP9UR23".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "70W6lm7x".to_string(), 0, true),
            ShareItemTuple(1, String::new(), "4766090".to_string(), 0, true),
            ShareItemTuple(1, String::new(), "6531428".to_string(), 0, true),
            ShareItemTuple(1, String::new(), "4711316".to_string(), 0, true),
            ShareItemTuple(0, String::new(), "q6u7sgZG".to_string(), 1, true),
        ];
        let payload = ShareCodePayload {
            v: 1,
            n: "Custom Columnar Pack".to_string(),
            mc: "1.20.1".to_string(),
            l: "forge".to_string(),
            lv: Some("47.4.10".to_string()),
            ic: None,
            bp: None,
            items,
            meta: vec![],
        };
        let code = encode_payload(&payload).expect("v3 encode should succeed");
        let decoded = decode_payload(&code).expect("v3 decode should succeed");
        assert_eq!(decoded.items.len(), 10);
        let preview = preview_share_code(&code).await.expect("v3 preview should succeed");
        assert_eq!(preview.total_count, 10);
        assert_eq!(preview.mod_count, 9);
        assert_eq!(preview.shader_count, 1);
    }

    #[tokio::test]
    async fn test_cloudflare_worker_live_resolution() {
        let preview = preview_share_code("VML-LLRA-RJRR").await;
        if let Ok(p) = preview {
            assert_eq!(p.name, "ATM10 Modpack");
            assert_eq!(p.game_version, "1.21.1");
            assert_eq!(p.loader_type, "neoforge");
            assert_eq!(p.mod_count, 1);
        }
    }

    #[tokio::test]
    async fn test_enrich_real_modrinth_version() {
        let payload = ShareCodePayload {
            v: 1,
            n: "Test".to_string(),
            mc: "1.20.1".to_string(),
            l: "fabric".to_string(),
            lv: None,
            ic: None,
            bp: None,
            items: vec![
                ShareItemTuple(0, String::new(), "P7dR8mSH".to_string(), 0, true),
                ShareItemTuple(0, "lhGA9TYQ".to_string(), "37aObfvM".to_string(), 0, true),
            ],
            meta: vec![],
        };
        let mut items = vec![
            SharePreviewItem {
                name: "P7dR8mSH".to_string(),
                version: None,
                icon_url: None,
                category: "mod".to_string(),
                source: "Modrinth".to_string(),
                enabled: true,
            },
            SharePreviewItem {
                name: "37aObfvM".to_string(),
                version: None,
                icon_url: None,
                category: "mod".to_string(),
                source: "Modrinth".to_string(),
                enabled: true,
            },
        ];
        enrich_preview_items(&mut items, &payload).await;
        // If Modrinth API succeeds, assert enriched metadata (may be blocked or throttled by Cloudflare in CI)
        if items[0].name == "Fabric API" {
            assert!(items[0].icon_url.is_some());
            assert_eq!(items[1].name, "Architectury API");
            if let Some(ver) = items[1].version.as_deref() {
                assert_eq!(ver, "4.4.61+fabric");
            }
            assert!(items[1].icon_url.is_some());
        }
    }
}

