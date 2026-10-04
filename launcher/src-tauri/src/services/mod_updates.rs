// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Mod update detection + application.
//!
//! For each Modrinth- or CurseForge-sourced mod in an instance we ask that
//! source for the newest file compatible with the instance's loader + game
//! version, and compare it against what's recorded in `instance.json`:
//!
//!   - **Modrinth**: fetch the project's full version list (filtered to the
//!     loader + game version), run the same compatibility picker we use at
//!     install time (`find_preferred_version`), and compare the chosen
//!     `version_id`. A mismatch with a newer `date_published` means an update.
//!   - **CurseForge**: fetch the project's files and run the same picker the
//!     install flow uses (`cf_mod_install::find_preferred_file`), then compare
//!     file ids. CF ids are globally monotonic, so a strictly-greater id means a
//!     genuinely newer file and we never flag a downgrade. Sharing the picker is
//!     what stops "an update is available" from naming a different file than the
//!     one an install would actually fetch.
//!
//! Entries marked `pinned` are skipped entirely: they're held at a version some
//! other installed mod requires exactly, so offering to move them would break
//! the mod that pinned them.
//!
//! Update application reuses the matching install flow (`mod_install::install_mod`
//! for Modrinth, `cf_mod_install::install_cf_mod` for CurseForge), passing the
//! exact version the check reported so detection and application can't diverge.
//! The install flow replaces the entry in place — deleting the superseded file
//! and carrying `enabled` across the swap — so there's nothing to clean up here.

use crate::models::instance::Instance;
use crate::services::mod_install::{
    self, InstallResult, ProjectType, find_preferred_version,
};
use crate::services::{cf_mod_install, curseforge, modrinth};
use crate::util::paths;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;

/// Resolve the effective CurseForge API key: the user's if set, else the
/// built-in default.
async fn resolve_cf_key() -> String {
    crate::commands::mods::resolve_cf_api_key().await.unwrap_or_else(|_| crate::commands::mods::DEFAULT_CURSEFORGE_KEY.to_string())
}

/// One available update for an installed Modrinth mod. Surfaced per project
/// id so the frontend can decorate each installed-tab card with an "Update"
/// pill when a match exists.
#[derive(Debug, Clone, Serialize)]
pub struct ModUpdate {
    pub project_id: String,
    pub current_version_id: String,
    pub latest_version_id: String,
    pub latest_version_number: String,
    pub latest_filename: String,
    pub latest_published: Option<String>,
}

/// Check every Modrinth- or CurseForge-sourced mod in an instance for updates.
///
/// Returns a map keyed by project_id so the frontend can render a badge by
/// looking up `mod.project_id` directly.
///
/// Skipped: manually-added jars and modpack-bundled mods (both `.mrpack` and
/// CurseForge pack imports). Modpack mods are curated and version-locked by the
/// pack author; updating individual jars risks breaking configs, scripts, or
/// crashing the game. Only user-installed mods added directly via Browse (which
/// carry a `version_number` and `source != "modpack"`) or mods in custom
/// instances are update-checked.
///
/// Network calls are issued sequentially to be polite to both APIs (Modrinth
/// is rate-limited; CurseForge per-key limits can revoke abusive keys). This
/// runs at most once per Installed-tab mount and the result is cached on the
/// frontend until the user navigates away.
pub async fn check_updates(instance: &Instance) -> Result<HashMap<String, ModUpdate>, String> {
    let mut updates: HashMap<String, ModUpdate> = HashMap::new();

    // Avoid checking the same project twice (a user could have the same mod
    // installed under two different categories — unlikely but cheap to guard).
    let mut seen: HashSet<String> = HashSet::new();

    // Resolved lazily on the first CurseForge entry so a Modrinth-only instance
    // never loads settings or touches the CF API.
    let mut cf_key: Option<String> = None;

    for entry in &instance.mods {
        if entry.project_id.is_empty() || entry.version_id.is_empty() {
            continue;
        }
        // Held at an exact version another installed mod requires. Updating it
        // would break that mod, so don't even offer it.
        if entry.pinned {
            continue;
        }
        // Modpack-bundled mods should never be updated individually. Modpack
        // entries have source == "modpack" or have no version_number in a
        // modpack instance. Only mods the user explicitly installed on top of
        // the pack (which carry a version_number) are update-checked.
        if entry.source == "modpack"
            || (instance.source_project_id.is_some() && entry.version_number.is_none())
        {
            continue;
        }
        if !seen.insert(entry.project_id.clone()) {
            continue;
        }

        match entry.source.as_str() {
            "modrinth" => {
                if let Some(update) = check_modrinth_entry(instance, entry).await {
                    updates.insert(entry.project_id.clone(), update);
                }
            }
            "curseforge" => {
                if cf_key.is_none() {
                    cf_key = Some(resolve_cf_key().await);
                }
                if let Some(update) =
                    check_curseforge_entry(instance, entry, cf_key.as_deref().unwrap()).await
                {
                    updates.insert(entry.project_id.clone(), update);
                }
            }
            // modpack-bundled / manual — no source of truth.
            _ => {}
        }
    }

    Ok(updates)
}

/// Detect a Modrinth update for one installed entry. Returns `None` when the
/// entry is already current, has no compatible version, or the lookup fails.
async fn check_modrinth_entry(
    instance: &Instance,
    entry: &crate::models::instance::ModEntry,
) -> Option<ModUpdate> {
    // Fetch the full version list once per project (Modrinth returns it
    // sorted newest first, which is the order `find_preferred_version`
    // expects).
    let versions = match modrinth::get_project_versions(&entry.project_id, "", "").await {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(
                "Skipping update check for {} ({}): {}",
                entry.title.as_deref().unwrap_or(&entry.project_id),
                entry.project_id,
                e
            );
            return None;
        }
    };

    let project_type = ProjectType::from_category(&entry.category);
    let chosen = find_preferred_version(
        &versions,
        project_type,
        instance.loader.loader_type.as_str(),
        &instance.game_version,
    )?;

    if chosen.id == entry.version_id {
        // Already on the recommended version.
        return None;
    }

    // Sanity: only flag as an update if the picker's choice is newer than
    // what we have. Without this, a stale local `version_id` could be
    // "updated" to a now-removed older version.
    let current_published = versions
        .iter()
        .find(|v| v.id == entry.version_id)
        .and_then(|v| v.date_published.as_deref());
    let chosen_published = chosen.date_published.as_deref();

    if let (Some(curr), Some(next)) = (current_published, chosen_published) {
        if next <= curr {
            return None;
        }
    }

    let filename = chosen
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| chosen.files.first())
        .map(|f| f.filename.clone())
        .unwrap_or_default();

    Some(ModUpdate {
        project_id: entry.project_id.clone(),
        current_version_id: entry.version_id.clone(),
        latest_version_id: chosen.id.clone(),
        latest_version_number: chosen.version_number.clone(),
        latest_filename: filename,
        latest_published: chosen.date_published.clone(),
    })
}

/// Detect a CurseForge update for one installed entry. The CF files endpoint
/// already filters by game version + loader and returns newest-first, so the
/// newest compatible file is the head of the list. CF file IDs are globally
/// monotonic, so we only flag an update when the newest id is strictly greater
/// than the installed one — never a downgrade. Returns `None` when current,
/// empty, or on lookup failure.
async fn check_curseforge_entry(
    instance: &Instance,
    entry: &crate::models::instance::ModEntry,
    api_key: &str,
) -> Option<ModUpdate> {
    let current_id: u64 = entry.version_id.parse().ok()?;
    let loader = cf_mod_install::effective_loader(
        &entry.category,
        instance.loader.loader_type.as_str(),
    );

    let files = match curseforge::get_project_files(
        api_key,
        &entry.project_id,
        &instance.game_version,
        loader,
    )
    .await
    {
        Ok(f) => f,
        Err(e) => {
            tracing::debug!(
                "Skipping CF update check for {} ({}): {}",
                entry.title.as_deref().unwrap_or(&entry.project_id),
                entry.project_id,
                e
            );
            return None;
        }
    };

    // Same picker the install flow uses, so what we report is exactly what an
    // install would fetch: locally validated, stable channel preferred, highest
    // file id within that channel.
    let mut latest = cf_mod_install::find_preferred_file(&files, &instance.game_version, loader).cloned();
    if latest.is_none() && loader == "quilt" {
        if let Ok(fabric_files) = curseforge::get_project_files(
            api_key,
            &entry.project_id,
            &instance.game_version,
            "fabric",
        )
        .await
        {
            latest = cf_mod_install::find_preferred_file(&fabric_files, &instance.game_version, loader).cloned();
        }
    }
    let latest = latest?;

    if latest.file_id <= current_id {
        // Already on the newest (or local id is somehow ahead — never downgrade).
        return None;
    }

    // CF has no semantic version number; the file name (minus extension) is the
    // most meaningful label for the update pill.
    let version_label = latest
        .file_name
        .strip_suffix(".jar")
        .unwrap_or(&latest.file_name)
        .to_string();

    Some(ModUpdate {
        project_id: entry.project_id.clone(),
        current_version_id: entry.version_id.clone(),
        latest_version_id: latest.file_id.to_string(),
        latest_version_number: version_label,
        latest_filename: latest.file_name.clone(),
        // CurseForge does publish a per-file timestamp; we now read it, so the
        // update pill can show a date on both sources.
        latest_published: latest.file_date.clone(),
    })
}

/// Apply an available update for a single project.
///
/// Re-runs detection server-side to learn the exact target version, then hands
/// that version to the install flow. Passing the version explicitly is what
/// guarantees the file installed is the one the check reported — the old code
/// re-resolved "newest compatible" from scratch, which could pick something
/// else and, worse, moved a dependency past the version its parent pinned.
///
/// Everything the old implementation did by hand — deleting the superseded file,
/// stripping the entry so the installer wouldn't dedupe, restoring `enabled` —
/// now happens inside the install flow's replace-in-place path.
pub async fn apply_update(
    instance_id: &str,
    project_id: &str,
) -> Result<InstallResult, String> {
    // Re-read the instance so we act on current state, not what the frontend
    // last saw.
    let meta_path = paths::instances_dir()
        .join(instance_id)
        .join("instance.json");
    let raw = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let instance: Instance = serde_json::from_str(&raw)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    let entry = instance
        .mods
        .iter()
        .find(|m| m.project_id == project_id)
        .ok_or_else(|| format!("Mod {} not in instance", project_id))?
        .clone();

    if entry.pinned {
        return Err(format!(
            "{} is held at its current version because another installed mod requires it. \
             Choose a version from its version list to change it anyway.",
            entry.title.as_deref().unwrap_or(project_id)
        ));
    }

    let category = entry.category.clone();
    let loader = instance.loader.loader_type.as_str();

    if entry.source == "curseforge" {
        let api_key = resolve_cf_key().await;
        let update = check_curseforge_entry(&instance, &entry, &api_key)
            .await
            .ok_or_else(|| {
                format!(
                    "No newer CurseForge file available for {}",
                    entry.title.as_deref().unwrap_or(project_id)
                )
            })?;
        cf_mod_install::install_cf_mod(
            instance_id,
            project_id,
            loader,
            &instance.game_version,
            &category,
            &api_key,
            Some(update.latest_version_id),
            // No window on this path; the error message still explains itself.
            None,
        )
        .await
    } else {
        let update = check_modrinth_entry(&instance, &entry).await.ok_or_else(|| {
            format!(
                "No newer version available for {}",
                entry.title.as_deref().unwrap_or(project_id)
            )
        })?;
        mod_install::install_mod(
            instance_id,
            project_id,
            loader,
            &instance.game_version,
            &category,
            Some(update.latest_version_id),
        )
        .await
    }
}
