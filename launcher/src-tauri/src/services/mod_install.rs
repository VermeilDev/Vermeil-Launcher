// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Mod install service. Algorithm:
//!
//! 1. Fetch the project's full version list (sorted newest first by Modrinth).
//! 2. Pick the version using `find_preferred_version`:
//!    - **Pass 1**: exact `game_version` AND exact `loader` (loader rule applies
//!      to mods only — resource packs / shaders / datapacks skip it).
//!    - **Pass 2**: same loader rule but accept any `game_version` whose base
//!      release matches (we strip pre-release suffixes so `26.1` and
//!      `26.1-pre7` are treated as compatible). This is a deliberate extension
//!      of Modrinth's strict string compare to handle the snapshot case.
//!    - **Pass 3** (mods only): accept versions whose loader includes
//!      `"datapack"` (a common Modrinth pattern when the same content type
//!      lives under multiple project_type values).
//!
//!    Every pass prefers a `release`-channel version and only falls back to
//!    beta/alpha when no stable version satisfies that pass. Without this, an
//!    alpha published after the newest stable always won, because the list is
//!    ordered by publish date.
//! 3. If still no match → record an `incompatible` issue and bail. Same as
//!    most launchers, dependencies are NOT installed for incompatible
//!    primaries.
//! 4. Walk dependencies recursively. Only `Required` deps install; `Optional`
//!    and `Embedded` are skipped. Quilt instances skip Fabric API (project
//!    `P7dR8mSH`) because Quilt provides it natively.
//! 5. Dependency satisfaction is checked by *version*, not merely presence.
//!    When the parent pins an exact `version_id` and a different version of
//!    that project is already installed, we record a `version_conflict` issue
//!    instead of silently accepting the mismatch — the old presence-only check
//!    is what produced "Iris needs Sodium 0.8.x but 0.9.x is installed" with no
//!    warning. Deps installed at an exact pin are marked `pinned` so the update
//!    checker won't later upgrade them out from under their parent.
//! 6. A `dependency_type: "incompatible"` dep that IS installed is surfaced as
//!    a `conflict` issue. Previously it was dropped, so a declared conflict was
//!    invisible.

use crate::models::instance::{Instance, ModEntry};
use crate::services::download::{DownloadTask, download_file};
use crate::services::modrinth::{self, ModrinthVersion};
use crate::util::paths;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;

/// Modrinth's project ID for "Fabric API". Quilt's loader provides Fabric API
/// natively, so installing it on a Quilt instance both wastes a slot and can
/// cause classpath conflicts. We skip it automatically for Quilt instances.
const FABRIC_API_PROJECT_ID: &str = "P7dR8mSH";

/// A compatibility / install issue surfaced to the frontend. Each entry powers
/// one card in `DependencyIssuesModal`.
#[derive(Debug, Clone, Serialize)]
pub struct DependencyIssue {
    pub parent_title: String,
    pub dep_title: String,
    pub dep_project_id: String,
    pub required_game_versions: Vec<String>,
    pub required_loaders: Vec<String>,
    pub instance_game_version: String,
    pub instance_loader: String,
    /// `"missing"` (no versions exist), `"incompatible"` (version exists but
    /// loader/MC version don't match), `"failed"` (download / resolution
    /// error during install).
    pub kind: String,
    pub reason: String,
}

pub struct InstallResult {
    pub mod_entry: ModEntry,
    pub deps_installed: Vec<String>,
    pub dep_titles: Vec<String>,
    pub issues: Vec<DependencyIssue>,
}

/// Public entry point. Resolves and installs the project plus its required
/// dependency tree.
///
/// `version_id` pins the root project to an exact version. `None` means
/// "resolve the newest compatible version", which is what the Browse card's
/// Install button does. `Some(..)` comes from the version picker (an explicit
/// user choice) and from `mod_updates::apply_update`, which passes the exact
/// version its check reported so detection and application can't disagree.
///
/// Note this does NOT mark the root entry `pinned` — that flag means "held at a
/// version a parent mod requires". A user picking an older version by hand is
/// free to be offered an update later; a dependency pin is not.
pub async fn install_mod(
    instance_id: &str,
    project_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    version_id: Option<String>,
) -> Result<InstallResult, String> {
    let mut visited_projects: HashSet<String> = HashSet::new();
    let mut visited_versions: HashSet<String> = HashSet::new();
    let mut deps_installed: Vec<String> = Vec::new();
    let mut dep_titles: Vec<String> = Vec::new();
    let mut issues: Vec<DependencyIssue> = Vec::new();

    let root = install_one(
        instance_id,
        project_id,
        loader,
        game_version,
        category,
        None,
        version_id,
        &mut visited_projects,
        &mut visited_versions,
        &mut deps_installed,
        &mut dep_titles,
        &mut issues,
        true,
    )
    .await?;

    Ok(InstallResult {
        mod_entry: root,
        deps_installed,
        dep_titles,
        issues,
    })
}

/// Resolve and install a single project. Recurses into required dependencies.
#[allow(clippy::too_many_arguments)]
async fn install_one(
    instance_id: &str,
    project_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    parent_title: Option<&str>,
    // Exact version to install, from one of two sources: a parent declaring a
    // required dependency with an exact `version_id` (e.g. Iris pins the precise
    // Sodium build it's ABI-compatible with), or an explicit user choice from the
    // version picker on a root install. `None` = resolve by compatibility.
    pinned_version_id: Option<String>,
    visited_projects: &mut HashSet<String>,
    visited_versions: &mut HashSet<String>,
    deps_installed: &mut Vec<String>,
    dep_titles: &mut Vec<String>,
    issues: &mut Vec<DependencyIssue>,
    is_root: bool,
) -> Result<ModEntry, String> {
    if !visited_projects.insert(project_id.to_string()) {
        return Err(format!("Cycle detected on project {}", project_id));
    }

    // Whether this install is a dependency held at an exact version its parent
    // requires. Captured before `pinned_version_id` is consumed below; it lands
    // in `ModEntry.pinned` so the update checker leaves the entry alone instead
    // of upgrading it past what the parent can accept.
    let is_dependency_pin = pinned_version_id.is_some() && !is_root;

    // Whether the caller asked for one specific version rather than "resolve the
    // newest compatible". An explicit request is allowed to move a version that
    // another mod pins; automatic resolution is not.
    let had_explicit_version = pinned_version_id.is_some();

    // Fetch the project's full version list once. Modrinth returns them sorted
    // newest first by `date_published`, which is the order their frontend
    // expects when running `findPreferredVersion`.
    let versions = modrinth::get_project_versions(project_id, "", "")
        .await
        .map_err(|e| format!("Fetch versions for {}: {}", project_id, e))?;

    // === Resolve which version to install ===
    let project_type = ProjectType::from_category(category);
    // Honor an exact dependency pin when present; otherwise resolve the newest
    // compatible version. Picking newest for a *pinned* dep is exactly what
    // caused "Iris requires Sodium 0.8.x but 0.9.x present" — the parent pins
    // the version it works with, and ignoring that pin breaks at load time.
    let chosen = if let Some(ref pin) = pinned_version_id {
        match versions.iter().find(|v| &v.id == pin) {
            Some(v) => Some(v),
            None => {
                tracing::warn!(
                    "Pinned dependency version {} not found for project {}; falling back to newest compatible",
                    pin,
                    project_id
                );
                find_preferred_version(&versions, project_type, loader, game_version)
            }
        }
    } else {
        find_preferred_version(&versions, project_type, loader, game_version)
    };

    let version = match chosen {
        Some(v) => v.clone(),
        None => {
            // No compatible version exists. Record a structured issue (the
            // frontend renders this as a card listing required loaders +
            // versions next to the instance's values), then refuse the
            // install. We do NOT pick a "closest" fallback because installing
            // a Forge mod into a Fabric instance is silent corruption.
            let dep_title = lookup_project_title(project_id)
                .await
                .unwrap_or_else(|| project_id.to_string());

            // Aggregate all loaders / game_versions across the project's
            // versions so the modal can show "supports: forge, neoforge —
            // 1.20.1, 1.21" etc.
            let mut all_loaders: Vec<String> = Vec::new();
            let mut all_game_versions: Vec<String> = Vec::new();
            for v in &versions {
                for l in &v.loaders {
                    if !all_loaders.contains(l) {
                        all_loaders.push(l.clone());
                    }
                }
                for g in &v.game_versions {
                    if !all_game_versions.contains(g) {
                        all_game_versions.push(g.clone());
                    }
                }
            }

            let kind = if versions.is_empty() { "missing" } else { "incompatible" };
            let reason = if versions.is_empty() {
                "No versions of this dependency exist on Modrinth.".to_string()
            } else {
                let mut bits = Vec::new();
                if project_type.checks_loader()
                    && !all_loaders.iter().any(|l| l == loader)
                {
                    bits.push(format!(
                        "supports {} (instance uses {})",
                        all_loaders.join(", "),
                        loader
                    ));
                }
                if !all_game_versions.iter().any(|g| compatible_game_version(g, game_version)) {
                    bits.push(format!(
                        "supports MC {} (instance is on {})",
                        truncate_list(&all_game_versions, 6),
                        game_version
                    ));
                }
                if bits.is_empty() {
                    "No version satisfies the instance's loader and MC version.".to_string()
                } else {
                    bits.join("; ")
                }
            };

            issues.push(DependencyIssue {
                parent_title: parent_title.unwrap_or("(unknown)").to_string(),
                dep_title,
                dep_project_id: project_id.to_string(),
                required_game_versions: all_game_versions,
                required_loaders: all_loaders,
                instance_game_version: game_version.to_string(),
                instance_loader: loader.to_string(),
                kind: kind.to_string(),
                reason,
            });
            return Err(format!("No compatible version for project {}", project_id));
        }
    };

    if !visited_versions.insert(version.id.clone()) {
        // Some other project already pulled in this version; nothing to do.
        return Err("Version already handled in this run".to_string());
    }

    // === Reconcile against what's already installed ===
    // Deliberately before the download: a redundant install then costs no
    // bandwidth, and a version another mod pins can be respected without first
    // fetching a file we'd only have to delete again.
    let instance_dir = paths::instances_dir().join(instance_id);
    let target_folder = match category {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    };
    let target_dir = instance_dir.join(".minecraft").join(target_folder);

    let meta_path = instance_dir.join("instance.json");
    let installed_before: Option<ModEntry> = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Instance>(&raw).ok())
        .and_then(|inst| inst.mods.into_iter().find(|m| m.project_id == project_id));

    if let Some(ref prev) = installed_before {
        let prev_file = target_dir.join(&prev.filename);
        // Already on exactly this version and file exists on disk — nothing to download or rewrite,
        // unless the user explicitly requested a reinstall on a root install.
        if prev.version_id == version.id && prev_file.exists() && (!is_root || !had_explicit_version) {
            return Ok(prev.clone());
        }

        // The installed version is held there because a parent mod requires it
        // exactly. Automatic resolution must not move it; only an explicit user
        // choice may.
        //
        // ponytail: we can't name the mod holding the pin without re-fetching
        // every installed mod's dependency list — one API call each on a
        // rate-limited API — so the message says "another installed mod".
        // Upgrade path: persist the requiring project id on ModEntry at the
        // moment the pin is applied, then name it here for free.
        if prev.pinned && !had_explicit_version {
            let dep_title = match prev.title.clone() {
                Some(t) => t,
                None => lookup_project_title(project_id)
                    .await
                    .unwrap_or_else(|| project_id.to_string()),
            };
            let held_at = prev
                .version_number
                .clone()
                .unwrap_or_else(|| prev.version_id.clone());
            issues.push(DependencyIssue {
                parent_title: parent_title.unwrap_or("(unknown)").to_string(),
                dep_title: dep_title.clone(),
                dep_project_id: project_id.to_string(),
                required_game_versions: Vec::new(),
                required_loaders: Vec::new(),
                instance_game_version: game_version.to_string(),
                instance_loader: loader.to_string(),
                kind: "version_conflict".to_string(),
                reason: format!(
                    "Kept {} at {} because another installed mod requires that exact \
                     version. Choose a version from this mod's version list to override.",
                    dep_title, held_at
                ),
            });
            return Ok(prev.clone());
        }
    }

    // === Pick a file ===
    let file = version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .ok_or("No files in version")?;

    // === Project metadata for icon/title ===
    let (title, icon_url, description, _project_type, author) = lookup_project_meta(project_id).await;

    // Best-effort cache the project icon to disk so the Installed-tab card
    // and any future render of this mod doesn't re-hit the CDN every time.
    // Cache is content-addressed by URL hash so dedups across mods that
    // share an icon (rare, but cheap to handle).
    let local_icon_path = match icon_url.as_deref() {
        Some(u) => crate::services::icon_cache::cache_remote_icon(u).await,
        None => None,
    };

    // === Download into the right folder for the category ===
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Create {}: {}", target_folder, e))?;

    let dest = target_dir.join(&file.filename);
    let task = DownloadTask {
        url: file.url.clone(),
        dest: dest.clone(),
        expected_sha1: file.hashes.sha1.clone(),
        expected_size: Some(file.size),
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    let mod_entry = ModEntry {
        id: version.id.clone(),
        source: "modrinth".to_string(),
        project_id: project_id.to_string(),
        version_id: version.id.clone(),
        filename: file.filename.clone(),
        version_number: Some(version.version_number.clone()),
        enabled: true,
        pinned: is_dependency_pin,
        title: title.clone(),
        icon_url,
        local_icon_path,
        description,
        category: category.to_string(),
        author,
        loaders: version.loaders.clone(),
        game_versions: version.game_versions.clone(),
    };

    // === Persist instance.json ===
    // Idempotent *with replacement*: an existing entry for this project is
    // updated in place, not skipped. The old skip-if-present behavior left the
    // freshly-downloaded jar on disk while instance.json still described the
    // previous version — two jars of the same project in `mods/` (which loaders
    // reject) and metadata pointing at the wrong one. Replacing here is also
    // what makes an explicit version choice work, and it means
    // `mod_updates::apply_update` no longer has to strip the entry first.
    let content = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let mut instance: Instance = serde_json::from_str(&content)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    let mut mod_entry = mod_entry;
    match instance.mods.iter().position(|m| m.project_id == project_id) {
        // Reaching here with an existing entry means the version genuinely
        // differs — the reconcile step above already returned early for an
        // identical version and for a pin we must not move.
        Some(pos) => {
            let previous = instance.mods[pos].clone();
            // Carry the user's enable/disable choice across the swap, honoring
            // the `.disabled` filename convention.
            if !previous.enabled {
                let active = target_dir.join(&mod_entry.filename);
                let disabled_name = format!("{}.disabled", mod_entry.filename);
                if active.exists() {
                    match fs::rename(&active, target_dir.join(&disabled_name)) {
                        Ok(()) => {
                            mod_entry.filename = disabled_name;
                            mod_entry.enabled = false;
                        }
                        Err(e) => tracing::warn!(
                            "Couldn't re-disable {} after version change: {}",
                            active.display(),
                            e
                        ),
                    }
                }
            }
            // Drop the superseded file so the folder never holds two versions of
            // the same project.
            if previous.filename != mod_entry.filename {
                let stale = target_dir.join(&previous.filename);
                if stale.exists() {
                    if let Err(e) = fs::remove_file(&stale) {
                        tracing::warn!(
                            "Couldn't remove superseded file {}: {}",
                            stale.display(),
                            e
                        );
                    }
                }
            }
            instance.mods[pos] = mod_entry.clone();
            let json = serde_json::to_string_pretty(&instance)
                .map_err(|e| format!("Serialize instance.json: {}", e))?;
            fs::write(&meta_path, json).map_err(|e| format!("Write instance.json: {}", e))?;
        }
        None => {
            instance.mods.push(mod_entry.clone());
            let json = serde_json::to_string_pretty(&instance)
                .map_err(|e| format!("Serialize instance.json: {}", e))?;
            fs::write(&meta_path, json).map_err(|e| format!("Write instance.json: {}", e))?;

            if !is_root {
                deps_installed.push(project_id.to_string());
                dep_titles.push(title.clone().unwrap_or_else(|| project_id.to_string()));
            }
        }
    }

    // === Walk dependencies ===
    for dep in &version.dependencies {
        // `optional` and `embedded` impose no requirement. `required` installs;
        // `incompatible` is checked against what's installed and reported.
        if dep.dependency_type != "required" && dep.dependency_type != "incompatible" {
            continue;
        }

        // Resolve a project_id for the dep. Modrinth deps usually carry
        // `project_id`; some carry only `version_id` (a pin), in which case we
        // fetch the version to learn its parent project.
        let dep_project_id = if let Some(ref pid) = dep.project_id {
            pid.clone()
        } else if let Some(ref vid) = dep.version_id {
            match fetch_version_meta(vid).await {
                Some((pid, _)) => pid,
                None => continue,
            }
        } else {
            continue;
        };

        let parent = title.clone().unwrap_or_else(|| project_id.to_string());

        // What, if anything, the instance already has for this dep.
        let dep_installed: Option<ModEntry> = serde_json::from_str::<Instance>(
            &fs::read_to_string(&meta_path).unwrap_or_default(),
        )
        .ok()
        .and_then(|inst| {
            inst.mods
                .into_iter()
                .find(|m| m.project_id == dep_project_id)
        });

        // A declared conflict: this version says it cannot run alongside the
        // named project. Previously dropped outright, so the clash stayed
        // invisible until the game failed to start.
        if dep.dependency_type == "incompatible" {
            if let Some(ref clash) = dep_installed {
                let dep_title = resolve_title(clash.title.clone(), &dep_project_id).await;
                issues.push(DependencyIssue {
                    parent_title: parent.clone(),
                    dep_title: dep_title.clone(),
                    dep_project_id: dep_project_id.clone(),
                    required_game_versions: Vec::new(),
                    required_loaders: Vec::new(),
                    instance_game_version: game_version.to_string(),
                    instance_loader: loader.to_string(),
                    kind: "conflict".to_string(),
                    reason: format!(
                        "{} declares it cannot run alongside {}, which is installed. \
                         Remove one of them.",
                        parent, dep_title
                    ),
                });
            }
            continue;
        }

        // Carry the dep's exact-version pin (if any) into the recursive install.
        // CurseForge has no equivalent: its required-dependency relations carry
        // only a project id, never a file pin, so the CF path can only ever
        // resolve "newest compatible" (see services/cf_mod_install.rs).
        let dep_pin = dep.version_id.clone();

        // Quilt provides Fabric API natively — installing it again would clash.
        if dep_project_id == FABRIC_API_PROJECT_ID && loader == "quilt" {
            continue;
        }

        if visited_projects.contains(&dep_project_id) {
            continue;
        }

        if let Some(ref present) = dep_installed {
            visited_projects.insert(dep_project_id.clone());

            // Presence is not satisfaction. When the parent names an exact
            // version and a different one is installed, that mismatch is the
            // "installed the wrong version" bug — the pin used to be discarded
            // right here with nothing reported.
            if let Some(ref pin) = dep_pin {
                if &present.version_id != pin {
                    let dep_title = resolve_title(present.title.clone(), &dep_project_id).await;
                    let required = fetch_version_meta(pin)
                        .await
                        .map(|(_, number)| number)
                        .unwrap_or_else(|| pin.clone());
                    let installed = present
                        .version_number
                        .clone()
                        .unwrap_or_else(|| present.version_id.clone());
                    issues.push(DependencyIssue {
                        parent_title: parent.clone(),
                        dep_title: dep_title.clone(),
                        dep_project_id: dep_project_id.clone(),
                        required_game_versions: Vec::new(),
                        required_loaders: Vec::new(),
                        instance_game_version: game_version.to_string(),
                        instance_loader: loader.to_string(),
                        kind: "version_conflict".to_string(),
                        reason: format!(
                            "{} requires {} {}, but {} is installed. Open {}'s version list \
                             and install {} to resolve it.",
                            parent, dep_title, required, installed, dep_title, required
                        ),
                    });
                }
            }
            continue;
        }

        // Determine the dep's actual project type before recursing. Modrinth's
        // `dependency` struct doesn't carry it, so we look it up. Datapack deps
        // belong in `datapacks/`, resource pack deps in `resourcepacks/`, etc.
        // Without this every dep — including datapacks — was being dropped
        // into `mods/`, which silently broke loaders that scan folders.
        let dep_category = lookup_project_type(&dep_project_id)
            .await
            .map(|t| match t.as_str() {
                "resourcepack" => "resourcepack".to_string(),
                "shader" => "shader".to_string(),
                "datapack" => "datapack".to_string(),
                _ => "mod".to_string(),
            })
            .unwrap_or_else(|| "mod".to_string());

        if let Err(e) = Box::pin(install_one(
            instance_id,
            &dep_project_id,
            loader,
            game_version,
            &dep_category,
            Some(&parent),
            dep_pin,
            visited_projects,
            visited_versions,
            deps_installed,
            dep_titles,
            issues,
            false,
        ))
        .await
        {
            tracing::warn!(
                "Skipping dependency {} of {}: {}",
                dep_project_id,
                project_id,
                e
            );
            // If `install_one` returned without recording its own issue
            // (uncommon — happens on transient network errors), surface a
            // generic "failed" entry so the user still sees it.
            let already_recorded = issues.iter().any(|i| i.dep_project_id == dep_project_id);
            if !already_recorded {
                let dep_title = lookup_project_title(&dep_project_id)
                    .await
                    .unwrap_or_else(|| dep_project_id.clone());
                issues.push(DependencyIssue {
                    parent_title: parent.clone(),
                    dep_title,
                    dep_project_id: dep_project_id.clone(),
                    required_game_versions: Vec::new(),
                    required_loaders: Vec::new(),
                    instance_game_version: game_version.to_string(),
                    instance_loader: loader.to_string(),
                    kind: "failed".to_string(),
                    reason: e,
                });
            }
        }
    }

    Ok(mod_entry)
}

// ============================================================================
// Compatibility algorithm — picks the best version from the project's
// version list given the instance's loader and game version.
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectType {
    Mod,
    Modpack,
    ResourcePack,
    Shader,
    DataPack,
}

impl ProjectType {
    pub(crate) fn from_category(category: &str) -> Self {
        match category {
            "resourcepack" => ProjectType::ResourcePack,
            "shader" => ProjectType::Shader,
            "datapack" => ProjectType::DataPack,
            "modpack" => ProjectType::Modpack,
            _ => ProjectType::Mod,
        }
    }

    /// Whether the loader filter applies. Modrinth only enforces the loader
    /// check on mods; modpacks and asset packs are loader-agnostic / standalone.
    fn checks_loader(&self) -> bool {
        matches!(self, ProjectType::Mod)
    }
}

/// Whether this version can run on the given instance.
///
/// Accepts what the picker's passes accept: base-release game-version matching,
/// the loader rule for mods only, and the datapack-as-mod allowance. Exists so
/// the version picker can label entries without the frontend re-implementing
/// compatibility — one definition, used for both selecting and labeling.
///
/// An empty `game_version` means "any", matching the optional version box on
/// resource packs and shaders.
pub(crate) fn is_version_compatible(
    v: &ModrinthVersion,
    project_type: ProjectType,
    loader: &str,
    game_version: &str,
) -> bool {
    if !game_version.is_empty()
        && !v
            .game_versions
            .iter()
            .any(|g| compatible_game_version(g, game_version))
    {
        return false;
    }
    if !project_type.checks_loader() || loader.is_empty() {
        return true;
    }
    v.loaders.iter().any(|l| l == loader || l == "datapack")
}

/// Is this version on the stable release channel? Modrinth's `version_type` is
/// `"release"` / `"beta"` / `"alpha"`. An absent value is treated as stable so
/// a project that somehow omits the field stays installable.
fn is_stable_channel(v: &ModrinthVersion) -> bool {
    match v.version_type.as_deref() {
        Some("beta") | Some("alpha") => false,
        _ => true,
    }
}

/// First version satisfying `matches`, preferring the stable release channel.
///
/// The list is ordered newest-first by publish date, so a plain `find` hands
/// back an alpha whenever one was published after the newest stable. Two passes
/// over an already-fetched slice is cheap, and it means "Install" doesn't
/// silently hand someone a pre-release build.
fn pick_preferring_stable<F>(
    versions: &[ModrinthVersion],
    matches: F,
) -> Option<&ModrinthVersion>
where
    F: Fn(&ModrinthVersion) -> bool,
{
    versions
        .iter()
        .find(|v| is_stable_channel(v) && matches(v))
        .or_else(|| versions.iter().find(|v| matches(v)))
}

/// Given a project's full version list (newest first), pick the best match.
/// Used by both the install flow and the update checker — keeping the picker
/// in one place ensures updates only surface versions we'd actually install.
pub(crate) fn find_preferred_version<'a>(
    versions: &'a [ModrinthVersion],
    project_type: ProjectType,
    loader: &str,
    game_version: &str,
) -> Option<&'a ModrinthVersion> {
    let loader_ok = |v: &ModrinthVersion| {
        if !project_type.checks_loader() || loader.is_empty() {
            return true;
        }
        let target = loader.to_lowercase();
        if target == "quilt" {
            v.loaders.iter().any(|l| {
                let lower = l.to_lowercase();
                lower == "quilt" || lower == "fabric"
            })
        } else {
            v.loaders.iter().any(|l| l.eq_ignore_ascii_case(&target))
        }
    };

    if game_version.is_empty() {
        return pick_preferring_stable(versions, |v| loader_ok(v));
    }

    // Pass 1 — strict: exact game_version + exact loader.
    let strict = pick_preferring_stable(versions, |v| {
        v.game_versions.iter().any(|g| g == game_version) && loader_ok(v)
    });
    if strict.is_some() {
        return strict;
    }

    // Pass 2 — lenient game version: accept versions whose game_versions list
    // contains a string with the same base release as the instance's MC
    // version (e.g., `26.1-pre7` matches `26.1`). Loader rule still strict.
    let lenient = pick_preferring_stable(versions, |v| {
        v.game_versions
            .iter()
            .any(|g| compatible_game_version(g, game_version))
            && loader_ok(v)
    });
    if lenient.is_some() {
        return lenient;
    }

    // Pass 3 — datapack-as-mod (Modrinth's `isVersionCompatible` accepts a mod
    // that ships as a datapack on any loader instance).
    if project_type == ProjectType::Mod {
        let datapack = pick_preferring_stable(versions, |v| {
            v.game_versions
                .iter()
                .any(|g| compatible_game_version(g, game_version))
                && v.loaders.iter().any(|l| l == "datapack")
        });
        if datapack.is_some() {
            return datapack;
        }
    }

    None
}

/// Are these two MC version strings compatible? Strict equality, or one is the
/// pre-release / RC / snapshot variant of the other (e.g., `26.1` ↔
/// `26.1-pre7`, `1.20.1` ↔ `1.20.1-rc1`).
///
/// We strip the suffix from both sides and compare the bases. This is more
/// lenient than Modrinth's `Array.includes`, which is intentional — a mod
/// declaring support for `1.21-pre7` should still install on `1.21` because
/// the pre-release was the precursor to that exact final.
pub(crate) fn compatible_game_version(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    base_release(a) == base_release(b)
}

/// Strip pre-release / snapshot suffixes from an MC version string.
/// `"26.1-pre7"` → `"26.1"`, `"1.20.1-rc1"` → `"1.20.1"`. Snapshots like
/// `"24w14a"` have no base release and return as-is.
fn base_release(v: &str) -> &str {
    for sep in ["-pre", "-rc", "-experimental", "-snapshot", "-beta", "-alpha"] {
        if let Some(idx) = v.find(sep) {
            return &v[..idx];
        }
    }
    v
}

fn truncate_list(list: &[String], max: usize) -> String {
    if list.len() <= max {
        list.join(", ")
    } else {
        format!("{}, +{} more", list[..max].join(", "), list.len() - max)
    }
}

// ============================================================================
// Modrinth metadata helpers
// ============================================================================

async fn lookup_project_title(project_id: &str) -> Option<String> {
    lookup_project_meta(project_id).await.0
}

/// Returns `(title, icon_url, description, project_type)`. Each field falls
/// back to None on any error so install can still proceed with a barebones
/// ModEntry.
///
/// `project_type` is one of Modrinth's category strings (`"mod"`,
/// `"resourcepack"`, `"shader"`, `"datapack"`). We use it to route a
/// dependency's download to the right folder — without it, every dep
/// (including datapack deps of a datapack) was being dropped into `mods/`.
///
/// `author` is the username of the project owner. Modrinth's project
/// endpoint only returns a team ID, so we make one additional call to
/// `/v2/team/{id}/members` to find the Owner's username. Best-effort —
/// returns `None` on any HTTP/parse failure.
async fn lookup_project_meta(
    project_id: &str,
) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
    let url = format!("https://api.modrinth.com/v2/project/{}", project_id);
    let resp = match crate::util::http::HTTP.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (None, None, None, None, None),
    };
    if !resp.status().is_success() {
        return (None, None, None, None, None);
    }
    #[derive(serde::Deserialize)]
    struct ProjectInfo {
        title: Option<String>,
        icon_url: Option<String>,
        description: Option<String>,
        project_type: Option<String>,
        team: Option<String>,
    }
    let info = match resp.json::<ProjectInfo>().await {
        Ok(p) => p,
        Err(_) => return (None, None, None, None, None),
    };

    // Resolve team → owner username. Skipped if no team or if the request fails;
    // we don't surface the error because author is optional.
    let author = match info.team.as_deref() {
        Some(team_id) if !team_id.is_empty() => fetch_team_owner(team_id).await,
        _ => None,
    };

    (info.title, info.icon_url, info.description, info.project_type, author)
}

/// Resolve the `Owner`-role member of a Modrinth team. Returns the owner's
/// username, or None if the team has no members or the request fails.
async fn fetch_team_owner(team_id: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Member {
        role: Option<String>,
        user: Option<MemberUser>,
    }
    #[derive(serde::Deserialize)]
    struct MemberUser {
        username: Option<String>,
    }
    let url = format!("https://api.modrinth.com/v2/team/{}/members", team_id);
    let resp = crate::util::http::HTTP.get(&url).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let members: Vec<Member> = resp.json().await.ok()?;
    // Prefer the Owner; fall back to first member.
    members.iter()
        .find(|m| m.role.as_deref() == Some("Owner"))
        .or_else(|| members.first())
        .and_then(|m| m.user.as_ref()?.username.clone())
}

/// Resolve a dependency's project type. Modrinth's `dependency` struct
/// doesn't carry the dep's project_type, so we have to ask the API.
/// Used during the dep walk to pick the right install folder.
async fn lookup_project_type(project_id: &str) -> Option<String> {
    lookup_project_meta(project_id).await.3
}

/// Fetch a version by id and return `(project_id, version_number)`.
///
/// Two callers need one of the halves each: the dep walk resolves the parent
/// project of a `version_id`-only dependency, and the version-conflict message
/// needs the human-readable number of the pinned version. Both come from the
/// same response, so this is one function rather than two calls.
async fn fetch_version_meta(version_id: &str) -> Option<(String, String)> {
    let url = format!("https://api.modrinth.com/v2/version/{}", version_id);
    let resp = crate::util::http::HTTP.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let project_id = json.get("project_id")?.as_str()?.to_string();
    // A version always has a number, but fall back to the id rather than
    // failing the whole lookup if the field is somehow absent.
    let number = json
        .get("version_number")
        .and_then(|v| v.as_str())
        .unwrap_or(version_id)
        .to_string();
    Some((project_id, number))
}

/// Prefer a title we already have cached on the installed entry; only hit the
/// API when there isn't one. Keeps the conflict paths from costing a request in
/// the common case.
async fn resolve_title(cached: Option<String>, project_id: &str) -> String {
    match cached {
        Some(t) => t,
        None => lookup_project_title(project_id)
            .await
            .unwrap_or_else(|| project_id.to_string()),
    }
}

// ============================================================================
// Removal / toggle (unchanged from previous implementation)
// ============================================================================

pub async fn remove_mod(instance_id: &str, entry_id: &str) -> Result<(), String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Match on the unique per-entry `id` (see toggle_mod for why project_id
    // is unreliable for modpack-installed mods).
    if let Some(pos) = instance.mods.iter().position(|m| m.id == entry_id) {
        let mod_entry = instance.mods.remove(pos);
        let folder = match mod_entry.category.as_str() {
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            "datapack" => "datapacks",
            _ => "mods",
        };
        let file_path = instance_dir.join(".minecraft").join(folder).join(&mod_entry.filename);
        // .disabled files end with .jar.disabled — also try that.
        if file_path.exists() {
            let _ = fs::remove_file(&file_path);
        }

        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub async fn remove_mods(instance_id: &str, entry_ids: &[String]) -> Result<usize, String> {
    if entry_ids.is_empty() {
        return Ok(0);
    }
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let id_set: std::collections::HashSet<&str> = entry_ids.iter().map(|s| s.as_str()).collect();
    let mut removed_count = 0;
    instance.mods.retain(|m| {
        if id_set.contains(m.id.as_str()) {
            let folder = match m.category.as_str() {
                "resourcepack" => "resourcepacks",
                "shader" => "shaderpacks",
                "datapack" => "datapacks",
                _ => "mods",
            };
            let file_path = instance_dir.join(".minecraft").join(folder).join(&m.filename);
            if file_path.exists() {
                let _ = fs::remove_file(&file_path);
            }
            removed_count += 1;
            false
        } else {
            true
        }
    });

    if removed_count > 0 {
        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    }

    Ok(removed_count)
}

pub async fn remove_all_content(instance_id: &str, category: &str) -> Result<usize, String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let initial = instance.mods.len();
    let (kept, removed): (Vec<_>, Vec<_>) = instance.mods.into_iter().partition(|m| {
        if category == "all" {
            return false;
        }
        m.category != category
    });

    for mod_entry in &removed {
        let folder = match mod_entry.category.as_str() {
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            "datapack" => "datapacks",
            _ => "mods",
        };
        let file_path = instance_dir.join(".minecraft").join(folder).join(&mod_entry.filename);
        if let Err(e) = fs::remove_file(&file_path) {
            tracing::warn!(
                "Failed to remove {} during bulk delete: {}",
                file_path.display(),
                e
            );
        }
    }

    instance.mods = kept;
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(initial - instance.mods.len())
}

pub async fn toggle_mod(instance_id: &str, entry_id: &str) -> Result<bool, String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Match on the unique per-entry `id`, NOT `project_id`. Modpack-installed
    // mods all share an empty `project_id`, so matching on that would toggle
    // the wrong mod (whichever the iterator finds first).
    let mod_idx = instance
        .mods
        .iter()
        .position(|m| m.id == entry_id)
        .ok_or("Mod not found")?;

    let folder = match instance.mods[mod_idx].category.as_str() {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    };
    let target_dir = instance_dir.join(".minecraft").join(folder);
    let current_path = target_dir.join(&instance.mods[mod_idx].filename);
    let new_enabled;

    if instance.mods[mod_idx].enabled {
        let new_name = format!("{}.disabled", instance.mods[mod_idx].filename);
        let new_path = target_dir.join(&new_name);
        if new_path.exists() {
            let _ = fs::remove_file(&new_path);
        }
        fs::rename(&current_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
        instance.mods[mod_idx].filename = new_name;
        instance.mods[mod_idx].enabled = false;
        new_enabled = false;
    } else {
        // Enforce compatibility before enabling a mod
        if instance.mods[mod_idx].category == "mod" {
            let mut loaders = instance.mods[mod_idx].loaders.clone();
            if loaders.is_empty() {
                loaders = crate::services::loader_scan::detect_jar_loaders(&current_path);
                instance.mods[mod_idx].loaders = loaders.clone();
            }
            if !crate::services::loader_scan::is_mod_compatible_with_loader(
                &instance.loader.loader_type,
                &loaders,
            ) {
                let loader_desc = if loaders.is_empty() {
                    "another loader".to_string()
                } else {
                    loaders.join(", ")
                };
                return Err(format!(
                    "Cannot enable: built for {}, incompatible with {:?} loader",
                    loader_desc,
                    instance.loader.loader_type
                ));
            }
        }

        let new_name = instance.mods[mod_idx].filename.trim_end_matches(".disabled").to_string();
        let new_path = target_dir.join(&new_name);
        if new_path.exists() {
            let _ = fs::remove_file(&new_path);
        }
        fs::rename(&current_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
        instance.mods[mod_idx].filename = new_name;
        instance.mods[mod_idx].enabled = true;
        new_enabled = true;
    }

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(new_enabled)
}

/// Reconcile manually-added mod jars under the instance's `mods/` folder into
/// the tracked mod list, so files the user dropped in by hand appear in the
/// Installed tab (and can be toggled / removed there like any other mod).
///
/// Launcher-installed entries (`source != "manual"`) are never touched. The
/// companion mod's managed jar (`vermeil-<ver>+<mc>.jar`) is ignored since it's
/// launcher-managed and intentionally invisible. Manual entries whose file has
/// since been deleted by hand are pruned. `instance.json` is rewritten only
/// when something actually changed.
///
/// Filenames are compared as they sit on disk — a disabled mod is stored as
/// `*.jar.disabled`, matching how [`toggle_mod`] records the name — so a
/// toggled manual mod isn't re-added as a duplicate.
pub async fn sync_manual_mods(instance_id: &str) -> Result<(), String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");
    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mods_dir = instance_dir.join(".minecraft").join("mods");

    // Actual on-disk mod filenames (".jar" or the disabled ".jar.disabled").
    let mut disk: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&mods_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.ends_with(".jar") || name.ends_with(".jar.disabled")) {
                continue;
            }
            // Skip the companion mod's managed jar — naming `vermeil-<ver>+<mc>.jar`.
            let base = name.trim_end_matches(".disabled");
            if base.starts_with("vermeil-") && base.contains('+') && base.ends_with(".jar") {
                continue;
            }
            disk.push(name);
        }
    }

    let mut changed = false;

    // Add disk files not already tracked (by actual filename) as manual mods.
    // Managed companion mod jars are excluded here as they are managed via the
    // dedicated companion toggle card.
    let tracked: HashSet<String> = instance
        .mods
        .iter()
        .filter(|m| m.category == "mod")
        .map(|m| m.filename.clone())
        .collect();
    for name in &disk {
        if tracked.contains(name) || crate::services::companion_mod::is_managed(name) {
            continue;
        }
        let base = name.trim_end_matches(".disabled");
        let title = base.strip_suffix(".jar").unwrap_or(base).to_string();
        let jar_path = mods_dir.join(name);
        let jar_loaders = crate::services::loader_scan::detect_jar_loaders(&jar_path);
        let is_compatible = crate::services::loader_scan::is_mod_compatible_with_loader(
            &instance.loader.loader_type,
            &jar_loaders,
        );
        let mut final_filename = name.clone();
        if !is_compatible && !name.ends_with(".disabled") {
            let disabled_name = format!("{}.disabled", name);
            if fs::rename(&jar_path, mods_dir.join(&disabled_name)).is_ok() {
                final_filename = disabled_name;
            }
        }
        let enabled = !final_filename.ends_with(".disabled") && is_compatible;

        instance.mods.push(ModEntry {
            // Stable id independent of enabled/disabled state so toggling
            // (which rewrites `filename` to add/strip `.disabled`) keeps working.
            id: format!("manual:{}", base),
            source: "manual".to_string(),
            project_id: String::new(),
            version_id: String::new(),
            filename: final_filename,
            version_number: None,
            enabled,
            pinned: false,
            title: Some(title),
            icon_url: None,
            local_icon_path: None,
            description: None,
            category: "mod".to_string(),
            author: None,
            loaders: jar_loaders,
            game_versions: Vec::new(),
        });
        changed = true;
    }

    // Prune manual entries whose file the user has since deleted by hand,
    // as well as any managed companion mod jars that were inadvertently tracked.
    let on_disk: HashSet<&String> = disk.iter().collect();
    let before = instance.mods.len();
    instance.mods.retain(|m| {
        if crate::services::companion_mod::is_managed(&m.filename) {
            return false;
        }
        !(m.source == "manual" && m.category == "mod" && !on_disk.contains(&m.filename))
    });
    if instance.mods.len() != before {
        changed = true;
    }

    if changed {
        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::modrinth::{ModrinthFile, ModrinthHashes, ModrinthVersion};

    /// Minimal version fixture. `channel` is Modrinth's `version_type`.
    fn version(
        id: &str,
        channel: &str,
        game_versions: &[&str],
        loaders: &[&str],
    ) -> ModrinthVersion {
        ModrinthVersion {
            id: id.to_string(),
            project_id: "proj".to_string(),
            name: id.to_string(),
            version_number: id.to_string(),
            game_versions: game_versions.iter().map(|s| s.to_string()).collect(),
            loaders: loaders.iter().map(|s| s.to_string()).collect(),
            files: vec![ModrinthFile {
                url: "https://example.invalid/f.jar".to_string(),
                filename: "f.jar".to_string(),
                hashes: ModrinthHashes { sha1: None, sha512: None },
                size: 1,
                primary: true,
            }],
            dependencies: Vec::new(),
            date_published: None,
            version_type: Some(channel.to_string()),
        }
    }

    /// The regression this guards: the list is newest-first, so a plain `find`
    /// hands back a prerelease whenever one was published after the newest
    /// stable. Install must not silently deliver an alpha.
    #[test]
    fn stable_wins_over_a_newer_prerelease() {
        let versions = vec![
            version("alpha-new", "alpha", &["1.21.1"], &["fabric"]),
            version("beta-mid", "beta", &["1.21.1"], &["fabric"]),
            version("release-old", "release", &["1.21.1"], &["fabric"]),
        ];
        let picked =
            find_preferred_version(&versions, ProjectType::Mod, "fabric", "1.21.1").unwrap();
        assert_eq!(picked.id, "release-old");
    }

    /// ...but a prerelease is better than nothing when no stable build supports
    /// the instance at all.
    #[test]
    fn prerelease_used_when_no_stable_is_compatible() {
        let versions = vec![
            version("beta-compatible", "beta", &["1.21.1"], &["fabric"]),
            version("release-other-mc", "release", &["1.20.1"], &["fabric"]),
        ];
        let picked =
            find_preferred_version(&versions, ProjectType::Mod, "fabric", "1.21.1").unwrap();
        assert_eq!(picked.id, "beta-compatible");
    }

    /// A Forge jar must never be chosen for a Fabric instance. This is the
    /// "silent corruption" case the picker exists to prevent.
    #[test]
    fn wrong_loader_is_never_chosen_for_a_mod() {
        let versions = vec![version("forge-only", "release", &["1.21.1"], &["forge"])];
        assert!(find_preferred_version(&versions, ProjectType::Mod, "fabric", "1.21.1").is_none());
    }

    /// Resource packs are loader-agnostic, so the loader rule must not apply or
    /// every pack would be rejected.
    #[test]
    fn loader_rule_is_skipped_for_loader_agnostic_content() {
        let versions = vec![version("pack", "release", &["1.21.1"], &["minecraft"])];
        let picked =
            find_preferred_version(&versions, ProjectType::ResourcePack, "fabric", "1.21.1")
                .unwrap();
        assert_eq!(picked.id, "pack");
    }

    /// A mod declaring support for `1.21-pre7` still installs on `1.21`; the
    /// prerelease was the precursor to that exact final.
    #[test]
    fn base_release_matching_accepts_prerelease_game_versions() {
        let versions = vec![version("v", "release", &["1.21-pre7"], &["fabric"])];
        assert!(find_preferred_version(&versions, ProjectType::Mod, "fabric", "1.21").is_some());
        // Different base release must still be rejected.
        assert!(find_preferred_version(&versions, ProjectType::Mod, "fabric", "1.20").is_none());
    }

    /// A missing `version_type` must not make a version unselectable.
    #[test]
    fn absent_channel_is_treated_as_stable() {
        let mut v = version("v", "release", &["1.21.1"], &["fabric"]);
        v.version_type = None;
        assert!(is_stable_channel(&v));
    }
}
