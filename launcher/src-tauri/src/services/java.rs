// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Java location detection and management.
//!
//! Discovers JREs on disk so users can plug in any existing install instead
//! of being forced onto our auto-installed one.
//!
//! Discovery sources, all unioned and deduplicated:
//!
//! 1. The launcher's own auto-installed JREs at `<data>/java/jdk-<major>/...`
//! 2. The `PATH` env var (anything resolving to a `java(.exe)`)
//! 3. `JAVA_HOME` env var
//! 4. Hardcoded common install locations per OS (Eclipse Adoptium, Oracle, etc.)
//! 5. Windows Registry: `HKLM\Software\(WOW6432Node\)?JavaSoft\*` (Windows only)
//!
//! Each candidate path is validated by spawning `java -version` and parsing the
//! stderr output to extract the major version. Invalid candidates are dropped.
//!
//! All subprocess spawns use `CREATE_NO_WINDOW` on Windows so we don't flash a
//! console — Java is a console-subsystem binary and would otherwise pop one up.

use crate::util::paths;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows constant — equivalent to `winbase::CREATE_NO_WINDOW`. Avoids pulling
/// in the full `windows` crate just for this one flag.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

lazy_static::lazy_static! {
    static ref JAVA_INSTALL_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

/// Readiness sentinel written inside a JDK directory after extraction is 100% complete.
pub const READY_SENTINEL: &str = ".vermeil_ready";

/// Check if a directory contains a verified, structurally intact Java runtime
/// and locate its java executable. Returns None if incomplete, corrupt, or missing.
pub fn find_valid_java_in(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    let exe_name = crate::util::platform::java_exe_name();

    // 1. Direct structure: dir/bin/java(.exe)
    let direct_exe = dir.join("bin").join(exe_name);
    if direct_exe.is_file() && is_structurally_valid_jre(dir) {
        return Some(direct_exe);
    }

    // 2. Nested structure: dir/<nested_folder>/bin/java(.exe) (Adoptium archives)
    let has_root_sentinel = dir.join(READY_SENTINEL).exists();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                let nested_exe = child.join("bin").join(exe_name);
                if nested_exe.is_file()
                    && (has_root_sentinel || is_structurally_valid_jre(&child))
                {
                    return Some(nested_exe);
                }
            }
        }
    }

    None
}

/// Check if a directory possesses core JRE files to prevent using half-extracted archives.
fn is_structurally_valid_jre(dir: &Path) -> bool {
    if dir.join(READY_SENTINEL).exists() {
        return true;
    }
    let lib = dir.join("lib");
    lib.join("jvm.cfg").is_file()
        || lib.join("modules").is_file()
        || lib.join("rt.jar").is_file()
}

/// Known managed vendor subdirectories inside `<data>/java/`.
pub const MANAGED_VENDORS: &[&str] = &["amazon", "adoptium", "zulu", "corretto", "microsoft", "oracle"];

/// Find an existing valid managed Java executable for the given major version.
/// Checks vendor subdirectories (e.g. `java/amazon/jdk-21/bin/java.exe`,
/// `java/adoptium/jdk-25/bin/java.exe`) and falls back to legacy root `java/jdk-<major>/`.
pub fn find_managed_java(major: u8) -> Option<PathBuf> {
    for vendor in MANAGED_VENDORS {
        let dir = paths::java_dir().join(vendor).join(format!("jdk-{}", major));
        if let Some(exe) = find_valid_java_in(&dir) {
            return Some(exe);
        }
    }
    let legacy_dir = paths::java_dir().join(format!("jdk-{}", major));
    find_valid_java_in(&legacy_dir)
}


/// Check if a verified Java installation exists for the requested major version.
pub fn is_java_installed(major: u8) -> bool {
    find_managed_java(major).is_some()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum JavaSource {
    /// JRE auto-installed by the launcher under `<data>/java/jdk-N/`.
    AutoInstalled,
    /// JRE bundled with the app installer (future: `<install>/runtime/jre-N/`).
    Bundled,
    /// Found by scanning `PATH` or `JAVA_HOME`.
    EnvPath,
    /// Found in a hardcoded common install directory.
    CommonDir,
    /// Found via the Windows Registry.
    Registry,
    /// Manually picked by the user via the Browse button.
    Manual,
}

/// Supported managed Java distributions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JavaDistribution {
    Adoptium,
    Zulu,
    Corretto,
}

impl JavaDistribution {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "zulu" | "azul" | "azul_zulu" => JavaDistribution::Zulu,
            "corretto" | "amazon" | "amazon_corretto" => JavaDistribution::Corretto,
            _ => JavaDistribution::Adoptium,
        }
    }

    pub fn dir_name(&self) -> &'static str {
        match self {
            JavaDistribution::Adoptium => "adoptium",
            JavaDistribution::Zulu => "zulu",
            JavaDistribution::Corretto => "amazon",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            JavaDistribution::Adoptium => "Eclipse Adoptium (Temurin)",
            JavaDistribution::Zulu => "Azul Zulu",
            JavaDistribution::Corretto => "Amazon Corretto",
        }
    }

    pub fn vendor_name(&self) -> &'static str {
        match self {
            JavaDistribution::Adoptium => "Eclipse Foundation",
            JavaDistribution::Zulu => "Azul Systems",
            JavaDistribution::Corretto => "Amazon",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaInstall {
    /// Major version, e.g. `21` for `21.0.6+9`.
    pub major: u8,
    /// Full version string parsed from `java -version`.
    pub full_version: String,
    /// Architecture string, e.g. `"x86_64"` or `"aarch64"`. Best-effort.
    pub arch: String,
    /// Absolute path to the `java`/`javaw`/`java.exe` executable.
    pub path: String,
    pub source: JavaSource,
    /// True when the executable resolves to somewhere inside `paths::java_dir()`,
    /// i.e. Vermeil owns it and is allowed to delete it. Path-based rather than
    /// source-based so a manually-typed path that happens to point into our
    /// own dir is still recognized as deletable, and a path tagged
    /// `auto_installed` from a stale cache can't trick the UI into offering
    /// to delete a JRE outside the dir we manage.
    #[serde(default)]
    pub is_vermeil_managed: bool,
}

/// Public entry point: detect every JRE we can find on the system.
///
/// The result is sorted descending by major (newest first) and then by
/// the alphabetic path for stability across calls. Duplicates (same canonical
/// path) are merged, with the more-specific source taking precedence
/// (`AutoInstalled` > `Registry` > `CommonDir` > `EnvPath`).
#[tracing::instrument]
pub async fn detect_installations() -> Vec<JavaInstall> {
    let mut candidates: Vec<(PathBuf, JavaSource)> = Vec::new();

    // Source 1 — auto-installed
    for path in find_auto_installed() {
        candidates.push((path, JavaSource::AutoInstalled));
    }

    // Source 2 — PATH
    for path in find_in_path() {
        candidates.push((path, JavaSource::EnvPath));
    }

    // Source 3 — JAVA_HOME
    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        let candidate = PathBuf::from(java_home).join("bin");
        candidates.push((candidate, JavaSource::EnvPath));
    }

    // Source 4 — common install dirs (per-OS)
    for path in find_in_common_dirs() {
        candidates.push((path, JavaSource::CommonDir));
    }

    // Source 5 — Windows Registry
    #[cfg(windows)]
    for path in find_in_registry() {
        candidates.push((path, JavaSource::Registry));
    }

    // Validate every candidate (concurrent). We canonicalize paths before
    // dedupe so symlinks/junctions don't appear twice.
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut installs: Vec<JavaInstall> = Vec::new();

    for (raw_path, source) in candidates {
        let exe = resolve_java_exe(&raw_path);
        let canon = match exe.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !seen.insert(canon.clone()) {
            continue;
        }
        if let Some(install) = validate_java(&canon, source.clone()).await {
            installs.push(install);
        }
    }

    // Sort: newest major first; within the same major, prefer auto-installed
    // (so the launcher's own JRE shows up before a stray JDK on PATH).
    installs.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| source_priority(&a.source).cmp(&source_priority(&b.source)))
            .then_with(|| a.path.cmp(&b.path))
    });
    installs
}

fn source_priority(s: &JavaSource) -> u8 {
    match s {
        JavaSource::Bundled => 0,
        JavaSource::AutoInstalled => 1,
        JavaSource::Manual => 2,
        JavaSource::Registry => 3,
        JavaSource::CommonDir => 4,
        JavaSource::EnvPath => 5,
    }
}

/// Validate a single user-supplied path. Used by the "Browse" command to
/// confirm the user picked a working java.exe before we save it.
pub async fn validate_path(raw_path: &str) -> Result<JavaInstall, String> {
    let candidate = PathBuf::from(raw_path);
    let exe = resolve_java_exe(&candidate);
    let canon = exe
        .canonicalize()
        .map_err(|e| format!("Path doesn't exist: {}", e))?;
    validate_java(&canon, JavaSource::Manual)
        .await
        .ok_or_else(|| "That file doesn't appear to be a valid Java executable.".to_string())
}

/// If the given path is a `bin/` dir (or a JDK root), normalize to the actual
/// `java(.exe)` executable. If it's already pointing at the executable, return
/// it as-is.
fn resolve_java_exe(p: &Path) -> PathBuf {
    let exe_name = if cfg!(windows) { "javaw.exe" } else { "java" };
    let alt_name = if cfg!(windows) { "java.exe" } else { "java" };

    // Already pointing at an executable
    if p.is_file() {
        return p.to_path_buf();
    }

    // Pointing at a bin dir
    let direct = p.join(exe_name);
    if direct.exists() {
        return direct;
    }
    let alt = p.join(alt_name);
    if alt.exists() {
        return alt;
    }

    // Pointing at a JDK root that contains a bin dir
    let nested = p.join("bin").join(exe_name);
    if nested.exists() {
        return nested;
    }
    let nested_alt = p.join("bin").join(alt_name);
    if nested_alt.exists() {
        return nested_alt;
    }

    // Give up — return whatever the caller passed in. Validation will reject it.
    p.to_path_buf()
}

/// Spawn `java -version` and parse the stderr output. `java -version` writes
/// to stderr by tradition (not stdout) — easy to forget.
async fn validate_java(exe: &Path, source: JavaSource) -> Option<JavaInstall> {
    let exe_for_spawn = exe.to_path_buf();
    let exe_for_display = exe.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&exe_for_spawn);
        cmd.arg("-version");
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
    })
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{}\n{}", stderr, stdout);

    let (major, full_version) = parse_java_version(&combined)?;
    let arch = parse_java_arch(&combined);

    // Resolve the canonical path one more time (for display) — we already
    // checked it canonicalizes during dedupe but recompute here so the
    // serialized path is the absolute one.
    let display_path = exe_for_display.canonicalize().ok()?;
    let display_string = strip_extended_prefix(&display_path.to_string_lossy());

    // Path-based "is this ours?" check. Both sides go through canonicalize
    // so symlinks, junctions, and case-insensitive Windows paths all
    // resolve consistently. If `paths::java_dir()` doesn't exist yet (clean
    // install, no JREs downloaded), the canonicalize fails and we fall
    // through to `false`, which is correct: nothing can be inside a
    // directory that doesn't exist.
    let is_vermeil_managed = paths::java_dir()
        .canonicalize()
        .ok()
        .map(|root| display_path.starts_with(&root))
        .unwrap_or(false);

    Some(JavaInstall {
        major,
        full_version,
        arch,
        path: display_string,
        source,
        is_vermeil_managed,
    })
}

/// Strip the Windows `\\?\` extended-length path prefix that `canonicalize()`
/// produces. Most users see paths like `C:\Users\...` everywhere else, so
/// surfacing the raw NT path makes the UI look broken even though it's
/// technically correct. No-op on non-Windows.
fn strip_extended_prefix(p: &str) -> String {
    #[cfg(windows)]
    {
        // `\\?\C:\foo\bar` → `C:\foo\bar`
        // `\\?\UNC\server\share\foo` → `\\server\share\foo` (rarely seen but handled)
        if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = p.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    p.to_string()
}

/// Parse "openjdk version \"21.0.6\" 2025-01-21" or similar.
/// Returns (major, full_version_string).
fn parse_java_version(output: &str) -> Option<(u8, String)> {
    // Look for the "version "X.Y.Z"" block
    let start = output.find("version \"")?;
    let after = &output[start + 9..];
    let end = after.find('"')?;
    let raw = &after[..end];

    // Old-style "1.8.0_412" → major 8
    // New-style "21.0.6" → major 21
    let major_str = if let Some(stripped) = raw.strip_prefix("1.") {
        stripped.split('.').next()?
    } else {
        raw.split('.').next()?
    };
    let major: u8 = major_str.parse().ok()?;

    Some((major, raw.to_string()))
}

fn parse_java_arch(output: &str) -> String {
    if output.contains("64-Bit") || output.contains("aarch64") || output.contains("amd64") {
        if output.contains("aarch64") {
            "aarch64".to_string()
        } else {
            "x86_64".to_string()
        }
    } else if output.contains("32-Bit") {
        "x86".to_string()
    } else {
        "unknown".to_string()
    }
}

// ─── Source 1: auto-installed JREs ──────────────────────────────────────────

fn find_auto_installed() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let java_dir = paths::java_dir();
    let Ok(entries) = std::fs::read_dir(&java_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name_str = entry.file_name().to_string_lossy().to_string();
        if name_str.starts_with('.') {
            continue;
        }
        // 1. Direct root JDK: e.g. java/jdk-25 (legacy or flat installation)
        if name_str.starts_with("jdk-") || p.join("bin").is_dir() {
            if let Some(exe) = find_valid_java_in(&p) {
                out.push(exe);
                continue;
            }
        }
        // 2. Vendor subdirectories: e.g. java/amazon/jdk-21 or java/adoptium/jdk-25
        if let Ok(sub_entries) = std::fs::read_dir(&p) {
            for sub in sub_entries.flatten() {
                let sub_p = sub.path();
                if sub_p.is_dir() && !sub.file_name().to_string_lossy().starts_with('.') {
                    if let Some(exe) = find_valid_java_in(&sub_p) {
                        out.push(exe);
                    }
                }
            }
        }
    }
    out
}

// ─── Source 2: PATH ─────────────────────────────────────────────────────────

fn find_in_path() -> Vec<PathBuf> {
    let Some(path_var) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    std::env::split_paths(&path_var).collect()
}

// ─── Source 4: hardcoded common dirs ────────────────────────────────────────

#[cfg(windows)]
fn find_in_common_dirs() -> Vec<PathBuf> {
    let roots = [
        r"C:\Program Files\Java",
        r"C:\Program Files (x86)\Java",
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files (x86)\Eclipse Adoptium",
        r"C:\Program Files\Eclipse Foundation",
        r"C:\Program Files\Microsoft\jdk",
        r"C:\Program Files\Zulu",
        r"C:\Program Files\Amazon Corretto",
    ];
    let mut out = Vec::new();
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                out.push(entry.path());
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn find_in_common_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let jvms = "/Library/Java/JavaVirtualMachines";
    if let Ok(entries) = std::fs::read_dir(jvms) {
        for entry in entries.flatten() {
            out.push(entry.path().join("Contents/Home/bin"));
        }
    }
    out.push(PathBuf::from(
        "/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin",
    ));
    out
}

#[cfg(target_os = "linux")]
fn find_in_common_dirs() -> Vec<PathBuf> {
    let roots = [
        "/usr/lib/jvm",
        "/usr/java",
        "/opt/java",
        "/opt/jdk",
        "/opt/jdks",
    ];
    let mut out = Vec::new();
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                out.push(entry.path());
                out.push(entry.path().join("bin"));
            }
        }
    }
    out
}

// ─── Source 5: Windows Registry ─────────────────────────────────────────────

#[cfg(windows)]
fn find_in_registry() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let mut out = Vec::new();
    // Vendor keys to scan. Each hosts subkeys per installed major.
    let keys = [
        "Software\\JavaSoft\\Java Runtime Environment",
        "Software\\JavaSoft\\Java Development Kit",
        "Software\\JavaSoft\\JDK",
        "Software\\JavaSoft\\JRE",
        "Software\\Eclipse Foundation\\JDK",
        "Software\\Eclipse Adoptium\\JDK",
        "Software\\Eclipse Adoptium\\JRE",
        "Software\\Microsoft\\JDK",
        "Software\\Azul Systems\\Zulu",
        "Software\\Amazon\\Corretto",
    ];

    for key in keys {
        for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
            let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey_with_flags(key, KEY_READ | view)
            else {
                continue;
            };
            for sub in root.enum_keys().flatten() {
                let Ok(version_key) = root.open_subkey(&sub) else {
                    continue;
                };
                // Adoptium publishes the install dir as `Path`, classic Sun
                // JRE keys use `JavaHome`. Try both.
                if let Ok(home) = version_key.get_value::<String, _>("JavaHome") {
                    out.push(PathBuf::from(home).join("bin"));
                }
                if let Ok(path) = version_key.get_value::<String, _>("Path") {
                    out.push(PathBuf::from(path).join("bin"));
                }
                // Adoptium nests `<key>\hotspot\MSI` with `Path` underneath.
                if let Ok(hotspot) = version_key.open_subkey("hotspot\\MSI") {
                    if let Ok(path) = hotspot.get_value::<String, _>("Path") {
                        out.push(PathBuf::from(path).join("bin"));
                    }
                }
            }
        }
    }
    out
}

// ─── Resolution for the launcher itself ─────────────────────────────────────

/// Resolve the Java executable to use for the given major version, honoring a
/// user-set override from `LauncherSettings::java_paths` if present.
///
/// Returns `Ok(None)` when nothing is configured/installed for that major;
/// callers should fall back to the existing Adoptium auto-download flow.
pub fn resolve_user_path(settings_paths: &std::collections::HashMap<u8, String>, major: u8) -> Option<PathBuf> {
    let raw = settings_paths.get(&major)?;
    let candidate = PathBuf::from(raw);
    if candidate.exists() {
        Some(candidate)
    } else {
        // The path was set previously but the file is gone — silently ignore.
        tracing::warn!(
            "Configured Java {} path no longer exists, falling back: {:?}",
            major,
            candidate
        );
        None
    }
}

fn emit_java_progress(
    app: Option<&tauri::AppHandle>,
    major: u8,
    message: &str,
    fraction: f64,
) {
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "java".to_string(),
                title: format!("Java {}", major),
                message: message.to_string(),
                fraction: fraction.clamp(0.0, 1.0),
                skipped: false,
            },
        );
    }
}

fn emit_java_done(app: Option<&tauri::AppHandle>, major: u8) {
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "done".to_string(),
                title: format!("Java {}", major),
                message: "Installed".to_string(),
                fraction: 1.0,
                skipped: false,
            },
        );
    }
}

/// Trigger an explicit download & installation of the configured Java distribution
/// for a specific major version (used when the user clicks Install/Reinstall/Switch in Settings).
/// Streams download chunks with progress events and returns the validated JavaInstall metadata.
pub async fn install_recommended(
    app: Option<&tauri::AppHandle>,
    major: u8,
) -> Result<JavaInstall, String> {
    let _scope = crate::services::download::InstallScope::begin();
    let distro = match crate::services::settings_service::load().await {
        Ok(s) => JavaDistribution::from_str_loose(&s.java_runtime),
        Err(_) => JavaDistribution::Adoptium,
    };
    let exe = force_install_distro(app, major, distro).await?;
    emit_java_progress(
        app,
        major,
        &format!("Validating Java {} runtime...", major),
        0.95,
    );
    let validated = validate_java(&exe, JavaSource::AutoInstalled)
        .await
        .ok_or_else(|| "Downloaded JRE could not be validated".to_string())?;

    emit_java_done(app, major);
    Ok(validated)
}

/// Delete a Vermeil-downloaded JRE for the given major version.
/// Checks both vendor subdirectories (e.g. `<data>/java/amazon/jdk-N`)
/// and the legacy root directory (`<data>/java/jdk-N`).
///
/// Refuses to touch anything outside `paths::java_dir()` — the directory we
/// own — so a corrupted setting or weird symlink can never wipe a user's
/// external JDK at, say, `C:\Program Files\Java\jdk-21`.
///
/// Returns the deleted directory's absolute path on success.
pub async fn delete_auto_installed(major: u8) -> Result<String, String> {
    let _lock = JAVA_INSTALL_MUTEX.lock().await;
    let mut deleted_paths = Vec::new();

    // Check vendor subdirectories first
    for vendor in MANAGED_VENDORS {
        let dir = paths::java_dir().join(vendor).join(format!("jdk-{}", major));
        if dir.exists() {
            deleted_paths.push(dir);
        }
    }
    // Check legacy root
    let legacy_dir = paths::java_dir().join(format!("jdk-{}", major));
    if legacy_dir.exists() {
        deleted_paths.push(legacy_dir);
    }

    if deleted_paths.is_empty() {
        return Err(format!("No Vermeil-installed Java {} found", major));
    }

    let java_root_canon = paths::java_dir()
        .canonicalize()
        .map_err(|e| format!("Resolve Vermeil java dir: {}", e))?;

    let mut last_deleted = String::new();
    for target in deleted_paths {
        if let Ok(target_canon) = target.canonicalize() {
            if target_canon.starts_with(&java_root_canon) {
                if let Err(e) = std::fs::remove_dir_all(&target_canon) {
                    tracing::error!("Failed to delete {}: {}", target_canon.display(), e);
                } else {
                    last_deleted = strip_extended_prefix(&target_canon.to_string_lossy());
                }
            }
        }
    }

    if last_deleted.is_empty() {
        return Err(format!("Could not remove Java {} directory (it may be in use)", major));
    }

    Ok(last_deleted)
}

/// Clean up any leftover temporary staging folders from previous interrupted runs.
fn clean_stale_staging_dirs() {
    let java_dir = paths::java_dir();
    if let Ok(entries) = std::fs::read_dir(&java_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(".staging-jdk-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// If an unpacked archive contains a single top-level folder (e.g. `jdk-25.0.4.1+1-jre` or
/// `amazon-corretto-21...`) instead of placing `bin/` at the root, flatten that single wrapper
/// directory so that `bin/java` sits directly under `dir`.
pub fn maybe_flatten_single_child(dir: &Path) {
    for _ in 0..3 {
        let Ok(entries) = std::fs::read_dir(dir) else {
            break;
        };
        let mut visible = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if !s.starts_with('.') {
                visible.push(entry.path());
            }
        }
        if visible.len() == 1 && visible[0].is_dir() {
            let inner = visible.remove(0);
            if dir.join("bin").exists() {
                break;
            }
            let Ok(inner_entries) = std::fs::read_dir(&inner) else {
                break;
            };
            let mut to_move = Vec::new();
            for item in inner_entries.flatten() {
                to_move.push((item.path(), dir.join(item.file_name())));
            }
            if to_move.is_empty() {
                break;
            }
            for (from, to) in to_move {
                if std::fs::rename(&from, &to).is_err() {
                    if from.is_dir() {
                        let _ = crate::util::paths::copy_dir_all(&from, &to);
                        let _ = std::fs::remove_dir_all(&from);
                    } else {
                        let _ = std::fs::copy(&from, &to);
                        let _ = std::fs::remove_file(&from);
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&inner);
        } else {
            break;
        }
    }
}

/// Internal helper: safely unpacks an archive into an isolated staging directory,
/// flattens wrapper folders, writes the readiness sentinel, and atomically moves it
/// to the vendor install directory (e.g. `<data>/java/amazon/jdk-25`).
async fn extract_and_publish_archive(
    major: u8,
    archive_path: &Path,
    distro: JavaDistribution,
) -> Result<PathBuf, String> {
    let java_dir = paths::java_dir();
    let vendor_dir = java_dir.join(distro.dir_name());
    let install_dir = vendor_dir.join(format!("jdk-{}", major));

    clean_stale_staging_dirs();

    std::fs::create_dir_all(&vendor_dir)
        .map_err(|e| format!("Create vendor directory {}: {}", vendor_dir.display(), e))?;

    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_dir = java_dir.join(format!(".staging-jdk-{}-{}", major, &staging_id[..8]));

    let archive_buf = archive_path.to_path_buf();
    let dest_dir = staging_dir.clone();
    let extract_res = tokio::task::spawn_blocking(move || {
        crate::util::platform::extract_java_archive(&archive_buf, &dest_dir)
    })
    .await
    .map_err(|e| format!("Java extraction task panicked: {}", e))?;

    let _ = std::fs::remove_file(archive_path);

    if let Err(e) = extract_res {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!("Extract Java {}: {}", major, e));
    }

    // Flatten any nested wrapper folder from vendor zips
    maybe_flatten_single_child(&staging_dir);

    // Mark as fully unpacked and ready inside staging before making it visible
    let _ = std::fs::write(staging_dir.join(READY_SENTINEL), "");

    // Clear target directory if an incomplete or corrupt one already exists
    if install_dir.exists() {
        let _ = std::fs::remove_dir_all(&install_dir);
    }

    // Clear old unorganized legacy root directory if it existed
    let legacy_install_dir = java_dir.join(format!("jdk-{}", major));
    if legacy_install_dir.exists() && legacy_install_dir != install_dir {
        let _ = std::fs::remove_dir_all(&legacy_install_dir);
    }

    // Atomic publish via rename (NTFS / ext4 move)
    if let Err(e) = std::fs::rename(&staging_dir, &install_dir) {
        tracing::warn!("fs::rename failed ({}), falling back to copy_dir_all", e);
        if let Err(copy_err) = crate::util::paths::copy_dir_all(&staging_dir, &install_dir) {
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(format!("Move Java {} to install dir: {}", major, copy_err));
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
    }

    find_valid_java_in(&install_dir)
        .ok_or_else(|| format!("Java {} installed but executable could not be validated", major))
}

/// Unpack and publish a downloaded Java archive into the vendor directory
/// `<data>/java/<vendor>/jdk-<major>/` safely using atomic staging and single-flight synchronization.
pub async fn install_from_archive(major: u8, archive_path: &Path) -> Result<PathBuf, String> {
    if let Some(exe) = find_managed_java(major) {
        let _ = std::fs::remove_file(archive_path);
        return Ok(exe);
    }

    let _lock = JAVA_INSTALL_MUTEX.lock().await;

    if let Some(exe) = find_managed_java(major) {
        let _ = std::fs::remove_file(archive_path);
        return Ok(exe);
    }

    let distro = match crate::services::settings_service::load().await {
        Ok(s) => JavaDistribution::from_str_loose(&s.java_runtime),
        Err(_) => JavaDistribution::Adoptium,
    };

    extract_and_publish_archive(major, archive_path, distro).await
}

/// Resolve the download URL for a given Java distribution and major version.
pub async fn resolve_download_url(distro: JavaDistribution, major: u8) -> Result<String, String> {
    match distro {
        JavaDistribution::Adoptium => {
            let os_segment = crate::util::platform::adoptium_os();
            let arch_segment = crate::util::platform::adoptium_arch();
            Ok(format!(
                "https://api.adoptium.net/v3/binary/latest/{}/ga/{}/{}/jre/hotspot/normal/eclipse",
                major, os_segment, arch_segment
            ))
        }
        JavaDistribution::Zulu => {
            let os_segment = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            };
            let arch_segment = if cfg!(target_arch = "aarch64") {
                "arm"
            } else {
                "x64"
            };
            let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
            let query_url = format!(
                "https://api.azul.com/metadata/v1/zulu/packages/?java_version={}&os={}&arch={}&archive_type={}&page=1&page_size=1",
                major, os_segment, arch_segment, ext
            );
            let resp = crate::util::http::HTTP
                .get(&query_url)
                .send()
                .await
                .map_err(|e| format!("Azul API request failed: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("Azul API returned HTTP {}", resp.status()));
            }
            #[derive(Deserialize)]
            struct ZuluPackage {
                download_url: Option<String>,
            }
            let list: Vec<ZuluPackage> = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse Azul metadata: {}", e))?;
            list.into_iter()
                .next()
                .and_then(|p| p.download_url)
                .ok_or_else(|| format!("No Azul Zulu package found for Java {}", major))
        }
        JavaDistribution::Corretto => {
            let os_segment = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            };
            let arch_segment = if cfg!(target_arch = "aarch64") {
                "aarch64"
            } else {
                "x64"
            };
            let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
            Ok(format!(
                "https://corretto.aws/downloads/latest/amazon-corretto-{}-{}-{}-jdk.{}",
                major, arch_segment, os_segment, ext
            ))
        }
    }
}

/// Fetch binary archive payload for a distribution and major version, streaming chunks
/// and emitting live progress events to the frontend.
async fn fetch_java_bytes(
    app: Option<&tauri::AppHandle>,
    distro: JavaDistribution,
    major: u8,
) -> Result<Vec<u8>, String> {
    emit_java_progress(
        app,
        major,
        &format!("Connecting to {}...", distro.display_name()),
        0.02,
    );
    let url = resolve_download_url(distro, major).await?;
    tracing::info!(
        "Downloading Java {} by {} ({}) from: {}",
        major,
        distro.vendor_name(),
        distro.display_name(),
        url
    );
    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request to {} failed: {}", distro.display_name(), e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "{} returned HTTP {} for Java {}",
            distro.display_name(),
            resp.status(),
            major
        ));
    }

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total_bytes as usize);
    let mut downloaded_bytes: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read {} payload: {}", distro.display_name(), e))?;
        crate::services::download::cancel_check()?;
        crate::services::download::RATE_LIMITER.consume(chunk.len()).await?;
        downloaded_bytes += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        let is_complete = total_bytes > 0 && downloaded_bytes >= total_bytes;
        if is_complete || last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            last_emit = std::time::Instant::now();
            let dl_mb = (downloaded_bytes as f64) / (1024.0 * 1024.0);
            let (msg, fraction) = if total_bytes > 0 {
                let tot_mb = (total_bytes as f64) / (1024.0 * 1024.0);
                let pct = (downloaded_bytes as f64) / (total_bytes as f64);
                // Download phase covers 0.05 to 0.80 of total installation progress
                let frac = 0.05 + 0.75 * pct;
                (
                    format!(
                        "Downloading {} ({:.1} MB / {:.1} MB)",
                        distro.display_name(),
                        dl_mb,
                        tot_mb
                    ),
                    frac,
                )
            } else {
                let frac = (0.05 + 0.75 * (1.0 - (-dl_mb / 120.0).exp())).min(0.79);
                (
                    format!(
                        "Downloading {} ({:.1} MB)",
                        distro.display_name(),
                        dl_mb
                    ),
                    frac,
                )
            };
            emit_java_progress(app, major, &msg, fraction);
        }
    }

    Ok(bytes)
}

/// Ensure that the required major Java version is present on disk and valid.
/// If not installed, downloads from the configured distribution (Adoptium, Azul Zulu,
/// or Amazon Corretto) and unpacks into `<data>/java/<vendor>/jdk-<major>/`.
/// Serialized by an async mutex so concurrent instance launches/preparations
/// do not race, clobber extraction, or launch half-unpacked runtimes.
pub async fn ensure_java_major(major: u8) -> Result<PathBuf, String> {
    let distro = match crate::services::settings_service::load().await {
        Ok(s) => JavaDistribution::from_str_loose(&s.java_runtime),
        Err(_) => JavaDistribution::Adoptium,
    };
    ensure_java_distro(major, distro).await
}

/// Ensure that a specific distribution for a major Java version is installed.
/// Reuses existing valid installations to avoid redundant downloads.
pub async fn ensure_java_distro(major: u8, distro: JavaDistribution) -> Result<PathBuf, String> {
    let preferred_dir = paths::java_dir().join(distro.dir_name()).join(format!("jdk-{}", major));
    if let Some(exe) = find_valid_java_in(&preferred_dir) {
        return Ok(exe);
    }

    if let Some(exe) = find_managed_java(major) {
        return Ok(exe);
    }

    force_install_distro(None, major, distro).await
}

/// Force a clean download and extraction of a Java distribution, bypassing
/// any existing installation. Used when user explicitly clicks Install/Reinstall/Switch.
pub async fn force_install_distro(
    app: Option<&tauri::AppHandle>,
    major: u8,
    distro: JavaDistribution,
) -> Result<PathBuf, String> {
    let _lock = JAVA_INSTALL_MUTEX.lock().await;

    let java_dir = paths::java_dir();
    std::fs::create_dir_all(&java_dir).map_err(|e| format!("Create java dir: {}", e))?;

    let bytes = match fetch_java_bytes(app, distro, major).await {
        Ok(b) => b,
        Err(e) if distro != JavaDistribution::Adoptium => {
            if crate::services::download::is_cancelled() {
                return Err(e);
            }
            tracing::warn!(
                "Failed to download Java {} from {}: {}. Falling back to Adoptium",
                major,
                distro.display_name(),
                e
            );
            fetch_java_bytes(app, JavaDistribution::Adoptium, major).await?
        }
        Err(e) => return Err(e),
    };

    crate::services::download::cancel_check()?;

    emit_java_progress(
        app,
        major,
        "Extracting runtime archive...",
        0.82,
    );

    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_archive = java_dir.join(format!(
        ".staging-jdk-{}-{}{}",
        major,
        &staging_id[..8],
        crate::util::platform::java_archive_ext()
    ));

    std::fs::write(&staging_archive, &bytes).map_err(|e| format!("Write Java archive: {}", e))?;

    crate::services::download::cancel_check()?;

    let res = extract_and_publish_archive(major, &staging_archive, distro).await;

    if res.is_err() {
        let _ = std::fs::remove_file(&staging_archive);
    }

    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_java_version() {
        let openjdk = "openjdk version \"21.0.6\" 2025-01-21\nOpenJDK Runtime Environment ...";
        let (major, ver) = parse_java_version(openjdk).expect("Should parse major");
        assert_eq!(major, 21);
        assert_eq!(ver, "21.0.6");

        let legacy = "java version \"1.8.0_412\"\nJava(TM) SE Runtime Environment ...";
        let (major_legacy, ver_legacy) = parse_java_version(legacy).expect("Should parse legacy 1.8");
        assert_eq!(major_legacy, 8);
        assert_eq!(ver_legacy, "1.8.0_412");
    }

    #[test]
    fn test_valid_java_detection_with_sentinel() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_java_{}", uuid::Uuid::new_v4()));
        let bin = temp.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(crate::util::platform::java_exe_name());
        std::fs::write(&exe, b"dummy").unwrap();

        // Without sentinel or core lib files, find_valid_java_in should reject it
        assert!(find_valid_java_in(&temp).is_none());

        // With sentinel, it should be recognized
        std::fs::write(temp.join(READY_SENTINEL), b"").unwrap();
        assert_eq!(find_valid_java_in(&temp), Some(exe));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_maybe_flatten_single_child_nested() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_flatten_{}", uuid::Uuid::new_v4()));
        let inner = temp.join("jdk-25.0.4.1+1-jre");
        let inner_bin = inner.join("bin");
        std::fs::create_dir_all(&inner_bin).unwrap();
        let exe = inner_bin.join(crate::util::platform::java_exe_name());
        std::fs::write(&exe, b"dummy").unwrap();

        maybe_flatten_single_child(&temp);

        // After flattening, bin should be directly inside temp
        let direct_exe = temp.join("bin").join(crate::util::platform::java_exe_name());
        assert!(direct_exe.exists(), "Executable should sit directly in temp/bin");
        assert!(!inner.exists(), "Wrapper directory should have been removed");

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_java_distribution_metadata() {
        assert_eq!(JavaDistribution::Adoptium.vendor_name(), "Eclipse Foundation");
        assert_eq!(JavaDistribution::Zulu.vendor_name(), "Azul Systems");
        assert_eq!(JavaDistribution::Corretto.vendor_name(), "Amazon");
        assert_eq!(JavaDistribution::Adoptium.dir_name(), "adoptium");
        assert_eq!(JavaDistribution::Zulu.dir_name(), "zulu");
        assert_eq!(JavaDistribution::Corretto.dir_name(), "amazon");
    }

    #[test]
    fn test_find_auto_installed_vendor_traversal() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_vendor_{}", uuid::Uuid::new_v4()));
        let amazon_17 = temp.join("amazon").join("jdk-17").join("bin");
        let amazon_21 = temp.join("amazon").join("jdk-21").join("bin");
        std::fs::create_dir_all(&amazon_17).unwrap();
        std::fs::create_dir_all(&amazon_21).unwrap();
        std::fs::write(amazon_17.join(crate::util::platform::java_exe_name()), b"dummy").unwrap();
        std::fs::write(amazon_21.join(crate::util::platform::java_exe_name()), b"dummy").unwrap();
        std::fs::write(temp.join("amazon").join("jdk-17").join(READY_SENTINEL), b"").unwrap();
        std::fs::write(temp.join("amazon").join("jdk-21").join(READY_SENTINEL), b"").unwrap();

        // Verify that find_valid_java_in is NOT called on the vendor container directory directly
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&temp) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name_str = entry.file_name().to_string_lossy().to_string();
                if name_str.starts_with("jdk-") || p.join("bin").is_dir() {
                    if let Some(exe) = find_valid_java_in(&p) {
                        found.push(exe);
                        continue;
                    }
                }
                if let Ok(sub_entries) = std::fs::read_dir(&p) {
                    for sub in sub_entries.flatten() {
                        let sub_p = sub.path();
                        if let Some(exe) = find_valid_java_in(&sub_p) {
                            found.push(exe);
                        }
                    }
                }
            }
        }

        assert_eq!(found.len(), 2, "Both vendor JDKs must be traversed and discovered");
        let _ = std::fs::remove_dir_all(&temp);
    }
}
