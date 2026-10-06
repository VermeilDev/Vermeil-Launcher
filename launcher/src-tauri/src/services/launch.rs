// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::models::instance::Instance;
use crate::services::download::{DownloadTask, download_all, download_file};
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

/// On Windows, after spawning the JVM we poll for the visible top-level
/// window owned by our PID and, once it appears, bring it to the foreground
/// so the game is actually focused and on top when it launches. When the
/// user has "start maximized" enabled we additionally call
/// `ShowWindow(hwnd, SW_MAXIMIZE)` — Minecraft's GLFW window has no
/// `--maximized` CLI flag, so we can't ask the JVM to launch maximized.
///
/// Foregrounding always runs, maximize is conditional. The JVM is spawned
/// from a background process (the launcher is usually minimized to tray on
/// launch, or the user has switched apps during the long load), so Windows'
/// focus-stealing prevention otherwise leaves the game window *behind* the
/// active window — even when nothing was maximized. `force_foreground`
/// works around that; see its own docs.
///
/// The poll runs on an OS thread (not a tokio task) because it makes only
/// blocking Win32 calls and we don't want to tie up the runtime. It gives
/// up after 120 s — that covers cold-start of even the heaviest modpacks
/// (Cobbleverse, ATM10, RAD2 routinely take 45–90 s on first launch with
/// a slow disk and 200+ mods to initialize). The earlier 30 s ceiling
/// timed out before the GLFW window appeared on those packs and silently
/// dropped the focus/maximize.
///
/// We also exit early if the JVM process dies during the wait (user closed
/// the game, crash before the window appeared, etc.) so we don't keep a
/// dead-poll thread alive for the full timeout.
#[cfg(windows)]
fn focus_minecraft_window_async(pid: u32, maximize: bool) {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, GetExitCodeProcess, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowThreadProcessId,
        IsWindowVisible, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST,
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_MAXIMIZE,
    };

    /// Walker state passed through `EnumWindows` via lParam. Holds the PID
    /// we're hunting and accumulates the first matching HWND we find.
    struct EnumData {
        target_pid: u32,
        found_hwnd: HWND,
    }

    extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: `lparam` is the pointer we passed into `EnumWindows`, valid
        // for the duration of the enumeration.
        unsafe {
            let data = &mut *(lparam as *mut EnumData);
            let mut window_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut window_pid);
            // Match by PID and require the window to be visible — Java
            // creates several invisible service windows during JVM startup
            // (e.g. AWT), and we want the actual GLFW one. Window *title*
            // is never read: modpacks frequently rename the title (e.g.
            // Cobbleverse), and our matcher must be title-agnostic.
            if window_pid == data.target_pid && IsWindowVisible(hwnd) != 0 {
                data.found_hwnd = hwnd;
                return 0; // FALSE — stop enumeration; we found our window
            }
            1 // TRUE — keep enumerating
        }
    }

    /// Probe whether the JVM is still alive. Returns false once the process
    /// has exited, so the caller can stop polling instead of grinding for
    /// the full 120 s on a game the user already closed.
    ///
    /// Uses `PROCESS_QUERY_LIMITED_INFORMATION` because that's the minimum
    /// privilege needed for `GetExitCodeProcess` and works across UAC
    /// boundaries — `PROCESS_QUERY_INFORMATION` would require matching
    /// integrity level on locked-down systems.
    fn is_pid_alive(pid: u32) -> bool {
        // STILL_ACTIVE is documented as 259 (= STATUS_PENDING). The constant
        // isn't re-exported through `windows_sys::Win32::System::Threading`
        // in every minor release, so we inline it to keep the import set
        // stable.
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            ok && code == STILL_ACTIVE
        }
    }

    /// Bring `hwnd` to the foreground and give it keyboard focus.
    ///
    /// `SetForegroundWindow` alone is rejected when called from a background
    /// process (Windows' focus-stealing prevention) — which is exactly our
    /// situation: the launcher has usually lost the foreground (minimized to
    /// tray on launch, or the user switched apps during the long load) by the
    /// time Minecraft's window appears, so a bare maximize lands the window
    /// *behind* whatever is currently active. The documented workaround is to
    /// briefly attach our input thread to the thread that currently owns the
    /// foreground so they share input state; while attached, the system honors
    /// our focus request. We always detach again immediately so we don't keep
    /// the queues joined.
    ///
    /// See SetForegroundWindow remarks:
    /// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow
    fn force_foreground(hwnd: HWND) {
        // SAFETY: all calls are plain FFI into user32/kernel32 with a valid
        // HWND we just resolved via EnumWindows. Thread IDs come straight from
        // the OS. Every successful AttachThreadInput(.., TRUE) is paired with a
        // matching detach below.
        unsafe {
            let our_thread = GetCurrentThreadId();
            let fg_window = GetForegroundWindow();
            let fg_thread = if fg_window.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg_window, std::ptr::null_mut())
            };

            // Attach the *foreground* thread to ours (idAttach=fg, idAttachTo=our)
            // — the direction every authoritative example uses. While joined
            // they share an input queue, so the system honors our focus request.
            let attached = fg_thread != 0
                && fg_thread != our_thread
                && AttachThreadInput(fg_thread, our_thread, 1) != 0;

            // Kick the window to the top of the z-order. Toggling the topmost
            // flag forces it above an already-maximized sibling — e.g. the
            // launcher window itself when the user hasn't enabled minimize-to-
            // tray, which otherwise covers the freshly-maximized game.
            // SetForegroundWindow alone won't reorder above a maximized window
            // from a background thread. SWP_NOACTIVATE keeps this a pure
            // z-order change; the actual focus comes from SetForegroundWindow.
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);

            if attached {
                AttachThreadInput(fg_thread, our_thread, 0);
            }
        }
    }

    std::thread::spawn(move || {
        // Poll up to 120 s in 500 ms increments. Heavy modpacks legitimately
        // take 45–90 s to reach their first GLFW window on a cold start;
        // 120 s adds margin without committing the thread to forever-poll
        // when something genuinely went wrong.
        const POLL_INTERVAL: Duration = Duration::from_millis(500);
        const MAX_ITERATIONS: u32 = 240; // 240 × 500 ms = 120 s

        for _ in 0..MAX_ITERATIONS {
            std::thread::sleep(POLL_INTERVAL);

            // Bail early if the JVM is gone — no point hunting for a window
            // that will never appear.
            if !is_pid_alive(pid) {
                tracing::debug!(
                    "Maximize watcher: PID {} exited before its window appeared; stopping poll",
                    pid
                );
                return;
            }

            let mut data = EnumData {
                target_pid: pid,
                found_hwnd: std::ptr::null_mut(),
            };
            // SAFETY: callback signature matches WNDENUMPROC; lparam pointer
            // outlives the enumeration call.
            unsafe {
                EnumWindows(Some(enum_proc), &mut data as *mut _ as LPARAM);
                if !data.found_hwnd.is_null() {
                    // Only resize when the user asked for a maximized window;
                    // otherwise leave GLFW's launch-size window as-is.
                    if maximize {
                        ShowWindow(data.found_hwnd, SW_MAXIMIZE);
                    }
                    // Whether or not we maximized, a window created by a
                    // background process won't pull itself in front of the
                    // user's active window. Force the foreground so the game
                    // is actually visible and focused when it appears.
                    force_foreground(data.found_hwnd);
                    return;
                }
            }
        }
        tracing::warn!(
            "Couldn't find a visible window for Minecraft PID {} after 120s; skipping focus/maximize",
            pid
        );
    });
}

/// Payload for the `game-log` Tauri event. Carries the originating instance
/// ID alongside the log line so the frontend can route output into a
/// per-instance buffer — without it, switching to a different instance and
/// viewing its Logs tab would show another session's output.
#[derive(Debug, Clone, Serialize)]
struct GameLogPayload<'a> {
    #[serde(rename = "instanceId")]
    instance_id: &'a str,
    line: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct VersionJson {
    pub id: String,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Vec<Library>,
    pub downloads: Option<VersionDownloads>,
    #[serde(rename = "assetIndex")]
    pub asset_index: Option<AssetIndexInfo>,
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VersionDownloads {
    pub client: Option<DownloadInfo>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadInfo {
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct AssetIndexInfo {
    pub id: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct Arguments {
    pub game: Option<Vec<serde_json::Value>>,
    pub jvm: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
pub struct Library {
    pub downloads: Option<LibraryDownloads>,
    pub rules: Option<Vec<Rule>>,
    pub natives: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct LibraryDownloads {
    pub artifact: Option<LibraryArtifact>,
    pub classifiers: Option<std::collections::HashMap<String, LibraryArtifact>>,
}

#[derive(Debug, Deserialize)]
pub struct LibraryArtifact {
    pub path: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
}

#[derive(Debug, Deserialize)]
pub struct OsRule {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AssetIndex {
    pub objects: std::collections::HashMap<String, AssetObject>,
    #[serde(default)]
    pub map_to_resources: bool,
    #[serde(default, rename = "virtual")]
    pub is_virtual: bool,
}

#[derive(Debug, Deserialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

/// Check if a library rule allows it on the current OS
pub fn library_allowed(lib: &Library) -> bool {
    let rules = match &lib.rules {
        Some(r) => r,
        None => return true,
    };

    let current_os = crate::util::platform::os_name();
    let mut allowed = false;
    for rule in rules {
        let os_matches = match &rule.os {
            None => true,
            Some(os) => match &os.name {
                None => true,
                Some(name) => name == current_os,
            },
        };

        if os_matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

/// Evaluate whether a set of rules allows an argument/library on the current platform.
/// Handles OS rules and feature rules.
fn rules_allow(rules: &[serde_json::Value], has_custom_resolution: bool) -> bool {
    // If no rules evaluate to anything, default is disallow
    let mut result = false;

    for rule in rules {
        let action = rule.get("action").and_then(|a| a.as_str()).unwrap_or("disallow");
        let is_allow = action == "allow";

        // Check OS rule
        let os_matches = if let Some(os) = rule.get("os") {
            let current_os = crate::util::platform::os_name();
            let name_matches = if let Some(name) = os.get("name").and_then(|n| n.as_str()) {
                name == current_os
            } else {
                true // No name specified = matches all
            };
            // Skip x86 arch rules (we're x64)
            let arch_matches = if let Some(arch) = os.get("arch").and_then(|a| a.as_str()) {
                arch != "x86" && arch != "arm"
            } else {
                true
            };
            name_matches && arch_matches
        } else {
            true // No OS rule = matches
        };

        // Check feature rules
        let features_match = if let Some(features) = rule.get("features") {
            let mut all_match = true;
            if let Some(demo) = features.get("is_demo_user").and_then(|v| v.as_bool()) {
                if demo { all_match = false; } // We never run in demo mode
            }
            if let Some(res) = features.get("has_custom_resolution").and_then(|v| v.as_bool()) {
                if res && !has_custom_resolution { all_match = false; }
            }
            if let Some(qp) = features.get("has_quick_plays_support").and_then(|v| v.as_bool()) {
                if qp { all_match = false; } // Not implemented
            }
            if let Some(qp) = features.get("is_quick_play_singleplayer").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            if let Some(qp) = features.get("is_quick_play_multiplayer").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            if let Some(qp) = features.get("is_quick_play_realms").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            all_match
        } else {
            true // No feature rule = matches
        };

        if os_matches && features_match {
            result = is_allow;
        }
    }

    result
}

/// Parse versioned arguments (from version.json `arguments.jvm` or `arguments.game`).
/// Handles both plain strings and ruled objects with OS/feature conditions.
fn parse_versioned_args(
    args: &[serde_json::Value],
    interpolate: &dyn Fn(&str) -> String,
    has_custom_resolution: bool,
) -> Vec<String> {
    let mut result = Vec::new();

    for arg in args {
        if let Some(s) = arg.as_str() {
            // Plain string argument — always included
            result.push(interpolate(s));
        } else if arg.is_object() {
            // Ruled argument — check rules first
            if let Some(rules) = arg.get("rules").and_then(|r| r.as_array()) {
                if !rules_allow(rules, has_custom_resolution) {
                    continue; // Rules don't allow this arg
                }
            }

            // Rules passed — extract value
            if let Some(value) = arg.get("value") {
                if let Some(s) = value.as_str() {
                    result.push(interpolate(s));
                } else if let Some(arr) = value.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            result.push(interpolate(s));
                        }
                    }
                }
            }
        }
    }

    result
}

/// Fetch and cache the version JSON
pub async fn get_version_json(version_id: &str) -> Result<VersionJson, String> {
    let meta_dir = paths::meta_dir().join("versions");
    let version_path = meta_dir.join(format!("{}.json", version_id));

    // Use cached if exists
    if version_path.exists() {
        let content = fs::read_to_string(&version_path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&content).map_err(|e| format!("Parse version JSON: {}", e));
    }

    // Fetch from manifest
    let manifest = crate::services::meta::get_version_manifest(false).await?;
    let version_entry = manifest.versions.iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| format!("Version {} not found in manifest", version_id))?;

    let resp = crate::util::http::HTTP.get(&version_entry.url)
        .send().await.map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Cache it
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let _ = fs::write(&version_path, &text);

    serde_json::from_str(&text).map_err(|e| format!("Parse version JSON: {}", e))
}

/// Download all required libraries for a version
pub async fn ensure_libraries(version: &VersionJson, app: Option<tauri::AppHandle>) -> Result<Vec<PathBuf>, String> {
    let libs_dir = paths::libraries_dir();
    let mut tasks = Vec::new();
    let mut classpath = Vec::new();

    for lib in &version.libraries {
        if !library_allowed(lib) {
            continue;
        }

        if let Some(downloads) = &lib.downloads {
            if let Some(artifact) = &downloads.artifact {
                let dest = libs_dir.join(&artifact.path);
                classpath.push(dest.clone());

                tasks.push(DownloadTask {
                    url: artifact.url.clone(),
                    dest,
                    expected_sha1: artifact.sha1.clone(),
                    expected_size: artifact.size,
                });
            }
        }
    }

    if !tasks.is_empty() {
        download_all(tasks, app).await?;
    }

    Ok(classpath)
}

/// Download and extract native libraries (LWJGL .dll files) for the version
pub async fn ensure_natives(version: &VersionJson, instance_id: &str) -> Result<(), String> {
    let libs_dir = paths::libraries_dir();
    let natives_dir = paths::instances_dir().join(instance_id).join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

    for lib in &version.libraries {
        if !library_allowed(lib) { continue; }

        // Check if this library has natives for the current platform
        let classifier_key = if let Some(natives_map) = &lib.natives {
            natives_map.get(crate::util::platform::natives_map_key()).cloned()
        } else {
            None
        };

        if let Some(key) = classifier_key {
            // Replace ${arch} placeholder
            let key = key.replace("${arch}", "64");

            if let Some(downloads) = &lib.downloads {
                if let Some(classifiers) = &downloads.classifiers {
                    if let Some(native_artifact) = classifiers.get(&key) {
                        let dest = libs_dir.join(&native_artifact.path);

                        // Download if not cached
                        if !dest.exists() {
                            let task = DownloadTask {
                                url: native_artifact.url.clone(),
                                dest: dest.clone(),
                                expected_sha1: native_artifact.sha1.clone(),
                                expected_size: native_artifact.size,
                            };
                            let _ = download_file(&crate::util::http::HTTP, &task).await;
                        }

                        // Extract .dll and .so files from the jar into natives dir
                        if dest.exists() {
                            if let Ok(file) = fs::File::open(&dest) {
                                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                                    for i in 0..archive.len() {
                                        if let Ok(mut entry) = archive.by_index(i) {
                                            let name = entry.name().to_string();
                                            // Only extract .dll, .so, .dylib files (skip META-INF, etc.)
                                            if name.ends_with(".dll") || name.ends_with(".so") || name.ends_with(".dylib") {
                                                let out_path = natives_dir.join(
                                                    std::path::Path::new(&name).file_name().unwrap_or_default()
                                                );
                                                if !out_path.exists() {
                                                    if let Ok(mut outfile) = fs::File::create(&out_path) {
                                                        let _ = io::copy(&mut entry, &mut outfile);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Download the client JAR
pub async fn ensure_client_jar(version: &VersionJson) -> Result<PathBuf, String> {
    let versions_dir = paths::versions_cache_dir();
    let jar_path = versions_dir.join(format!("{}.jar", version.id));

    if jar_path.exists() {
        return Ok(jar_path);
    }

    let download = version.downloads.as_ref()
        .and_then(|d| d.client.as_ref())
        .ok_or("No client download info in version JSON")?;

    let task = DownloadTask {
        url: download.url.clone(),
        dest: jar_path.clone(),
        expected_sha1: download.sha1.clone(),
        expected_size: download.size,
    };

    crate::services::download::download_file(&crate::util::http::HTTP, &task).await?;

    Ok(jar_path)
}

/// Result of `ensure_assets` so callers don't re-read the 2–3 MB index file.
pub struct AssetResult {
    pub id: String,
    /// True when the index uses `"virtual": true` or `"map_to_resources": true`
    /// (pre-1.7.2 MC). Callers copy assets to `resources/` for legacy sound loading.
    pub is_legacy: bool,
}

/// Download asset index and all assets
pub async fn ensure_assets(version: &VersionJson, app: Option<tauri::AppHandle>) -> Result<AssetResult, String> {
    let asset_info = version.asset_index.as_ref()
        .ok_or("No asset index in version JSON")?;

    let assets_dir = paths::assets_dir();
    let indexes_dir = assets_dir.join("indexes");
    let objects_dir = assets_dir.join("objects");
    fs::create_dir_all(&indexes_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&objects_dir).map_err(|e| e.to_string())?;

    // Download asset index
    let index_path = indexes_dir.join(format!("{}.json", asset_info.id));
    if !index_path.exists() {
        let task = DownloadTask {
            url: asset_info.url.clone(),
            dest: index_path.clone(),
            expected_sha1: asset_info.sha1.clone(),
            expected_size: asset_info.size,
        };
        crate::services::download::download_file(&crate::util::http::HTTP, &task).await?;
    }

    // Parse asset index and download objects
    let content = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let index: AssetIndex = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut tasks = Vec::new();
    for obj in index.objects.values() {
        let prefix = &obj.hash[..2];
        let dest = objects_dir.join(prefix).join(&obj.hash);

        if !dest.exists() {
            tasks.push(DownloadTask {
                url: format!("https://resources.download.minecraft.net/{}/{}", prefix, obj.hash),
                dest,
                expected_sha1: Some(obj.hash.clone()),
                expected_size: Some(obj.size),
            });
        }
    }

    if !tasks.is_empty() {
        download_all(tasks, app).await?;
    }

    let is_legacy = index.map_to_resources || index.is_virtual;

    // Handle legacy/virtual asset formats (old MC versions need files at specific paths)
    if is_legacy {
        // Legacy: copy assets to <assets>/virtual/legacy/<path> or game dir resources/
        let virtual_dir = if index.is_virtual {
            assets_dir.join("virtual").join(&asset_info.id)
        } else {
            assets_dir.join("virtual").join("legacy")
        };

        for (name, obj) in &index.objects {
            let prefix = &obj.hash[..2];
            let src = objects_dir.join(prefix).join(&obj.hash);
            let dest = virtual_dir.join(name);

            if !dest.exists() && src.exists() {
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(&src, &dest);
            }
        }
    }

    Ok(AssetResult { id: asset_info.id.clone(), is_legacy })
}

/// Determine which Java version is needed for a Minecraft version.
///
/// Mojang's actual matrix (sourced from the version manifests' `javaVersion`
/// field — see `https://launchermeta.mojang.com/mc/game/version_manifest_v2.json`):
///
/// | MC version       | Java required |
/// |------------------|---------------|
/// | ≤ 1.16.5         | Java 8        |
/// | 1.17, 1.17.1     | Java 16       |
/// | 1.18 – 1.20.4    | Java 17       |
/// | 1.20.5+, 1.21.x  | Java 21       |
/// | 26.x+            | Java 25       |
///
/// We map MC 1.17 → Java **17** (not 16) because Java is backward-compatible
/// per major release and Adoptium Temurin no longer ships LTS builds for 16.
/// MC 1.17 class files are version 60 (Java 16), which Java 17 happily loads.
/// This is the standard mapping modern launchers use.
pub fn required_java_version(mc_version: &str) -> u8 {
    let parts: Vec<&str> = mc_version.split('.').collect();

    // New versioning format: 26.1.2, 26.2, etc. (no leading "1.")
    // If first part is >= 26, it's the new format and requires Java 25
    if let Ok(major) = parts[0].parse::<u32>() {
        if major >= 26 {
            return 25; // MC 26.x+ requires Java 25
        }
    }

    // Old versioning format: 1.X.Y
    if parts.len() < 2 { return 21; }
    if parts[0] != "1" { return 25; } // Unknown format, assume latest

    let minor: u32 = parts[1].parse().unwrap_or(21);

    if minor >= 21 { 21 }      // 1.21+ needs Java 21
    else if minor >= 20 {
        // 1.20.5+ needs Java 21, earlier 1.20.x needs Java 17
        if parts.len() >= 3 {
            let patch: u32 = parts[2].parse().unwrap_or(0);
            if patch >= 5 { 21 } else { 17 }
        } else { 17 }
    }
    else if minor >= 17 { 17 } // 1.17–1.19 needs Java 17 (1.17's bytecode is
                               //   class-version 60 / Java 16, but Java 17 LTS
                               //   loads it fine and is what Adoptium ships)
    else { 8 }                 // 1.16 and below needs Java 8
}

/// Resolve GC flags for the given preset, Java major version, and memory allocation.
/// Resolve GC flags for the launch JVM arguments.
///
/// Sources & Tuning:
/// - G1GC (Client-Tuned): Optimized for interactive 60-144+ FPS client gameplay.
///   Caps Stop-The-World pauses to 45ms, restores normal survivor space so transient
///   modding objects die cheaply in Young Gen, uses standard 45% IHOP to prevent
///   continuous background GC thrashing, and omits AlwaysPreTouch for fast startup.
/// - ZGC (Generational): Ultra-low latency (<1ms pauses) for Java 21+.
/// - Shenandoah (Adaptive): Adaptive heuristics for Java 12+ (prevents CPU thread starvation).
///
/// Falls back to Client-Tuned G1GC if the requested GC is incompatible with the Java version.
pub fn resolve_gc_flags(preset: &str, java_major: u8, memory_mb: u32) -> Vec<String> {
    match preset {
        "zgc" if java_major >= 21 => {
            let mut flags = vec![
                "-XX:+UseZGC".to_string(),
                "-XX:+UseStringDeduplication".to_string(),
            ];
            // ZGenerational is on by default since Java 23; needed for 21-22.
            if java_major < 23 {
                flags.push("-XX:+ZGenerational".to_string());
            }
            // CompactObjectHeaders available since Java 25.
            if java_major >= 25 {
                flags.push("-XX:+UseCompactObjectHeaders".to_string());
            }
            flags
        }
        "shenandoah" if java_major >= 12 => {
            vec![
                "-XX:+UseShenandoahGC".to_string(),
                "-XX:ShenandoahGCHeuristics=adaptive".to_string(),
                "-XX:+DisableExplicitGC".to_string(),
                "-XX:+UseStringDeduplication".to_string(),
            ]
        }
        // Default: Client-tuned G1GC. Works reliably across Java 8, 17, 21, and 25+.
        _ => {
            let mut flags = vec![
                "-XX:+UseG1GC".to_string(),
                "-XX:MaxGCPauseMillis=45".to_string(),
                "-XX:+UnlockExperimentalVMOptions".to_string(),
                "-XX:+DisableExplicitGC".to_string(),
                "-XX:+UseStringDeduplication".to_string(),
                "-XX:G1NewSizePercent=20".to_string(),
                "-XX:G1MaxNewSizePercent=40".to_string(),
                "-XX:G1ReservePercent=15".to_string(),
                "-XX:G1HeapWastePercent=5".to_string(),
                "-XX:G1MixedGCCountTarget=4".to_string(),
                "-XX:InitiatingHeapOccupancyPercent=45".to_string(),
                "-XX:SurvivorRatio=8".to_string(),
            ];
            // ParallelRefProcEnabled improves reference processing on Java 8; default in Java 9+.
            if java_major <= 8 {
                flags.push("-XX:+ParallelRefProcEnabled".to_string());
            }
            // Tailor region sizes: heaps > 12 GB get 16 MB regions to reduce card-table overhead.
            if memory_mb > 12288 {
                flags.push("-XX:G1HeapRegionSize=16M".to_string());
            } else {
                flags.push("-XX:G1HeapRegionSize=8M".to_string());
            }
            flags
        }
    }
}

/// Download Java from Adoptium if not already present
async fn ensure_java(mc_version: &str) -> Result<PathBuf, String> {
    ensure_java_public(mc_version).await
}

/// Public version of ensure_java for use from other services (e.g. neoforge installer)
pub async fn ensure_java_public(mc_version: &str) -> Result<PathBuf, String> {
    let java_version = required_java_version(mc_version);

    // Honor user-set Java path from Settings → Resources → Java if one is
    // configured for this major. This is the main entry point for "I want to
    // use my own JDK". Falls through to the auto-install flow below if the
    // configured path is gone or no override exists.
    if let Ok(settings) = crate::services::settings_service::load().await {
        if let Some(p) = crate::services::java::resolve_user_path(&settings.java_paths, java_version) {
            return Ok(p);
        }
    }

    crate::services::java::ensure_java_major(java_version).await
}

/// Returns `true` if the Minecraft release `version` (e.g. "1.8.9", "1.21.1",
/// "26.2") is at least `target_major.target_minor`. Used by the options.txt
/// patcher to gate keys that don't exist on older versions, so the launcher
/// doesn't pretend an override applies where Minecraft will silently drop the
/// line on save.
///
/// Unparseable versions (snapshots like "23w12a", weird strings) fall through
/// to `true` — modern is the safe default because the worst case is a wasted
/// write that the game ignores anyway.
fn mc_version_at_least(version: &str, target_major: u32, target_minor: u32) -> bool {
    let leading_u32 = |s: &str| -> Option<u32> {
        s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
    };
    let mut parts = version.split('.');
    let major = parts.next().and_then(leading_u32);
    let minor = parts.next().and_then(leading_u32).unwrap_or(0);
    match major {
        Some(m) => (m, minor) >= (target_major, target_minor),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{mc_version_at_least, resolve_gc_flags};

    #[test]
    fn version_gate_recognises_pre_and_post_cutoffs() {
        // The actual case that motivated this helper: 1.8.9 must not get
        // fovEffectScale writes (key didn't exist then).
        assert!(!mc_version_at_least("1.8.9", 1, 16));
        assert!(!mc_version_at_least("1.14.4", 1, 16));
        assert!(!mc_version_at_least("1.15.2", 1, 16));
        // 1.16+ does get them.
        assert!(mc_version_at_least("1.16", 1, 16));
        assert!(mc_version_at_least("1.16.5", 1, 16));
        assert!(mc_version_at_least("1.21.1", 1, 16));
        // New Mojang version scheme ("26.x") is modern by definition.
        assert!(mc_version_at_least("26.2", 1, 16));
        // Pre-release suffix on the minor part still parses out the digit.
        assert!(mc_version_at_least("1.16-pre1", 1, 16));
        // Unparseable strings (snapshots, malformed) default to modern.
        assert!(mc_version_at_least("23w12a", 1, 16));
    }

    #[test]
    fn test_client_g1gc_java8_and_java17() {
        // Java 8 G1GC gets ParallelRefProcEnabled and client tuning
        let j8_flags = resolve_gc_flags("g1gc", 8, 4096);
        assert!(j8_flags.contains(&"-XX:+UseG1GC".to_string()));
        assert!(j8_flags.contains(&"-XX:MaxGCPauseMillis=45".to_string()));
        assert!(j8_flags.contains(&"-XX:SurvivorRatio=8".to_string()));
        assert!(j8_flags.contains(&"-XX:InitiatingHeapOccupancyPercent=45".to_string()));
        assert!(j8_flags.contains(&"-XX:+ParallelRefProcEnabled".to_string()));
        assert!(!j8_flags.contains(&"-XX:+AlwaysPreTouch".to_string()));
        assert!(!j8_flags.contains(&"-XX:MaxTenuringThreshold=1".to_string()));

        // Java 17 G1GC omits ParallelRefProcEnabled (default in Java 9+)
        let j17_flags = resolve_gc_flags("g1gc", 17, 6144);
        assert!(j17_flags.contains(&"-XX:+UseG1GC".to_string()));
        assert!(j17_flags.contains(&"-XX:MaxGCPauseMillis=45".to_string()));
        assert!(!j17_flags.contains(&"-XX:+ParallelRefProcEnabled".to_string()));
        assert!(j17_flags.contains(&"-XX:G1HeapRegionSize=8M".to_string()));
    }

    #[test]
    fn test_client_g1gc_region_sizing() {
        // Heaps <= 12GB get 8M regions
        let normal = resolve_gc_flags("g1gc", 17, 8192);
        assert!(normal.contains(&"-XX:G1HeapRegionSize=8M".to_string()));

        // Massive heaps > 12GB get 16M regions to keep card tables compact
        let large = resolve_gc_flags("g1gc", 17, 16384);
        assert!(large.contains(&"-XX:G1HeapRegionSize=16M".to_string()));
    }

    #[test]
    fn test_generational_zgc_version_gating() {
        // Java 21 gets ZGenerational
        let j21 = resolve_gc_flags("zgc", 21, 8192);
        assert!(j21.contains(&"-XX:+UseZGC".to_string()));
        assert!(j21.contains(&"-XX:+ZGenerational".to_string()));
        assert!(!j21.contains(&"-XX:+UseCompactObjectHeaders".to_string()));

        // Java 23 omits ZGenerational (default in 23+)
        let j23 = resolve_gc_flags("zgc", 23, 8192);
        assert!(j23.contains(&"-XX:+UseZGC".to_string()));
        assert!(!j23.contains(&"-XX:+ZGenerational".to_string()));

        // Java 25 gets CompactObjectHeaders
        let j25 = resolve_gc_flags("zgc", 25, 8192);
        assert!(j25.contains(&"-XX:+UseZGC".to_string()));
        assert!(j25.contains(&"-XX:+UseCompactObjectHeaders".to_string()));

        // Java 17 cleanly falls back to Client G1GC instead of crashing JVM or using server flags
        let fallback = resolve_gc_flags("zgc", 17, 6144);
        assert!(fallback.contains(&"-XX:+UseG1GC".to_string()));
        assert!(fallback.contains(&"-XX:MaxGCPauseMillis=45".to_string()));
    }

    #[test]
    fn test_adaptive_shenandoah() {
        // Java 17 gets adaptive heuristics (not compact which starved CPU)
        let shen = resolve_gc_flags("shenandoah", 17, 6144);
        assert!(shen.contains(&"-XX:+UseShenandoahGC".to_string()));
        assert!(shen.contains(&"-XX:ShenandoahGCHeuristics=adaptive".to_string()));
        assert!(!shen.contains(&"-XX:ShenandoahGCHeuristics=compact".to_string()));

        // Java 8 cleanly falls back to Client G1GC
        let fallback = resolve_gc_flags("shenandoah", 8, 4096);
        assert!(fallback.contains(&"-XX:+UseG1GC".to_string()));
    }
}

async fn sync_options_from_game_session(
    instance_id: &str,
    instance_version: &str,
    window: Option<&tauri::WebviewWindow>,
) -> Option<crate::models::settings::GlobalVideoSettings> {
    use tauri::Emitter;
    let options_path = paths::instances_dir()
        .join(instance_id)
        .join(".minecraft")
        .join("options.txt");

    let content = std::fs::read_to_string(&options_path).ok()?;
    let mut settings = crate::services::settings_service::load().await.ok()?;
    let from_game = crate::services::video_options::read_back(&content);
    crate::services::video_options::merge_into(&mut settings.video_settings, from_game);

    if let Some(vs) = crate::services::companion_settings::read_back() {
        settings.ingame_cape.enabled = vs.cape.enabled;
        if let Some(ftm) = vs.cape.frame_time_ms {
            settings.ingame_cape.frame_time_ms = Some(ftm);
        }
        if !mc_version_at_least(instance_version, 1, 16) {
            settings.video_settings.fov_effects = Some(vs.fov_effects_scale);
        }
    }

    if let Err(e) = crate::services::settings_service::save(&settings).await {
        tracing::error!("Failed to save video settings synced from options.txt: {}", e);
        return None;
    }

    if let Some(win) = window {
        let _ = win.emit("video-settings-synced", &settings.video_settings);
    }

    Some(settings.video_settings)
}

/// Launch Minecraft for an instance
pub async fn launch(
    instance: &Instance,
    username: &str,
    uuid: &str,
    access_token: &str,
    quick_play_world: Option<&str>,
    quick_play_server: Option<&str>,
    window: Option<tauri::WebviewWindow>,
) -> Result<u32, String> {
    // Create log file early so the frontend poller can show progress
    let game_dir = paths::instances_dir().join(&instance.id).join(".minecraft");
    fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let log_dir = game_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("latest.log");

    // Clear previous log
    let _ = fs::write(&log_path, "");

    if crate::commands::launch::is_launch_cancelled() {
        return Err("Launch cancelled by user".to_string());
    }

    // 1. Get version JSON
    let version = get_version_json(&instance.game_version).await?;

    // 2. Ensure all vanilla files are downloaded (fallback if prepare wasn't run)
    let app_handle = window.as_ref().map(|w| w.app_handle().clone());
    let mut classpath_entries = ensure_libraries(&version, app_handle.clone()).await?;
    let client_jar = ensure_client_jar(&version).await?;
    let asset_result = ensure_assets(&version, app_handle).await?;
    let assets_id = &asset_result.id;
    ensure_natives(&version, &instance.id).await?;

    // For legacy/virtual assets, copy to instance's resources/ directory
    // (old MC versions look for sounds in <gameDir>/resources/)
    if asset_result.is_legacy {
        let virtual_dir = paths::assets_dir().join("virtual").join(assets_id);
        if virtual_dir.exists() {
            let resources_dir = game_dir.join("resources");
            fn copy_recursive(src: &std::path::Path, dest: &std::path::Path) {
                if let Ok(entries) = fs::read_dir(src) {
                    let _ = fs::create_dir_all(dest);
                    for entry in entries.flatten() {
                        let from = entry.path();
                        let to = dest.join(entry.file_name());
                        if from.is_dir() {
                            copy_recursive(&from, &to);
                        } else if !to.exists() {
                            let _ = fs::copy(&from, &to);
                        }
                    }
                }
            }
            copy_recursive(&virtual_dir, &resources_dir);
        }
    }

    classpath_entries.push(client_jar);

    // 3. Find or download Java (do this BEFORE loader setup so NeoForge/Forge installer can reuse it)
    if crate::commands::launch::is_launch_cancelled() {
        return Err("Launch cancelled by user".to_string());
    }
    let java = ensure_java(&instance.game_version).await?;

    // 4. Handle mod loader
    let mut extra_jvm_args: Vec<String> = Vec::new();
    let mut extra_game_args: Vec<String> = Vec::new();

    let main_class = match &instance.loader.loader_type {
        crate::models::instance::LoaderType::Fabric => {
            if let Some(ref loader_version) = instance.loader.version {
                let result = crate::services::fabric::ensure_fabric_libraries(
                    &instance.game_version, loader_version,
                ).await;
                let (fabric_main, fabric_libs) = match result {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(e);
                    }
                };
                crate::services::fabric::ensure_fabric_natives(
                    &instance.game_version, loader_version, &instance.id,
                ).await?;

                // Deduplicate: if the loader provides a library with the same group:artifact
                // as a vanilla one, remove the vanilla version to avoid classpath conflicts.
                // This handles Legacy Fabric's LWJGL override (2.9.4+legacyfabric replaces 2.9.1).
                let loader_ga_keys: Vec<String> = crate::services::fabric::get_profile_library_keys(
                    &instance.game_version, loader_version,
                ).await.unwrap_or_default();

                if !loader_ga_keys.is_empty() {
                    classpath_entries.retain(|p| {
                        let s = p.to_string_lossy().replace('\\', "/");
                        // Check if any loader library has the same group/artifact path prefix
                        for key in &loader_ga_keys {
                            if s.contains(key.as_str()) {
                                return false; // Remove vanilla version, loader version takes precedence
                            }
                        }
                        true
                    });
                }

                let mut new_cp = fabric_libs;
                new_cp.extend(classpath_entries);
                classpath_entries = new_cp;
                fabric_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Quilt => {
            if let Some(ref loader_version) = instance.loader.version {
                let (quilt_main, quilt_libs) = crate::services::quilt::ensure_quilt_libraries(
                    &instance.game_version, loader_version,
                ).await?;
                let mut new_cp = quilt_libs;
                new_cp.extend(classpath_entries);
                classpath_entries = new_cp;
                quilt_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Neoforge => {
            if let Some(ref loader_version) = instance.loader.version {
                let (neo_main, neo_libs, neo_jvm, neo_game) = crate::services::neoforge::ensure_neoforge_libraries(
                    &instance.game_version, loader_version, None, &instance.name,
                ).await?;
                let mut new_cp = neo_libs;
                new_cp.extend(classpath_entries);
                // Deduplicate — NeoForge and vanilla share libraries, duplicates cause BootstrapLauncher crash
                let mut seen = std::collections::HashSet::new();
                new_cp.retain(|p| seen.insert(p.clone()));
                classpath_entries = new_cp;
                extra_jvm_args = neo_jvm;
                extra_game_args = neo_game;
                neo_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Forge => {
            if let Some(ref loader_version) = instance.loader.version {
                let (forge_main, forge_libs, forge_jvm, forge_game) = crate::services::neoforge::ensure_forge_libraries(
                    &instance.game_version, loader_version, None, &instance.name,
                ).await?;
                let mut new_cp = forge_libs;
                new_cp.extend(classpath_entries);
                // Deduplicate — same reason as NeoForge
                let mut seen = std::collections::HashSet::new();
                new_cp.retain(|p| seen.insert(p.clone()));
                classpath_entries = new_cp;
                extra_jvm_args = forge_jvm;
                extra_game_args = forge_game;
                forge_main
            } else { version.main_class.clone() }
        }
        _ => version.main_class.clone(),
    };

    tracing::info!("Launching {} with main class: {}", instance.name, main_class);

    // 5. Build classpath string
    let natives_dir = paths::instances_dir().join(&instance.id).join("natives");

    // Legacy LWJGL 2 (MC ≤ 1.12.2) crashes on Linux/Wayland in
    // LinuxDisplay.getAvailableDisplayModes (MC-97823). On Linux, swap the stock
    // LWJGL 2 for Legacy Fabric's patched build before the classpath is frozen.
    // No-op off Linux, on LWJGL 3, or when the patched build is already present.
    crate::services::lwjgl_compat::apply(&mut classpath_entries, &natives_dir).await?;

    let cp_sep = crate::util::platform::classpath_separator();
    let classpath = classpath_entries.iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(cp_sep);

    // 6. Build JVM arguments — parse from version.json if available
    let mut jvm_args: Vec<String> = Vec::new();

    // Load global launcher settings for GC preset + window dimensions.
    // Done once here rather than at each use site to avoid redundant I/O.
    let global_settings = crate::services::settings_service::load().await.ok();

    // Memory: `resolve` returns the adaptive formula value (clamped to the
    // user's global max) unless this instance opted out via `adaptive_override`,
    // in which case it's the manual `memory_max_mb`. -Xms tracks the stored min.
    let effective = global_settings.as_ref().map(|s| {
        crate::services::memory::resolve(
            instance,
            s,
            crate::services::memory::system_memory_mb(),
        )
    });
    let max_mb = effective
        .as_ref()
        .map(|e| e.value_mb)
        .unwrap_or(instance.java.memory_max_mb);
    if let Some(ref e) = effective {
        if e.adaptive_active {
            tracing::info!(
                "Adaptive RAM: -Xmx={}m (target {}m, clamp [{}m..{}m]{})",
                e.value_mb,
                e.target_mb,
                e.min_mb,
                e.max_mb,
                if e.capped { ", capped" } else { "" }
            );
        }
    }
    // Calibrate initial heap (-Xms) with maximum heap (-Xmx):
    // For client workloads, pre-allocating the working heap avoids repeated Stop-The-World
    // page faults and heap resizing pauses while loading 200-400 mods. Since AlwaysPreTouch
    // is omitted, virtual memory pages are committed on-demand by the OS without launch delay.
    let initial_mb = if instance.java.adaptive_override && instance.java.memory_min_mb > 512 {
        instance.java.memory_min_mb.min(max_mb)
    } else {
        max_mb
    };
    jvm_args.push(format!("-Xmx{}m", max_mb));
    jvm_args.push(format!("-Xms{}m", initial_mb));

    // GC preset flags — selected by the user in Settings → General → GC preset.
    // The flags are version-aware: ZGC requires Java 21+, Shenandoah requires 12+.
    // If the selected GC is incompatible with the resolved Java version, fall
    // back to Client-Tuned G1GC flags silently (better than crashing the JVM).
    //
    // OVERRIDE: if the instance has custom `extra_args`, those replace the
    // preset entirely (the user edited the args editor, so we trust their
    // version). If extra_args is empty, we apply the preset. Memory args
    // (-Xmx/-Xms) are always applied from the slider regardless.
    {
        let has_custom = !instance.java.extra_args.is_empty()
            && instance.java.extra_args.iter().any(|a| !a.trim().is_empty());
        if has_custom {
            // User's custom flags replace the preset
            for arg in &instance.java.extra_args {
                if !arg.is_empty() {
                    jvm_args.push(arg.clone());
                }
            }
        } else {
            // No custom args — use the GC preset
            let java_major = required_java_version(&instance.game_version);
            let gc_preset = global_settings
                .as_ref()
                .map(|s| s.gc_preset.as_str())
                .unwrap_or("g1gc");
            // Use the effective heap (adaptive or manual) — G1's region-size
            // tuning depends on the actual `-Xmx`, so feeding it the slider
            // value when adaptive bumped the heap up would mis-tune the GC.
            let gc_flags = resolve_gc_flags(gc_preset, java_major, max_mb);
            jvm_args.extend(gc_flags);
        }
    }

    // Parse JVM args from version.json (contains -Djava.library.path, -cp, native dirs, etc.)
    if let Some(ref arguments) = version.arguments {
        if let Some(ref jvm) = arguments.jvm {
            let natives_str = natives_dir.to_string_lossy().to_string();
            let libs_str = paths::libraries_dir().to_string_lossy().to_string();
            let cp = classpath.clone();
            let ver_id = version.id.clone();

            let parsed = parse_versioned_args(jvm, &|token: &str| {
                token
                    .replace("${natives_directory}", &natives_str)
                    .replace("${launcher_name}", crate::util::http::LAUNCHER_NAME)
                    .replace("${launcher_version}", crate::util::http::LAUNCHER_VERSION)
                    .replace("${classpath}", &cp)
                    .replace("${classpath_separator}", crate::util::platform::classpath_separator())
                    .replace("${library_directory}", &libs_str)
                    .replace("${version_name}", &ver_id)
            }, false);
            jvm_args.extend(parsed);
        } else {
            // No JVM args in version.json — use legacy fallback
            jvm_args.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
            jvm_args.push("-cp".to_string());
            jvm_args.push(classpath.clone());
        }
    } else {
        // Legacy version (pre-1.13) — no arguments block at all
        jvm_args.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
        jvm_args.push("-cp".to_string());
        jvm_args.push(classpath.clone());
    }

    // Add loader-specific JVM args (NeoForge/Forge module flags, --add-opens, etc.)
    for arg in &extra_jvm_args {
        let val = arg
            .replace("${library_directory}", &paths::libraries_dir().to_string_lossy())
            .replace("${classpath_separator}", crate::util::platform::classpath_separator())
            .replace("${version_name}", &instance.game_version);
        jvm_args.push(val);
    }

    // Companion mod: point it at the one shared data dir via `-Dvermeil.dataDir`
    // for supported instances with the companion enabled. The mod reads its cape
    // and `vermeil-settings.json` from there — see services::instance_cape.
    if let Some(data_arg) = crate::services::instance_cape::jvm_property(instance) {
        jvm_args.push(data_arg);
    }

    // 7. Build game arguments — parse from version.json with rules
    let game_dir = paths::instances_dir().join(&instance.id).join(".minecraft");
    // Always true — every instance has an explicit resolution configured (default 1280x720).
    // This enables the version.json feature-gated --width/--height arguments for modern versions.
    let has_custom_resolution = true;

    let assets_root = if asset_result.is_legacy {
        let virtual_dir = paths::assets_dir().join("virtual").join(assets_id);
        if virtual_dir.exists() { virtual_dir } else { paths::assets_dir() }
    } else {
        paths::assets_dir()
    };

    // Resolve window dimensions from global settings, falling back to
    // per-instance values (for backwards compat) and then hard defaults.
    let global_vs = global_settings.as_ref().map(|s| &s.video_settings);
    let win_maximized = global_vs.and_then(|v| v.start_maximized).unwrap_or(false);
    // Initial window dimensions used by Minecraft's GLFW window. When
    // `start_maximized` is off, these are the explicit resolution. When it's
    // on, the block just below overrides them to monitor size (resolution is
    // ignored) so the first paint is already full-screen — see there for the
    // per-platform maximize handling.
    let win_width = global_vs.and_then(|v| v.window_width).unwrap_or(instance.window.width);
    let win_height = global_vs.and_then(|v| v.window_height).unwrap_or(instance.window.height);
    let (win_width, win_height) = if win_maximized {
        let monitor_size = window
            .as_ref()
            .and_then(|w| w.current_monitor().ok().flatten())
            .map(|m| {
                let s = m.size();
                (s.width, s.height)
            })
            .unwrap_or((1920, 1080));
        if cfg!(windows) {
            // Windows maximizes the real window via ShowWindow(SW_MAXIMIZE) once
            // it appears (see focus_minecraft_window_async), so launch at the
            // *configured* resolution — that becomes the window's restore
            // rectangle. Launching at monitor size instead made Windows record
            // the full monitor as the restore size, so the OS maximize/restore
            // button toggled to a taskbar-covering, fullscreen-looking window
            // the user couldn't escape (and the monitor-size first paint briefly
            // flashed fullscreen). ShowWindow handles the actual maximizing.
            let (mw, mh) = monitor_size;
            // Guarantee the restore size is a genuine sub-monitor window so the
            // maximize/restore toggle always lands on a usable windowed state,
            // even if the configured resolution happens to match the monitor.
            if win_width >= mw || win_height >= mh {
                (mw.saturating_sub(160).max(640), mh.saturating_sub(160).max(480))
            } else {
                (win_width, win_height)
            }
        } else {
            // Linux/macOS can't programmatically maximize the GLFW window, so
            // launch at near-monitor size as the effective "maximized" window
            // (minus a strip so the panel/taskbar stays visible).
            (monitor_size.0, monitor_size.1.saturating_sub(60).max(480))
        }
    } else {
        (win_width, win_height)
    };

    // Extract XUID from token claims if available
    let (claim_xuid, _) = crate::services::auth::extract_token_claims(access_token)
        .unwrap_or((None, None));
    let xuid_str = claim_xuid.unwrap_or_default();

    let mut game_args: Vec<String> = if let Some(ref arguments) = version.arguments {
        if let Some(ref game) = arguments.game {
            let game_dir_str = game_dir.to_string_lossy().to_string();
            let assets_root_str = assets_root.to_string_lossy().to_string();
            let assets_id_clone = assets_id.clone();
            let ver_id = version.id.clone();
            let uname = username.to_string();
            let uid = uuid.to_string();
            let token = access_token.to_string();
            let w = win_width.to_string();
            let h = win_height.to_string();
            let game_assets_str = paths::assets_dir().join("virtual").join(assets_id).to_string_lossy().to_string();

            parse_versioned_args(game, &|t: &str| {
                t.replace("${auth_player_name}", &uname)
                    .replace("${version_name}", &ver_id)
                    .replace("${game_directory}", &game_dir_str)
                    .replace("${assets_root}", &assets_root_str)
                    .replace("${game_assets}", &game_assets_str)
                    .replace("${assets_index_name}", &assets_id_clone)
                    .replace("${auth_uuid}", &uid)
                    .replace("${auth_access_token}", &token)
                    .replace("${auth_session}", &token)
                    .replace("${user_type}", if token == "0" { "legacy" } else { "msa" })
                    .replace("${version_type}", "release")
                    .replace("${clientid}", crate::services::auth::MICROSOFT_CLIENT_ID)
                    .replace("${auth_xuid}", &xuid_str)
                    .replace("${user_properties}", "{}")
                    .replace("${resolution_width}", &w)
                    .replace("${resolution_height}", &h)
            }, has_custom_resolution)
        } else {
            Vec::new()
        }
    } else if let Some(ref legacy_args) = version.minecraft_arguments {
        // Legacy format (pre-1.13): split by space, interpolate each
        let game_dir_str = game_dir.to_string_lossy().to_string();
        let assets_root_str = assets_root.to_string_lossy().to_string();
        let game_assets_str = paths::assets_dir().join("virtual").join(assets_id).to_string_lossy().to_string();

        legacy_args.split_whitespace().map(|arg| {
            arg.replace("${auth_player_name}", username)
                .replace("${version_name}", &version.id)
                .replace("${game_directory}", &game_dir_str)
                .replace("${assets_root}", &assets_root_str)
                .replace("${game_assets}", &game_assets_str)
                .replace("${assets_index_name}", assets_id)
                .replace("${auth_uuid}", uuid)
                .replace("${auth_access_token}", access_token)
                .replace("${auth_session}", access_token)
                .replace("${user_type}", if access_token == "0" { "legacy" } else { "msa" })
                .replace("${version_type}", "release")
                .replace("${clientid}", crate::services::auth::MICROSOFT_CLIENT_ID)
                .replace("${auth_xuid}", &xuid_str)
                .replace("${user_properties}", "{}")
        }).collect()
    } else {
        Vec::new()
    };

    // Add loader-specific game args (NeoForge --launchTarget, Forge --fml.forgeVersion, etc.)
    for arg in &extra_game_args {
        game_args.push(arg.clone());
    }

    // Append explicit resolution args for legacy versions (pre-1.13) that don't
    // use the feature-rule system. Modern versions (1.13+) get --width/--height
    // from the version.json feature rules when has_custom_resolution is true,
    // but legacy versions need them injected manually.
    if version.minecraft_arguments.is_some() && has_custom_resolution {
        game_args.push("--width".to_string());
        game_args.push(win_width.to_string());
        game_args.push("--height".to_string());
        game_args.push(win_height.to_string());
    }

    // Quick Play Singleplayer (Minecraft 1.20+)
    // Directly boots the game client into the requested world folder inside saves/.
    if let Some(world_folder) = quick_play_world {
        let trimmed = world_folder.trim();
        // Strict path safety check: reject path traversal and control characters
        let is_safe_name = !trimmed.is_empty()
            && !trimmed.contains('/')
            && !trimmed.contains('\\')
            && !trimmed.contains("..")
            && !trimmed.contains('\0');

        if is_safe_name {
            let saves_dir = game_dir.join("saves");
            let world_path = saves_dir.join(trimmed);
            if world_path.is_dir() {
                if mc_version_at_least(&instance.game_version, 1, 20) {
                    tracing::info!(
                        "Enabling Quick Play for world '{}' in instance '{}' (MC {})",
                        trimmed,
                        instance.name,
                        instance.game_version
                    );
                    game_args.push("--quickPlaySingleplayer".to_string());
                    game_args.push(trimmed.to_string());
                } else {
                    tracing::info!(
                        "Quick Play requested for '{}' but MC {} does not support --quickPlaySingleplayer; launching to title screen",
                        trimmed,
                        instance.game_version
                    );
                }
            } else {
                tracing::warn!(
                    "Requested Quick Play world '{}' does not exist in {:?}; skipping quick play",
                    trimmed,
                    saves_dir
                );
            }
        } else {
            tracing::warn!(
                "Rejected suspicious Quick Play world name: '{}'",
                world_folder
            );
        }
    }

    // Quick Play Multiplayer (Minecraft 1.20+)
    // Directly boots the game client into the requested multiplayer server.
    if let Some(server_addr) = quick_play_server {
        let trimmed = server_addr.trim();
        // Strict safety check: validate safe hostname / IP characters (no whitespace, controls, or traversal)
        let is_safe = !trimmed.is_empty()
            && trimmed.len() <= 253
            && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '_');

        if is_safe {
            if mc_version_at_least(&instance.game_version, 1, 20) {
                tracing::info!(
                    "Enabling Quick Play Multiplayer for server '{}' in instance '{}' (MC {})",
                    trimmed,
                    instance.name,
                    instance.game_version
                );
                game_args.push("--quickPlayMultiplayer".to_string());
                game_args.push(trimmed.to_string());
            } else {
                tracing::info!(
                    "Quick Play Multiplayer requested for '{}' but MC {} does not support --quickPlayMultiplayer; launching to title screen",
                    trimmed,
                    instance.game_version
                );
            }
        } else {
            tracing::warn!("Rejected invalid or suspicious Quick Play server address: '{}'", server_addr);
        }
    }

    // 7b. Patch options.txt with global video settings. Every mirrored key is
    // written with a concrete value (the user's setting, or the vanilla default
    // when unset) — the launcher is authoritative at launch time. In-game
    // changes flow back after the session via services::video_options::read_back
    // (see the exit handler below). The single key map lives in video_options so
    // the write and read directions can't drift apart.
    {
        let options_path = game_dir.join("options.txt");
        if let Ok(settings) = crate::services::settings_service::load().await {
            let existing = fs::read_to_string(&options_path).unwrap_or_default();
            let patched = crate::services::video_options::apply(&existing, &settings.video_settings);
            let _ = fs::create_dir_all(&game_dir);
            if let Err(e) = fs::write(&options_path, &patched) {
                tracing::error!("Failed to write options.txt: {}", e);
            }
            // Write the companion mod's own settings file from the same stored
            // state (cape on/off + frame timing; FOV effects). Authoritative at
            // launch, like options.txt; the mod reads it, and changes flow back
            // on exit.
            crate::services::companion_settings::write_for_launch(&settings);
        }

        // Always sync the fullscreen state from the global settings
        // so in-game toggles don't persist unexpectedly across launches.
        let options_path = game_dir.join("options.txt");
        let mut content = fs::read_to_string(&options_path).unwrap_or_default();
        let fullscreen_line = "fullscreen:false";
        let prefix = "fullscreen:";
        if let Some(pos) = content.find(prefix) {
            let end = content[pos..].find('\n').map(|i| pos + i).unwrap_or(content.len());
            content.replace_range(pos..end, fullscreen_line);
        } else if !content.is_empty() {
            if !content.ends_with('\n') { content.push('\n'); }
            content.push_str(fullscreen_line);
            content.push('\n');
        }
        let _ = fs::write(&options_path, &content);
    }

    // Ensure the companion mod jar matches the in-game cape state: install the
    // version/loader-matched jar into mods/ when the cape is on (download-on-
    // demand, the first time it's needed), or remove our managed jar when off /
    // unsupported. Best-effort — never blocks the launch. Surfaces the result
    // to the frontend so the user sees whether the cape will work this run.
    let companion_status = crate::services::companion_mod::ensure_installed(instance).await;
    if let Some(ref win) = window {
        use tauri::Emitter;
        let _ = win.emit("companion-mod-status", &companion_status);
    }

    // 8. Spawn process with stdout/stderr capture
    let mut cmd = Command::new(&java);
    cmd.args(&jvm_args);
    cmd.arg(&main_class);
    cmd.args(&game_args);
    cmd.current_dir(&game_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Prevent system Java options from interfering with instance settings
    cmd.env_remove("_JAVA_OPTIONS");

    // On Windows, Java is a console-subsystem binary so the OS would normally
    // pop a black console window for the lifetime of the JVM. Suppress it —
    // log capture is already wired up via the piped stdio above.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::services::java::CREATE_NO_WINDOW);
    }

    tracing::debug!("Launching with main class: {}", main_class);

    // Update last_played timestamp and global last_active_at
    let now_str = chrono::Utc::now().to_rfc3339();
    let meta_path = paths::instances_dir().join(&instance.id).join("instance.json");
    if let Ok(content) = fs::read_to_string(&meta_path) {
        if let Ok(mut inst_data) = serde_json::from_str::<Instance>(&content) {
            inst_data.last_played = Some(now_str.clone());
            if let Ok(json) = serde_json::to_string_pretty(&inst_data) {
                let _ = fs::write(&meta_path, json);
            }
        }
    }

    if let Ok(mut settings) = crate::services::settings_service::load().await {
        settings.last_active_at = Some(now_str);
        if crate::services::settings_service::save(&settings).await.is_ok() {
            crate::services::google_cloud::spawn_background_sync();
        }
    }

    if crate::commands::launch::is_launch_cancelled() {
        return Err("Launch cancelled by user".to_string());
    }
    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))?;
    let pid = child.id();
    crate::commands::launch::GAME_PID.store(pid, std::sync::atomic::Ordering::SeqCst);

    if crate::commands::launch::is_launch_cancelled() {
        tracing::info!("Launch cancelled right as process {} spawned, killing immediately", pid);
        let _ = child.kill();
        crate::commands::launch::GAME_PID.store(0, std::sync::atomic::Ordering::SeqCst);
        return Err("Launch cancelled by user".to_string());
    }

    // Bring the game window to the foreground once it appears, and maximize
    // it too if the user enabled that. The launcher is typically a background
    // process by the time the GLFW window shows (minimized to tray, or the
    // user switched away during the load), so without this the game can open
    // behind the active window regardless of the maximize setting. On other
    // platforms the WM focuses the newly-mapped window and the launch
    // dimensions already cover the screen.
    #[cfg(windows)]
    focus_minecraft_window_async(pid, win_maximized);

    // Spawn background task to capture logs and emit them as events
    let instance_id = instance.id.clone();
    let instance_version = instance.game_version.clone();
    let launch_time = std::time::Instant::now();

    tokio::spawn(async move {
        use std::io::{BufRead, BufReader, Write};
        use tauri::Emitter;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Clone window + instance ID for each reader thread. Each `game-log`
        // event carries the instance ID so the frontend can route lines into
        // a per-instance buffer — without this, switching to a different
        // instance and viewing its Logs tab would show the wrong session's
        // output.
        let win_stdout = window.clone();
        let win_stderr = window.clone();
        let instance_id_stdout = instance_id.clone();
        let instance_id_stderr = instance_id.clone();

        // Spawn a thread to read stdout — emit each line as a game-log event
        let log_path_clone = log_path.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let mut lf = std::fs::OpenOptions::new().append(true).create(true).open(&log_path_clone).ok();
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    // Write to log file for persistence
                    if let Some(ref mut f) = lf {
                        let _ = writeln!(f, "{}", line);
                    }
                    // Emit to frontend in real-time
                    if let Some(ref win) = win_stdout {
                        let _ = win.emit(
                            "game-log",
                            GameLogPayload {
                                instance_id: &instance_id_stdout,
                                line: &line,
                            },
                        );
                    }
                }
            }
        });

        // Spawn a thread to read stderr — same pattern
        let log_path_clone2 = log_path.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let mut lf = std::fs::OpenOptions::new().append(true).create(true).open(&log_path_clone2).ok();
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    if let Some(ref mut f) = lf {
                        let _ = writeln!(f, "{}", line);
                    }
                    if let Some(ref win) = win_stderr {
                        let _ = win.emit(
                            "game-log",
                            GameLogPayload {
                                instance_id: &instance_id_stderr,
                                line: &line,
                            },
                        );
                    }
                }
            }
        });

        // Options.txt watcher: check timestamp every 500ms while the game runs
        let options_path = paths::instances_dir()
            .join(&instance_id)
            .join(".minecraft")
            .join("options.txt");

        let mut last_mtime = std::fs::metadata(&options_path)
            .and_then(|m| m.modified())
            .ok();

        // Monitor options.txt while game is running; exit loop when child terminates.
        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(e) => break Err(e),
                Ok(None) => {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if let Ok(metadata) = std::fs::metadata(&options_path) {
                        if let Ok(mtime) = metadata.modified() {
                            if last_mtime != Some(mtime) {
                                last_mtime = Some(mtime);
                                sync_options_from_game_session(
                                    &instance_id,
                                    &instance_version,
                                    window.as_ref(),
                                ).await;
                            }
                        }
                    }
                }
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Check if game crashed (non-zero exit code)
        let crashed = match &exit_status {
            Ok(status) => !status.success(),
            Err(_) => true,
        };

        // Update total play time
        let elapsed_secs = launch_time.elapsed().as_secs();
        let meta_path = paths::instances_dir().join(&instance_id).join("instance.json");
        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut inst_data) = serde_json::from_str::<Instance>(&content) {
                inst_data.total_play_seconds += elapsed_secs;
                if let Ok(json) = serde_json::to_string_pretty(&inst_data) {
                    let _ = std::fs::write(&meta_path, json);
                }
            }
        }

        // Credit elapsed play time to global lifetime_play_seconds
        if elapsed_secs > 0 {
            if let Ok(mut settings) = crate::services::settings_service::load().await {
                settings.lifetime_play_seconds += elapsed_secs;
                if crate::services::settings_service::save(&settings).await.is_ok() {
                    crate::services::google_cloud::spawn_background_sync();
                }
            }
        }

        // Game exited — reset Discord RPC to idle
        crate::services::discord::set_stopped();

        // Clear the global PID tracker so stop_instance knows nothing is running.
        crate::commands::launch::GAME_PID.store(0, std::sync::atomic::Ordering::SeqCst);

        // If the user clicked "Stop", treat any non-zero exit code as intentional
        // rather than a crash. The flag is consumed (set to false) so subsequent
        // natural crashes are still detected.
        let user_stopped = crate::commands::launch::take_user_stopped();

        // Sync any in-game video-settings changes back into the launcher.
        // Final sync pass on exit to ensure any last-second changes are captured.
        let synced_video = sync_options_from_game_session(
            &instance_id,
            &instance_version,
            window.as_ref(),
        ).await;

        // Game exited — restore window and notify frontend
        if let Some(win) = window {
            // Close the logs popout if it's open — the session is over, so the
            // logs reattach to the main window's Logs tab (the popout's
            // Destroyed handler emits logs-reattached).
            {
                use tauri::Manager;
                if let Some(logs_win) = win.app_handle().get_webview_window("logs") {
                    let _ = logs_win.close();
                }
            }
            let _ = win.show();
            let _ = win.set_focus();
            // Push any in-game video-settings changes to the frontend so an open
            // Settings screen reflects them without a manual reload.
            if let Some(vs) = &synced_video {
                let _ = win.emit("video-settings-synced", vs);
            }
            if crashed && !user_stopped {
                let crash_dir = paths::instances_dir()
                    .join(&instance_id)
                    .join(".minecraft")
                    .join("crash-reports");
                let crash_report = if crash_dir.exists() {
                    std::fs::read_dir(&crash_dir).ok()
                        .and_then(|entries| {
                            entries.flatten()
                                .filter(|e| e.path().extension().map(|ext| ext == "txt").unwrap_or(false))
                                .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
                                .map(|e| e.path().to_string_lossy().to_string())
                        })
                } else { None };
                let _ = win.emit("game-crashed", crash_report);
            } else {
                let _ = win.emit("game-exited", ());
            }
        }
    });

    Ok(pid)
}
