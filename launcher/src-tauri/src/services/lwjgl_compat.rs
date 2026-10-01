// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Linux-only LWJGL 2 substitution for legacy Minecraft (≤ 1.12.2).
//!
//! Minecraft ≤ 1.12.2 ships **LWJGL 2**, whose `LinuxDisplay.getAvailableDisplayModes`
//! indexes an empty XRandR display-mode list under Wayland/XWayland and throws
//! `ArrayIndexOutOfBoundsException` in `Display.<clinit>` — before any game or mod
//! code runs (Mojang MC-97823). Even Mojang's `2.9.4-nightly-20150209` has this.
//!
//! The fix is to swap in **Legacy Fabric's patched** `org.lwjgl.lwjgl:*` build
//! (`2.9.4+legacyfabric.N`): its `lwjgl.jar` tolerates an empty mode list and its
//! natives ship the corrected `liblwjgl.so`. These are the same Maven artifacts a
//! Legacy Fabric instance already uses — which is exactly why those don't crash
//! while a *vanilla* (or Forge) legacy instance does.
//!
//! Scope: this only acts on **Linux**, and only when a **stock** (non-legacyfabric)
//! LWJGL 2 is on the classpath. Windows/macOS, LWJGL 3 (MC ≥ 1.13), and instances
//! already carrying the patched build are left untouched. The function is a runtime
//! no-op off Linux (guarded by `cfg!`, not `#[cfg]`, so it still type-checks on every
//! platform).

use crate::services::download::{download_file, DownloadTask};
use crate::util::paths;
use std::fs;
use std::path::{Path, PathBuf};

const LEGACY_FABRIC_MAVEN: &str = "https://maven.legacyfabric.net";

/// Pinned fallback if the Maven `maven-metadata.xml` can't be fetched (offline
/// grace). The live `<release>` is preferred; this is just a known-good floor.
const FALLBACK_VERSION: &str = "2.9.4+legacyfabric.17";

/// Filesystem path fragment identifying an LWJGL **2** artifact. LWJGL 2's group
/// is `org.lwjgl.lwjgl` (→ `org/lwjgl/lwjgl/`) and its artifacts all begin with
/// `lwjgl` (`lwjgl`, `lwjgl_util`, `lwjgl-platform`) — so the doubled group
/// segment is followed by `lwjgl`. LWJGL 3's group is `org.lwjgl` (→ `org/lwjgl/`),
/// whose bare `lwjgl` artifact yields `org/lwjgl/lwjgl/<version>/…` — the segment
/// after the doubled `org/lwjgl/lwjgl/` is a version (`3.x`), not `lwjgl`. Matching
/// `…/org/lwjgl/lwjgl/lwjgl` therefore targets v2 only and never v3.
const LWJGL2_PATH_FRAGMENT: &str = "/org/lwjgl/lwjgl/lwjgl";

/// Substitute Mojang's buggy LWJGL 2 with Legacy Fabric's patched build on Linux.
///
/// Mutates `classpath` in place (drops stock `org.lwjgl.lwjgl:*` jars, adds the
/// patched `lwjgl`/`lwjgl_util`) and overwrites the extracted natives in
/// `natives_dir` with the patched `.so` files. Best-effort: on any network/IO
/// failure it logs and leaves the classpath unchanged rather than failing the
/// launch (the result is the pre-existing crash-on-Wayland behaviour, never worse).
pub async fn apply(classpath: &mut Vec<PathBuf>, natives_dir: &Path) -> Result<(), String> {
    // Only Linux is affected. Compiled everywhere (so it type-checks on Windows),
    // but a no-op at runtime elsewhere.
    if !cfg!(target_os = "linux") {
        return Ok(());
    }

    // Act only when a STOCK LWJGL 2 is present (skip modern LWJGL 3 and instances
    // that already carry the Legacy Fabric build, e.g. Legacy Fabric itself).
    let has_stock = classpath.iter().any(|p| {
        let s = norm(p);
        s.contains(LWJGL2_PATH_FRAGMENT) && !s.contains("legacyfabric")
    });
    if !has_stock {
        return Ok(());
    }

    let version = resolve_version().await;
    tracing::info!("Legacy LWJGL 2 on Linux — substituting patched lwjgl {version}");

    // Download the patched jars first; only mutate the classpath once they're in
    // place, so a failed download can't leave the classpath missing LWJGL.
    let lwjgl = match ensure_jar("lwjgl", &version).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("LWJGL patch skipped (lwjgl download failed): {e}");
            return Ok(());
        }
    };
    let lwjgl_util = match ensure_jar("lwjgl_util", &version).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("LWJGL patch skipped (lwjgl_util download failed): {e}");
            return Ok(());
        }
    };

    // Overwrite the stock natives extracted earlier with the patched ones.
    if let Err(e) = patch_natives(&version, natives_dir).await {
        tracing::error!("LWJGL patch skipped (natives failed): {e}");
        return Ok(());
    }

    // Drop every stock org.lwjgl.lwjgl:* entry (lwjgl, lwjgl_util, lwjgl-platform)
    // and prepend the patched jars so they win on the classpath.
    classpath.retain(|p| !norm(p).contains(LWJGL2_PATH_FRAGMENT));
    classpath.insert(0, lwjgl);
    classpath.insert(1, lwjgl_util);

    Ok(())
}

/// Normalize a path to forward slashes for substring matching.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// The latest patched version from the Legacy Fabric Maven, or the pinned
/// fallback if metadata can't be read.
async fn resolve_version() -> String {
    let url = format!(
        "{LEGACY_FABRIC_MAVEN}/org/lwjgl/lwjgl/lwjgl/maven-metadata.xml"
    );
    match crate::util::http::HTTP.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            extract_release(&body).unwrap_or_else(|| FALLBACK_VERSION.to_string())
        }
        _ => FALLBACK_VERSION.to_string(),
    }
}

/// Pull the `<release>` value out of a Maven `maven-metadata.xml`.
fn extract_release(xml: &str) -> Option<String> {
    let start = xml.find("<release>")? + "<release>".len();
    let end = xml[start..].find("</release>")? + start;
    let v = xml[start..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// Download a patched LWJGL jar (`lwjgl` / `lwjgl_util`) into the shared
/// libraries dir if not already cached, returning its path.
async fn ensure_jar(artifact: &str, version: &str) -> Result<PathBuf, String> {
    let rel = format!("org/lwjgl/lwjgl/{artifact}/{version}/{artifact}-{version}.jar");
    let dest = paths::libraries_dir().join(&rel);
    if dest.exists() {
        return Ok(dest);
    }
    let url = format!("{LEGACY_FABRIC_MAVEN}/{rel}");
    let task = DownloadTask {
        url,
        dest: dest.clone(),
        expected_sha1: None,
        expected_size: None,
    };
    download_file(&crate::util::http::HTTP, &task).await?;
    Ok(dest)
}

/// Download the patched `lwjgl-platform` natives jar for Linux and extract its
/// `.so` files into `natives_dir`, overwriting the stock natives extracted by
/// `ensure_natives`.
async fn patch_natives(version: &str, natives_dir: &Path) -> Result<(), String> {
    let classifier = format!("natives-{}", crate::util::platform::natives_map_key());
    let rel = format!(
        "org/lwjgl/lwjgl/lwjgl-platform/{version}/lwjgl-platform-{version}-{classifier}.jar"
    );
    let dest = paths::libraries_dir().join(&rel);
    if !dest.exists() {
        let url = format!("{LEGACY_FABRIC_MAVEN}/{rel}");
        let task = DownloadTask {
            url,
            dest: dest.clone(),
            expected_sha1: None,
            expected_size: None,
        };
        download_file(&crate::util::http::HTTP, &task).await?;
    }

    fs::create_dir_all(natives_dir).map_err(|e| e.to_string())?;
    let file = fs::File::open(&dest).map_err(|e| format!("Open patched natives: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Read patched natives: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        // Native shared objects only — skip META-INF and version manifests.
        if !(name.ends_with(".so") || name.ends_with(".dylib")) {
            continue;
        }
        let file_name = match Path::new(&name).file_name() {
            Some(n) => n,
            None => continue,
        };
        let out_path = natives_dir.join(file_name);
        // Always overwrite: the patched .so must replace the stock one.
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }

    Ok(())
}
