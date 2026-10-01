// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Signalling for content the launcher isn't permitted to download.
//!
//! CurseForge lets an author opt out of third-party distribution
//! (`allowModDistribution: false`), and the API then returns `downloadUrl: null`
//! for that project's files. The launcher used to reconstruct a CDN URL from the
//! numeric file id and fetch it anyway. That worked, but it deliberately
//! circumvented the author's choice, and when CurseForge did block it the user
//! got "Download failed after 3 retries" with nothing actionable.
//!
//! Now the opt-out is honored and the user is handed the project page instead.
//!
//! Modrinth has no equivalent — every listed version is downloadable — so this
//! is a CurseForge-only path with no parallel surface to keep in sync.

use serde::Serialize;
use tauri::Emitter;

/// Event name the frontend listens on. Kebab-case per the project convention.
pub const EVENT: &str = "manual-download-required";

/// One file the user has to fetch themselves.
#[derive(Debug, Clone, Serialize)]
pub struct ManualDownload {
    /// `"mod"` or `"modpack"` — drives the wording in the dialog.
    pub kind: String,
    /// Project name, or the id when the lookup failed.
    pub title: String,
    /// Exact file to look for on the project page. `None` when unknown.
    pub file_name: Option<String>,
    /// CurseForge project page to open. `None` when the lookup failed, in which
    /// case the dialog can still name the file but offers no link.
    pub url: Option<String>,
    /// Instance the file belongs in, so the dialog can offer to open its folder.
    /// `None` for a modpack archive, where no instance exists yet.
    pub instance_id: Option<String>,
}

/// Tell the frontend a file needs fetching by hand.
///
/// Best-effort: a failed emit shouldn't turn into an install failure, since the
/// install has already decided what it's doing. Logged so a silently missing
/// dialog is traceable.
pub fn notify(window: Option<&tauri::WebviewWindow>, payload: ManualDownload) {
    tracing::info!(
        "Manual download required for {} ({:?})",
        payload.title,
        payload.file_name
    );
    match window {
        Some(w) => {
            if let Err(e) = w.emit(EVENT, payload) {
                tracing::warn!("Couldn't emit {}: {}", EVENT, e);
            }
        }
        // No window: a headless path such as an update check. The caller still
        // returns an error, so the user isn't left thinking it succeeded.
        None => tracing::debug!("No window to deliver {} to", EVENT),
    }
}
