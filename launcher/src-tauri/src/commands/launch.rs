// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::launch;
use crate::services::instance_service;
use crate::util::paths;
use std::fs;
use std::sync::atomic::{AtomicU32, AtomicBool, Ordering};

/// PID of the currently running game process. 0 means no game is running.
pub static GAME_PID: AtomicU32 = AtomicU32::new(0);

/// The instance whose logs the popout window should show. Set at launch time
/// so the standalone logs window (which loads a fresh webview with no app
/// state) can ask the backend what to display on mount, instead of relying on
/// fragile URL parsing or racing the webview load with an event.
static CURRENT_LOG_TARGET: std::sync::Mutex<Option<LogTarget>> = std::sync::Mutex::new(None);

/// Identifies the instance a logs popout should render: the ID drives the log
/// file read and the `game-log` event filter; the name is shown in the header.
#[derive(Clone, serde::Serialize)]
pub struct LogTarget {
    pub instance_id: String,
    pub name: String,
}
/// Set to `true` when the user clicks "Stop" so the exit handler knows
/// not to emit `game-crashed` for the non-zero exit code that results
/// from a graceful termination signal.
static USER_STOPPED: AtomicBool = AtomicBool::new(false);

/// Check whether the user requested a stop (and clear the flag).
pub fn take_user_stopped() -> bool {
    USER_STOPPED.swap(false, Ordering::SeqCst)
}

/// Set to `true` while an instance is actively launching to prevent concurrent launch races.
static IS_LAUNCHING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn launch_instance(
    instance_id: String,
    quick_play_world: Option<String>,
    quick_play_server: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<u32, String> {
    if GAME_PID.load(Ordering::SeqCst) != 0 {
        return Err("A game instance is already running. Please close it before launching another.".to_string());
    }
    if IS_LAUNCHING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("A game instance is currently launching. Please wait a moment.".to_string());
    }
    struct LaunchGuard;
    impl Drop for LaunchGuard {
        fn drop(&mut self) {
            IS_LAUNCHING.store(false, Ordering::SeqCst);
        }
    }
    let _launch_guard = LaunchGuard;

    // Clear old log file before launching
    let log_path = paths::instances_dir()
        .join(&instance_id)
        .join(".minecraft")
        .join("logs")
        .join("latest.log");
    let _ = fs::write(&log_path, "");

    // Get instance
    let instance = instance_service::get_by_id(&instance_id).await
        .map_err(|e| e.to_string())?;

    // Get active account with proactive token freshness verification
    let (username, uuid, token) = crate::commands::auth::get_launch_account().await?;

    // Launch the game
    let pid = launch::launch(
        &instance,
        &username,
        &uuid,
        &token,
        quick_play_world.as_deref(),
        quick_play_server.as_deref(),
        Some(window.clone()),
    ).await?;
    GAME_PID.store(pid, Ordering::SeqCst);
    USER_STOPPED.store(false, Ordering::SeqCst);

    // Hide the launcher to the tray if "Minimize to tray on launch" is on.
    // This is the single chokepoint both launch entry points (Home and the
    // FloatingDock) funnel through, so the behaviour stays consistent. The
    // game-exit handler in services::launch restores the window (show +
    // focus), so it round-trips automatically when the session ends.
    if let Ok(settings) = crate::services::settings_service::load().await {
        // Record which instance the logs popout should track, then open or
        // refocus it if the user enabled the feature. Done before the hide so
        // the popout is up regardless of whether the main window goes to tray.
        let target = LogTarget { instance_id: instance_id.clone(), name: instance.name.clone() };
        if let Ok(mut guard) = CURRENT_LOG_TARGET.lock() {
            *guard = Some(target.clone());
        }
        if settings.popout_logs {
            open_logs_popout(&window, &target);
        }
        if settings.close_on_launch {
            let _ = window.hide();
        }
    }

    // Set Discord Rich Presence to "Playing"
    crate::services::discord::set_playing(
        &instance.name,
        &instance.game_version,
        instance.loader.loader_type.display_name(),
        instance.mods.len(),
    );



    Ok(pid)
}

#[tauri::command]
/// `version_id` installs one specific version. Omitted (the Browse card's
/// Install button) resolves the newest compatible version instead.
pub async fn install_mod_to_instance(
    instance_id: String,
    project_id: String,
    loader: String,
    game_version: String,
    category: Option<String>,
    version_id: Option<String>,
) -> Result<String, String> {
    let cat = category.unwrap_or_else(|| "mod".to_string());
    let result = crate::services::mod_install::install_mod(
        &instance_id,
        &project_id,
        &loader,
        &game_version,
        &cat,
        version_id,
    )
    .await?;

    // Return JSON with mod entry + accurate dependency counts/titles, mirroring
    // what Modrinth returns to its frontend so the toast can list installed deps.
    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

/// Install a mod from CurseForge into an instance. Same return shape as
/// `install_mod_to_instance` so the frontend reuses the same toast/modal.
#[tauri::command]
/// `file_id` installs one specific file. Omitted (the Browse card's Install
/// button) resolves the newest compatible file instead.
pub async fn install_cf_mod_to_instance(
    instance_id: String,
    mod_id: String,
    loader: String,
    game_version: String,
    category: Option<String>,
    file_id: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let cat = category.unwrap_or_else(|| "mod".to_string());
    let api_key = crate::commands::mods::resolve_cf_api_key().await?;
    let result = crate::services::cf_mod_install::install_cf_mod(
        &instance_id,
        &mod_id,
        &loader,
        &game_version,
        &cat,
        &api_key,
        file_id,
        // Lets the installer raise the manual-download dialog when CurseForge
        // won't serve a file.
        Some(&window),
    )
    .await?;

    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

#[tauri::command]
pub async fn remove_mod_from_instance(
    instance_id: String,
    entry_id: String,
) -> Result<(), String> {
    crate::services::mod_install::remove_mod(&instance_id, &entry_id).await
}

#[tauri::command]
pub async fn remove_mods_from_instance(
    instance_id: String,
    entry_ids: Vec<String>,
) -> Result<usize, String> {
    crate::services::mod_install::remove_mods(&instance_id, &entry_ids).await
}

/// Reconcile mod jars the user dropped into the instance's `mods/` folder by
/// hand into the tracked list, so they show up in the Installed tab. Also
/// triggers background metadata and icon enrichment if any modpack-bundled
/// mods are missing titles or cached local icons, automatically healing
/// instances whose initial enrichment failed or was interrupted.
#[tauri::command]
pub async fn sync_instance_mods(
    instance_id: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    crate::services::mod_install::sync_manual_mods(&instance_id).await?;

    let inst_id = instance_id.clone();
    tokio::spawn(async move {
        let meta_path = crate::util::paths::instances_dir().join(&inst_id).join("instance.json");
        if let Ok(content) = tokio::fs::read_to_string(&meta_path).await {
            if let Ok(instance) = serde_json::from_str::<crate::models::instance::Instance>(&content) {
                let needs_enrichment = instance.mods.iter().any(|m| {
                    ((m.source == "modpack" || instance.source_project_id.is_some()) && m.title.is_none())
                        || (m.icon_url.is_some()
                            && (m.local_icon_path.is_none()
                                || m.local_icon_path.as_ref().is_some_and(|p| !std::path::Path::new(p).exists())))
                });
                if needs_enrichment {
                    let _ = crate::services::modpack::enrich_mod_metadata(&inst_id, Some(window)).await;
                }
            }
        }
    });

    Ok(())
}

/// Detect available updates for every Modrinth- and CurseForge-sourced mod in
/// the given instance. Returned map is keyed by `project_id` so the frontend
/// can look up update info per card without scanning a list.
#[tauri::command]
pub async fn check_mod_updates(
    instance_id: String,
) -> Result<std::collections::HashMap<String, crate::services::mod_updates::ModUpdate>, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;
    crate::services::mod_updates::check_updates(&instance).await
}

/// Apply an update for a single project. Removes the old file, downloads the
/// new version, and walks required dependencies. Returns the same shape as
/// `install_mod_to_instance` so the frontend can reuse the issues modal.
#[tauri::command]
pub async fn apply_mod_update(
    instance_id: String,
    project_id: String,
) -> Result<String, String> {
    let result = crate::services::mod_updates::apply_update(&instance_id, &project_id).await?;
    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

/// Bulk-delete every content entry in an instance. `category` filters by
/// "mod" / "resourcepack" / "shader" / "datapack", or "all" for every entry.
/// Returns the count removed so the UI can show a confirmation toast.
#[tauri::command]
pub async fn remove_all_content(
    instance_id: String,
    category: String,
) -> Result<usize, String> {
    crate::services::mod_install::remove_all_content(&instance_id, &category).await
}

#[tauri::command]
pub async fn toggle_mod_in_instance(
    instance_id: String,
    entry_id: String,
) -> Result<bool, String> {
    crate::services::mod_install::toggle_mod(&instance_id, &entry_id).await
}

#[tauri::command]
pub async fn get_instance_logs(instance_id: String) -> Result<Vec<String>, String> {
    let log_path = paths::instances_dir()
        .join(&instance_id)
        .join(".minecraft")
        .join("logs")
        .join("latest.log");

    if !log_path.exists() {
        return Ok(Vec::new());
    }

    // Cap at the last 2,000 lines. Modded Minecraft can produce 10–50+ MB
    // log files; reading them entirely into a Vec<String> and serializing over
    // IPC would spike memory and freeze the WebView. The live `game-log` events
    // provide the full stream during gameplay.
    let content = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(2000);
    let lines: Vec<String> = all_lines[start..].iter().map(|l| l.to_string()).collect();
    Ok(lines)
}

/// Read a crash-report file and return its contents as a string. Path comes
/// from the `game-crashed` event payload (the launcher service emits the
/// most recently written `crash-reports/*.txt` when the JVM exits non-zero).
///
/// Crash reports are typically 5–50 KB; reading them in one go is fine. We
/// resolve them under the configured instances directory so the path can't
/// be used to read arbitrary files even if a malicious payload were
/// constructed somehow.
#[tauri::command]
pub async fn get_crash_report(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Resolve crash report path: {}", e))?;
    let instances_dir = paths::instances_dir()
        .canonicalize()
        .map_err(|e| format!("Resolve instances dir: {}", e))?;
    if !canonical.starts_with(&instances_dir) {
        return Err("Crash report path is outside instances dir".to_string());
    }
    fs::read_to_string(&canonical).map_err(|e| format!("Read crash report: {}", e))
}

#[tauri::command]
pub async fn stop_instance() -> Result<(), String> {
    let pid = GAME_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return Err("No game is running".to_string());
    }

    // Mark that the user intentionally stopped the game, so the exit
    // handler (in launch.rs background task) won't emit `game-crashed`.
    USER_STOPPED.store(true, Ordering::SeqCst);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Send a graceful close (WM_CLOSE via taskkill without /F).
        // This triggers Minecraft's shutdown hook: saves worlds, flushes
        // chunks, closes connections — same as clicking the window X button.
        // CREATE_NO_WINDOW prevents the brief black console flash.
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .creation_flags(crate::services::java::CREATE_NO_WINDOW)
            .output();

        // Wait up to 10s for the process to exit gracefully.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // Check if process still exists
            let check = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
                .creation_flags(crate::services::java::CREATE_NO_WINDOW)
                .output();
            if let Ok(output) = check {
                let out = String::from_utf8_lossy(&output.stdout);
                if !out.contains(&pid.to_string()) {
                    // Process exited
                    break;
                }
            }
            if std::time::Instant::now() >= deadline {
                // Force-kill as last resort
                tracing::warn!("Game PID {} didn't exit gracefully after 10s, force-killing", pid);
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .creation_flags(crate::services::java::CREATE_NO_WINDOW)
                    .output();
                break;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Send SIGTERM for graceful shutdown (triggers JVM shutdown hooks).
        let _ = std::process::Command::new("kill")
            .args(&["-TERM", &pid.to_string()])
            .output();

        // Wait up to 10s, then force-kill.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let check = std::process::Command::new("kill")
                .args(&["-0", &pid.to_string()])
                .output();
            if let Ok(output) = check {
                if !output.status.success() {
                    // Process no longer exists
                    break;
                }
            }
            if std::time::Instant::now() >= deadline {
                tracing::warn!("Game PID {} didn't exit gracefully after 10s, force-killing", pid);
                let _ = std::process::Command::new("kill")
                    .args(&["-9", &pid.to_string()])
                    .output();
                break;
            }
        }
    }

    GAME_PID.store(0, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn minimize_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// Which instance the logs popout should display. The popout window loads a
/// fresh webview with no app state, so it queries this on mount to learn what
/// to render. Returns `None` if no game has been launched this session.
#[tauri::command]
pub async fn current_log_target() -> Option<LogTarget> {
    CURRENT_LOG_TARGET.lock().ok().and_then(|g| g.clone())
}

/// Read an instance's persisted session log (`latest.log`). The popout seeds
/// its viewer with this on open, then tails live `game-log` events. A missing
/// file (game never launched, or logs dir not yet created) is not an error —
/// it just means there's nothing to show yet.
#[tauri::command]
pub async fn read_instance_log(instance_id: String) -> Result<String, String> {
    // Validate the id before letting it into a path join. Instance IDs are
    // simple slugs; rejecting separators and parent refs stops a crafted id
    // (e.g. "../../something") from reading files outside the instances dir.
    validate_instance_id(&instance_id)?;
    let log_path = paths::instances_dir()
        .join(&instance_id)
        .join(".minecraft")
        .join("logs")
        .join("latest.log");
    // Cap at the last 1 MB. Modded Minecraft logs can reach 10–50+ MB; sending
    // the entire file across IPC as a single string would spike memory and
    // freeze the WebView renderer. The popout viewer seeds with this tail, then
    // tails live `game-log` events for the full stream.
    const MAX_LOG_BYTES: u64 = 1_024 * 1_024;
    match std::fs::metadata(&log_path) {
        Ok(meta) => {
            let len = meta.len();
            if len == 0 {
                return Ok(String::new());
            }
            if len <= MAX_LOG_BYTES {
                return fs::read_to_string(&log_path).map_err(|e| e.to_string());
            }
            // Read only the tail.
            use std::io::{Read, Seek, SeekFrom};
            let mut file = std::fs::File::open(&log_path)
                .map_err(|e| format!("Open log for {}: {}", instance_id, e))?;
            file.seek(SeekFrom::End(-(MAX_LOG_BYTES as i64)))
                .map_err(|e| format!("Seek log for {}: {}", instance_id, e))?;
            let mut buf = String::with_capacity(MAX_LOG_BYTES as usize);
            file.read_to_string(&mut buf)
                .map_err(|e| format!("Read log tail for {}: {}", instance_id, e))?;
            // Drop the first partial line (we likely seeked into the middle of one).
            if let Some(pos) = buf.find('\n') {
                buf.drain(..=pos);
            }
            Ok(buf)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read log for {}: {}", instance_id, e)),
    }
}

/// Reject instance IDs that aren't a single safe path component. Guards every
/// command that turns a frontend-supplied id into a filesystem path against
/// traversal (`..`), absolute paths, and drive/separator tricks.
fn validate_instance_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains(':')
    {
        return Err(format!("Invalid instance id: {}", id));
    }
    Ok(())
}

/// Close the logs popout window. Backs the "Bring logs back" button in the
/// Logs tab; the window's Destroyed handler then emits `logs-reattached`, so
/// the button and the native close button converge on the same reattach path.
#[tauri::command]
pub async fn close_logs_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("logs") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the standalone logs window for `target`, or refocus the existing one
/// and point it at the new instance. Driven by the `popout_logs` setting so
/// users who minimize the launcher to the tray on launch can still watch the
/// game's output. The window uses the label "logs"; the frontend branches on
/// that label to render only the log viewer instead of the full launcher.
fn open_logs_popout(window: &tauri::WebviewWindow, target: &LogTarget) {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

    let app = window.app_handle();

    // Reuse a single logs window across launches: re-point the existing one
    // at the newly-launched instance and surface it, rather than spawning a
    // second window. The listener is already attached by now, so the event
    // is delivered reliably.
    if let Some(existing) = app.get_webview_window("logs") {
        let _ = existing.emit("logs-load-instance", target.clone());
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        // Already detached — make sure the main window reflects that.
        let _ = app.emit("logs-popped-out", ());
        return;
    }

    match WebviewWindowBuilder::new(
        app,
        "logs",
        WebviewUrl::App("index.html".into()),
    )
    .title("Vermeil — Logs")
    .inner_size(880.0, 520.0)
    .min_inner_size(480.0, 320.0)
    .decorations(false)
    .build()
    {
        Ok(logs_win) => {
            // Reattach on close: when the user closes the logs window (native
            // close button, or via the Logs-tab "Bring logs back" button which
            // routes through close_logs_window), tell the main window so its
            // Logs tab restores the live viewer. Both close paths funnel
            // through Destroyed, so one handler covers both.
            let app_handle = app.clone();
            logs_win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let _ = app_handle.emit("logs-reattached", ());
                }
            });
            // Now that the window exists, tell the main window to show the
            // detached placeholder in its Logs tab.
            let _ = app.emit("logs-popped-out", ());
        }
        Err(e) => tracing::error!("Failed to open logs popout window: {}", e),
    }
}

/// Resolve the full JVM argument string for a given instance's GC preset and
/// memory allocation. Used by the frontend to display the resolved flags in
/// the per-instance Java arguments field so users see exactly what's applied.
#[tauri::command]
pub async fn get_resolved_jvm_args(instance_id: String) -> Result<String, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let java_major = crate::services::launch::required_java_version(&instance.game_version);
    let gc_preset = settings.gc_preset.as_str();
    // Display the effective heap (post-adaptive). Without this the args
    // editor's preview would lie when adaptive RAM bumps the heap up or
    // down vs the slider.
    let effective = crate::services::memory::resolve(
        &instance,
        &settings,
        crate::services::memory::system_memory_mb(),
    );
    let gc_flags = crate::services::launch::resolve_gc_flags(gc_preset, java_major, effective.value_mb);

    let initial_mb = if instance.java.adaptive_override && instance.java.memory_min_mb > 512 {
        instance.java.memory_min_mb.min(effective.value_mb)
    } else {
        effective.value_mb
    };

    // Build the full resolved string: -Xmx, -Xms, GC flags, then user extra args
    let mut all_args = vec![
        format!("-Xmx{}m", effective.value_mb),
        format!("-Xms{}m", initial_mb),
    ];
    all_args.extend(gc_flags);
    all_args.extend(instance.java.extra_args.iter().filter(|a| !a.is_empty()).cloned());

    Ok(all_args.join(" "))
}

/// Resolve just the *preset* JVM arguments (memory + GC flags) for an instance,
/// without the user's extra args. Returned as a list so the frontend can
/// render each flag on its own line in the args editor. Extras are already
/// available client-side in `instance.java.extra_args`.
#[tauri::command]
pub async fn get_preset_jvm_args(instance_id: String) -> Result<Vec<String>, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let java_major = crate::services::launch::required_java_version(&instance.game_version);
    let effective = crate::services::memory::resolve(
        &instance,
        &settings,
        crate::services::memory::system_memory_mb(),
    );
    let gc_flags = crate::services::launch::resolve_gc_flags(
        &settings.gc_preset,
        java_major,
        effective.value_mb,
    );

    let initial_mb = if instance.java.adaptive_override && instance.java.memory_min_mb > 512 {
        instance.java.memory_min_mb.min(effective.value_mb)
    } else {
        effective.value_mb
    };

    let mut preset = vec![
        format!("-Xmx{}m", effective.value_mb),
        format!("-Xms{}m", initial_mb),
    ];
    preset.extend(gc_flags);
    Ok(preset)
}

/// Resolve the effective heap allocation + breakdown for an instance.
///
/// Returns everything the per-instance Settings tab needs to render the
/// memory display: the value the launcher will pass as `-Xmx`, the formula's
/// raw target (so the UI can flag a "capped" condition when the user's max
/// isn't enough), the active min/max bounds, and a structured breakdown of
/// the formula's contributions for the "Why this value?" tooltip.
#[tauri::command]
pub async fn get_effective_memory(
    instance_id: String,
) -> Result<crate::services::memory::EffectiveMemory, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;
    crate::services::memory::resolve_async(&instance).await
}

/// Resolve every known GC preset's flag set for a specific instance (memory
/// args excluded — those come from the slider). The frontend uses this to
/// detect whether the instance's stored `extra_args` matches *any* preset's
/// flags. If so, the args are treated as preset-equal (no real customization)
/// and the global preset selection stays live: switching the preset in
/// Settings actually takes effect on the next launch instead of being
/// silently overridden by stale preset-equal `extra_args` saved during a
/// previous preset.
#[tauri::command]
pub async fn get_known_preset_args(
    instance_id: String,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let java_major = crate::services::launch::required_java_version(&instance.game_version);
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let effective = crate::services::memory::resolve(
        &instance,
        &settings,
        crate::services::memory::system_memory_mb(),
    );
    let memory = effective.value_mb;

    // Keep this list in sync with `services::launch::resolve_gc_flags` and the
    // dropdown on the Settings screen. If a new preset is added to one, add
    // it here too — the frontend's "is this preset-equal?" check loops over
    // these values verbatim.
    let presets = ["g1gc", "zgc", "shenandoah"];
    let mut out = std::collections::HashMap::new();
    for name in &presets {
        let flags = crate::services::launch::resolve_gc_flags(name, java_major, memory);
        out.insert((*name).to_string(), flags);
    }
    Ok(out)
}
