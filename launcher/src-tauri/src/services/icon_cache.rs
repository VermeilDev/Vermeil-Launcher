// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Icon cache.
//!
//! Mods, resource packs, shaders, and modpacks each carry a remote `icon_url`
//! pointing at a CDN-hosted PNG. We don't want to re-fetch those every time a
//! card is rendered, and we don't want the UI to break offline. So whenever we
//! install something, we fetch the icon once and write it to a content-
//! addressed file under `%LOCALAPPDATA%\Vermeil\icons\`.
//!
//! The frontend then uses Tauri's `asset://` protocol to read the cached file
//! directly off disk — no network hit, no CORS, works offline.
//!
//! Cache key: SHA-1 of the lowercased URL. Same URL → same file → dedup
//! across instances. (Modrinth's icon CDN serves the same hashed URL for
//! the same icon across all consumers, so this dedups well in practice.)

use sha1::{Digest, Sha1};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::util::http::HTTP;
use crate::util::paths;

/// Try to cache an icon from `url`. Returns the absolute path to the cached
/// file as a string on success, `None` on any failure.
///
/// Failures are deliberately non-fatal: a missing icon should never block an
/// install or update flow. The caller falls back to the remote URL (or to a
/// generic placeholder), and we just retry on the next install.
pub async fn cache_remote_icon(url: &str) -> Option<String> {
    if url.trim().is_empty() {
        return None;
    }

    let icons_dir = paths::icons_cache_dir();
    if let Err(e) = tokio::fs::create_dir_all(&icons_dir).await {
        tracing::debug!("icon cache: create_dir_all failed for {:?}: {}", icons_dir, e);
        return None;
    }

    // Hash the URL to get a stable file name. Lowercase first so trivial casing
    // differences don't blow up the cache.
    let mut hasher = Sha1::new();
    hasher.update(url.trim().to_lowercase().as_bytes());
    let hash = hex_lower(&hasher.finalize());

    // Pick the file extension from the URL path. We default to `.png` because
    // every icon source we currently talk to (Modrinth, CurseForge) serves PNGs
    // and Tauri's webview happily renders unknown extensions as raw PNG anyway.
    let ext = guess_extension(url).unwrap_or_else(|| "png".to_string());
    let path: PathBuf = icons_dir.join(format!("{}.{}", hash, ext));

    if path.exists() {
        return Some(clean_path_string(&path));
    }

    // Not cached yet — go fetch.
    let resp = match HTTP.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::debug!("icon cache: {} returned status {}", url, r.status());
            return None;
        }
        Err(e) => {
            tracing::debug!("icon cache: GET {} failed: {}", url, e);
            return None;
        }
    };

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!("icon cache: read body for {} failed: {}", url, e);
            return None;
        }
    };

    // Write to a `.part` file first and rename so a partial download never
    // looks cached.
    let part = path.with_extension(format!("{}.part", ext));
    let mut file = match tokio::fs::File::create(&part).await {
        Ok(f) => f,
        Err(e) => {
            tracing::debug!("icon cache: create {:?}: {}", part, e);
            return None;
        }
    };
    if let Err(e) = file.write_all(&bytes).await {
        tracing::debug!("icon cache: write {:?}: {}", part, e);
        return None;
    }
    drop(file);

    if let Err(e) = tokio::fs::rename(&part, &path).await {
        if path.exists() {
            let _ = tokio::fs::remove_file(&part).await;
            return Some(clean_path_string(&path));
        }
        tracing::debug!("icon cache: rename {:?} -> {:?}: {}", part, path, e);
        return None;
    }

    Some(clean_path_string(&path))
}

pub fn clean_path_string(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s
}

fn guess_extension(url: &str) -> Option<String> {
    // Strip query string before sniffing.
    let url = url.split('?').next().unwrap_or(url);
    let last = url.rsplit('/').next()?;
    let dot = last.rfind('.')?;
    let ext = &last[dot + 1..];
    // Sanity: only accept short alphanumeric extensions. Anything weirder and
    // we fall back to PNG.
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_lowercase())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Cache raw icon bytes directly to disk and return as a clean file path.
/// Used for embedded icons extracted from modpack archives (.mrpack, .zip).
pub async fn cache_icon_bytes(bytes: &[u8], ext: &str) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let icons_dir = paths::icons_cache_dir();
    if let Err(e) = tokio::fs::create_dir_all(&icons_dir).await {
        tracing::debug!("icon cache: create_dir_all failed for {:?}: {}", icons_dir, e);
        return None;
    }

    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let hash = hex_lower(&hasher.finalize());

    let clean_ext = if ext.is_empty() { "png" } else { ext.trim_start_matches('.') };
    let path: PathBuf = icons_dir.join(format!("{}.{}", hash, clean_ext));

    if !path.exists() {
        if let Err(e) = tokio::fs::write(&path, bytes).await {
            tracing::debug!("icon cache: write {:?} failed: {}", path, e);
            return None;
        }
    }

    Some(clean_path_string(&path))
}

/// Persist an instance's icon into the instance's own durable folder (`<instance_dir>/icon.<ext>`).
///
/// If `source_icon` is a local file (e.g. from the volatile cache or an extracted archive),
/// this copies it into the instance directory so it survives cache purges.
/// If `source_icon` is None, missing, or "cube", it returns `"cube"`.
pub fn persist_instance_icon(
    source_icon: Option<String>,
    instance_dir: &std::path::Path,
) -> String {
    let Some(src_str) = source_icon else {
        return "cube".to_string();
    };

    let trimmed = src_str.trim();
    if trimmed.is_empty() || trimmed == "cube" {
        return "cube".to_string();
    }

    // Remote URLs or data URIs are kept as-is
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("asset:")
    {
        return trimmed.to_string();
    }

    let src = std::path::Path::new(trimmed);
    if src.exists() {
        let _ = std::fs::create_dir_all(instance_dir);
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        let dest = instance_dir.join(format!("icon.{}", ext));
        if src != dest {
            if let Err(e) = std::fs::copy(src, &dest) {
                tracing::warn!("Failed to copy icon from {:?} to {:?}: {}", src, dest, e);
                return clean_path_string(src);
            }
        }
        clean_path_string(&dest)
    } else {
        // Source file doesn't exist — check if the instance directory already has an icon
        for ext in ["png", "webp", "jpg", "jpeg"] {
            let candidate = instance_dir.join(format!("icon.{}", ext));
            if candidate.exists() {
                return clean_path_string(&candidate);
            }
        }
        "cube".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persist_instance_icon_copies_to_instance_dir() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_icon_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp);
        let cache_icon = temp.join("cached_icon.webp");
        std::fs::write(&cache_icon, b"dummy-webp-data").unwrap();

        let inst_dir = temp.join("my-instance");
        let result = persist_instance_icon(Some(cache_icon.to_string_lossy().to_string()), &inst_dir);

        let target_icon = inst_dir.join("icon.webp");
        assert!(target_icon.exists());
        assert_eq!(result, clean_path_string(&target_icon));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_persist_instance_icon_missing_falls_back_to_cube() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_icon_{}", uuid::Uuid::new_v4()));
        let inst_dir = temp.join("my-instance");
        let ghost_path = temp.join("nonexistent.png").to_string_lossy().to_string();

        let result = persist_instance_icon(Some(ghost_path), &inst_dir);
        assert_eq!(result, "cube");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_persist_instance_icon_preserves_remote_urls() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_icon_{}", uuid::Uuid::new_v4()));
        let inst_dir = temp.join("my-instance");
        let remote = "https://cdn.modrinth.com/icon.png".to_string();

        let result = persist_instance_icon(Some(remote.clone()), &inst_dir);
        assert_eq!(result, remote);
        let _ = std::fs::remove_dir_all(&temp);
    }
}

