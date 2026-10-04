// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Auto-updater service.
//!
//! Two-phase update following the documented Tauri v2 pattern:
//! 1. Frontend calls `start_update_download` after the user opts in. We
//!    download the payload into memory (emitting `update-progress` events so
//!    the UI can render a real progress bar) and stash `(Update, Vec<u8>)`
//!    in `PendingUpdate`.
//! 2. Frontend calls `apply_pending_update`, which runs `Update::install`
//!    directly. On Windows the plugin launches the NSIS installer and then
//!    `std::process::exit(0)`s the app itself (a documented Windows-installer
//!    limitation) — the installer's `/R` flag relaunches the new binary.
//!
//! We deliberately install while the main window is still open and focused.
//! Windows only lets a process hand the foreground to a window it launches if
//! it currently holds the foreground, so installing *before* closing the
//! window is what lets the NSIS progress window appear in front instead of
//! buried behind whatever else is on screen.
//!
//! Splitting download from install (instead of `download_and_install`) is the
//! documented alternative and is what gives us the in-app download progress
//! bar.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

/// Metadata of an available update exposed across IPC to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub rid: ResourceId,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

/// Information about an in-flight release build actively compiling on GitHub Actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightBuild {
    pub version: String,
    pub run_name: String,
    pub html_url: Option<String>,
    pub started_at: Option<String>,
}

/// Detailed status returned by `check_for_updates`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheckResponse {
    #[serde(rename_all = "camelCase")]
    Available {
        #[serde(flatten)]
        metadata: UpdateMetadata,
    },
    #[serde(rename_all = "camelCase")]
    Building {
        version: String,
        run_name: String,
        html_url: Option<String>,
        started_at: Option<String>,
    },
    UpToDate,
}

/// Resource managed by Tauri so we can hold the downloaded bytes between the
/// `start_update_download` and `apply_pending_update` calls.
#[derive(Default)]
pub struct PendingUpdate {
    pub data: Mutex<Option<(Arc<Update>, Vec<u8>)>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgressPayload {
    /// `"downloading"` | `"installing"` | `"done"` | `"error"`
    pub phase: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// 0.0 → 1.0; for `"installing"` we go indeterminate (caller should
    /// render a spinner) since NSIS gives no progress callbacks.
    pub fraction: f64,
    pub message: String,
}

/// Download the update payload into memory, emitting `update-progress` events.
/// The bytes are stashed in `PendingUpdate` for `apply_pending_update` to
/// consume.
pub async fn start_update_download<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> Result<(), String> {
    let pending = webview.state::<PendingUpdate>();
    let update: Arc<Update> = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|e| format!("Update resource not found: {}", e))?;

    let app = webview.app_handle().clone();

    let bytes_total: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
    let bytes_done: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));

    let bytes_total_cb = bytes_total.clone();
    let bytes_done_cb = bytes_done.clone();
    let app_cb = app.clone();

    let data = update
        .download(
            move |chunk_size, total| {
                if let Some(t) = total {
                    if let Ok(mut bt) = bytes_total_cb.lock() {
                        *bt = t;
                    }
                }
                let total_now = bytes_total_cb.lock().map(|g| *g).unwrap_or(0);
                let done_now = if let Ok(mut bd) = bytes_done_cb.lock() {
                    *bd += chunk_size as u64;
                    *bd
                } else {
                    0
                };
                let frac = if total_now > 0 {
                    (done_now as f64 / total_now as f64).min(1.0)
                } else {
                    0.0
                };
                // Best-effort emit; if the webview is gone, silently skip.
                let _ = app_cb.emit(
                    "update-progress",
                    UpdateProgressPayload {
                        phase: "downloading",
                        bytes_done: done_now,
                        bytes_total: total_now,
                        fraction: frac,
                        message: format!(
                            "Downloading update ({:.1} / {:.1} MB)",
                            done_now as f64 / 1_048_576.0,
                            total_now as f64 / 1_048_576.0
                        ),
                    },
                );
            },
            || {
                // download finished callback — handled inline below
            },
        )
        .await
        .map_err(|e| format!("Update download failed: {}", e))?;

    let total_now = bytes_total.lock().map(|g| *g).unwrap_or(data.len() as u64);
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            phase: "downloading",
            bytes_done: data.len() as u64,
            bytes_total: total_now,
            fraction: 1.0,
            message: "Download complete".to_string(),
        },
    );

    if let Ok(mut slot) = pending.data.lock() {
        slot.replace((update, data));
    }

    Ok(())
}

/// Install the buffered update. Runs `Update::install` directly while the
/// main window is still open and focused — on Windows the plugin launches the
/// NSIS installer (which inherits our foreground so its progress window
/// appears in front) and then exits the process itself; the installer's `/R`
/// flag relaunches the new binary. On Linux/macOS `install` returns normally,
/// so we relaunch explicitly.
pub async fn apply_pending_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let buffered = {
        let pending = app.state::<PendingUpdate>();
        let slot = pending.data.lock().map_err(|e| e.to_string())?;
        slot.clone()
    };
    let Some((update, data)) = buffered else {
        return Err("No pending update to install".to_string());
    };

    // Surface the install phase to the UI. NSIS gives no progress callbacks,
    // so the frontend renders an indeterminate state for the brief moment
    // before the process exits.
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            phase: "installing",
            bytes_done: 0,
            bytes_total: 0,
            fraction: 0.0,
            message: "Installing update...".to_string(),
        },
    );

    tracing::info!(
        "Installing update v{} (was on v{})",
        update.version,
        update.current_version
    );

    update
        .install(&data)
        .map_err(|e| format!("Update install failed: {}", e))?;

    // Reached only on platforms where `install` doesn't exit the process
    // (Linux/macOS). On Windows the plugin has already exited by now.
    app.restart();
}

/// Drop any buffered update without installing it. Called by the frontend
/// when the user dismisses the "update available" prompt.
pub fn clear_pending_update<R: Runtime>(app: &AppHandle<R>) {
    let pending = app.state::<PendingUpdate>();
    let mut slot = match pending.data.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    slot.take();
}

/// Query the latest commit SHA of the `updates` branch on GitHub.
/// An immutable commit SHA bypasses Fastly CDN edge caching on `raw.githubusercontent.com`
/// (which otherwise forces a 300-second TTL on branch heads).
async fn fetch_latest_updates_sha() -> Option<String> {
    #[derive(Deserialize)]
    struct CommitRef {
        sha: String,
    }

    let resp = crate::util::http::HTTP
        .get("https://api.github.com/repos/VermeilDev/Vermeil-Launcher/commits/updates")
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .ok()?;

    if resp.status().is_success() {
        let commit_data = resp.json::<CommitRef>().await.ok()?;
        Some(commit_data.sha)
    } else {
        None
    }
}

/// Resolve the updater manifest URL, querying GitHub API for the latest
/// commit SHA so edge caches are bypassed. Falls back to the static branch URL if
/// GitHub API rate limits or network issues occur.
async fn resolve_updates_endpoint(channel_name: &str) -> String {
    let manifest_file = if channel_name == "experimental" {
        "experimental-latest.json"
    } else {
        "latest.json"
    };

    let commit_sha = match fetch_latest_updates_sha().await {
        Some(sha) if !sha.is_empty() => sha,
        _ => "updates".to_string(),
    };

    format!(
        "https://raw.githubusercontent.com/VermeilDev/Vermeil-Launcher/{}/{}",
        commit_sha, manifest_file
    )
}

/// Check if a release build is actively compiling on GitHub Actions.
async fn detect_in_flight_build() -> Option<InFlightBuild> {
    #[derive(Deserialize)]
    struct WorkflowRun {
        name: String,
        head_branch: Option<String>,
        status: String,
        html_url: Option<String>,
        created_at: Option<String>,
    }

    #[derive(Deserialize)]
    struct ActionsRunsResponse {
        workflow_runs: Vec<WorkflowRun>,
    }

    let resp = crate::util::http::HTTP
        .get("https://api.github.com/repos/VermeilDev/Vermeil-Launcher/actions/runs?event=push&per_page=5")
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let data = resp.json::<ActionsRunsResponse>().await.ok()?;

    for run in data.workflow_runs {
        let is_running = matches!(
            run.status.as_str(),
            "in_progress" | "queued" | "waiting" | "requested" | "pending"
        );
        if !is_running {
            continue;
        }

        let branch = run.head_branch.as_deref().unwrap_or("");
        let is_release_run = run.name.starts_with("Release") || branch.starts_with('v');

        if is_release_run {
            let version = if let Some(stripped) = branch.strip_prefix('v') {
                stripped.to_string()
            } else if let Some(stripped) = run.name.strip_prefix("Release v") {
                stripped.to_string()
            } else if let Some(stripped) = run.name.strip_prefix("Release ") {
                stripped.strip_prefix('v').unwrap_or(stripped).to_string()
            } else {
                branch.to_string()
            };

            if !version.is_empty() {
                tracing::info!(
                    "Detected in-flight release build v{} (run: '{}', status: '{}')",
                    version,
                    run.name,
                    run.status
                );
                return Some(InFlightBuild {
                    version,
                    run_name: run.name,
                    html_url: run.html_url,
                    started_at: run.created_at,
                });
            }
        }
    }

    None
}

/// Check for updates on the requested channel ("stable" or "experimental"),
/// dynamically configuring the updater endpoint and version comparator.
/// When `allow_downgrades` is true, versions different from current are
/// accepted, allowing bidirectional rollbacks between channels.
pub async fn check_for_updates<R: Runtime>(
    webview: Webview<R>,
    channel: Option<String>,
    allow_downgrades: Option<bool>,
) -> Result<UpdateCheckResponse, String> {
    let mut builder = webview.updater_builder();

    let channel_name = channel.unwrap_or_else(|| "stable".to_string());
    let endpoint_url = resolve_updates_endpoint(&channel_name).await;

    let url = Url::parse(&endpoint_url).map_err(|e| format!("Invalid updater URL: {}", e))?;
    builder = builder
        .endpoints(vec![url])
        .map_err(|e| format!("Failed to configure updater endpoints: {}", e))?;

    if allow_downgrades.unwrap_or(false) || channel_name == "experimental" {
        builder = builder.version_comparator(|current, update| update.version != current);
    }

    let updater = builder
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;
    let update = match updater.check().await {
        Ok(u) => u,
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => None,
        Err(e) => {
            tracing::warn!("Updater check returned error: {}", e);
            None
        }
    };

    if let Some(update) = update {
        let formatted_date = update.date.map(|d| d.to_string());
        let rid = webview.resources_table().add(update.clone());
        Ok(UpdateCheckResponse::Available {
            metadata: UpdateMetadata {
                rid,
                current_version: update.current_version,
                version: update.version,
                date: formatted_date,
                body: update.body,
            },
        })
    } else if let Some(building) = detect_in_flight_build().await {
        Ok(UpdateCheckResponse::Building {
            version: building.version,
            run_name: building.run_name,
            html_url: building.html_url,
            started_at: building.started_at,
        })
    } else {
        Ok(UpdateCheckResponse::UpToDate)
    }
}
