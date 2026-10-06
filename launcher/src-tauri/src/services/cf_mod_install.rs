// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! CurseForge mod install service.
//!
//! Mirrors `services::mod_install` (Modrinth) so both sources behave the same:
//! one recursive resolver walks the project and its required dependencies,
//! returning the shared `InstallResult` the frontend already renders.
//!
//! Where the two sources genuinely differ:
//!
//!   - **No file pin on dependencies.** A CurseForge required-dependency
//!     relation carries only a `modId`, never a file id, so a parent cannot say
//!     "I need exactly build 0.5.8". The Modrinth path honors such a pin; here
//!     the best available answer is "newest compatible", and a conflict can only
//!     be detected when the installed copy is pinned by something else.
//!   - **No loader field on a file.** Loader names are mixed into the same
//!     `gameVersions` array as Minecraft versions, so validation relies on
//!     `curseforge::classify_game_versions` having split them apart.
//!   - **No version numbers.** File identity is a monotonic numeric id, so
//!     "newest" is the highest id rather than the latest publish date.
//!
//! Selection never trusts the API's ordering. The files endpoint applies
//! `gameVersion` and `modLoaderType` server-side, but that filter silently does
//! nothing for a loader we can't map, so `find_preferred_file` re-checks every
//! candidate locally before committing to a download.

use crate::models::instance::{Instance, ModEntry};
use crate::services::curseforge::{self, CfFileInfo, ProjectMeta};
use crate::services::download::{DownloadTask, download_file};
use crate::services::icon_cache;
use crate::services::mod_install::{DependencyIssue, InstallResult, compatible_game_version};
use crate::util::paths;
use std::collections::{HashMap, HashSet};
use std::fs;

/// CurseForge `classId` values for the content types the launcher installs.
/// Mods (class 6) aren't listed because they're the fallback.
const CLASS_RESOURCE_PACKS: u32 = 12;
const CLASS_SHADERS: u32 = 6552;
const CLASS_DATA_PACKS: u32 = 6945;

/// Pick the best file for an instance, validating locally rather than trusting
/// the API's ordering or its server-side filter.
///
/// Prefers the stable release channel and, within a channel, the highest file id
/// (CurseForge ids are globally monotonic, so highest = newest). The update
/// checker uses this same function, which is what keeps "an update is available"
/// and "this is the file we'd install" from disagreeing.
///
/// A file that declares no Minecraft versions or no loaders is treated as
/// unconstrained on that axis instead of rejected: loader-agnostic content
/// (resource packs, shaders) legitimately tags neither, and older uploads
/// predate loader tagging entirely.
pub fn find_preferred_file<'a>(
    files: &'a [CfFileInfo],
    game_version: &str,
    loader: &str,
) -> Option<&'a CfFileInfo> {
    files
        .iter()
        .filter(|f| f.release_type == 1 && is_file_compatible(f, game_version, loader))
        .max_by_key(|f| f.file_id)
        .or_else(|| {
            files
                .iter()
                .filter(|f| is_file_compatible(f, game_version, loader))
                .max_by_key(|f| f.file_id)
        })
}

/// Whether this file can be installed on the given instance.
///
/// Shared by selection and by the version picker's per-entry labelling, so both
/// answer the compatibility question the same way. A file declaring no Minecraft
/// versions or no loaders is unconstrained on that axis rather than rejected; an
/// empty `game_version` or `loader` argument means "don't check that axis".
pub fn is_file_compatible(f: &CfFileInfo, game_version: &str, loader: &str) -> bool {
    if !f.is_available {
        return false;
    }
    if !game_version.is_empty()
        && !f.game_versions.is_empty()
        && !f
            .game_versions
            .iter()
            .any(|g| compatible_game_version(g, game_version))
    {
        return false;
    }
    if !loader.is_empty() && !f.loaders.is_empty() {
        if f.loaders.iter().any(|l| l.eq_ignore_ascii_case("datapack")) {
            return true;
        }
        let target = loader.to_lowercase();
        let matches = if target == "quilt" {
            f.loaders.iter().any(|l| {
                let lower = l.to_lowercase();
                lower == "quilt" || lower == "fabric"
            })
        } else {
            f.loaders.iter().any(|l| l.eq_ignore_ascii_case(&target))
        };
        if !matches {
            return false;
        }
    }
    true
}

/// CurseForge doesn't tag loader-agnostic content with a loader, so passing a
/// `modLoaderType` filter for those categories returns nothing.
///
/// Shared with the update checker deliberately: it was a byte-identical copy
/// there, and the two drifting apart would silently break the update pin round
/// trip — detection would filter one way and the install another.
pub fn effective_loader<'a>(category: &str, loader: &'a str) -> &'a str {
    match category {
        "resourcepack" | "shader" | "datapack" => "",
        _ => loader,
    }
}

/// Folder a category's files belong in.
fn target_folder(category: &str) -> &'static str {
    match category {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    }
}

/// Install a CurseForge mod into an instance, plus its required dependency tree.
///
/// `file_id` pins an exact file; `None` resolves the newest compatible one,
/// which is what the Browse card's Install button does.
/// `window` is only used to raise the manual-download dialog when CurseForge
/// won't serve a file. `None` for headless callers (e.g. an update check), which
/// still get the error — they just can't show the prompt.
pub async fn install_cf_mod(
    instance_id: &str,
    mod_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    api_key: &str,
    file_id: Option<String>,
    window: Option<&tauri::WebviewWindow>,
) -> Result<InstallResult, String> {
    let mut visited_projects: HashSet<String> = HashSet::new();
    let mut deps_installed: Vec<String> = Vec::new();
    let mut dep_titles: Vec<String> = Vec::new();
    let mut issues: Vec<DependencyIssue> = Vec::new();
    let mut meta_cache: HashMap<String, ProjectMeta> = HashMap::new();

    // Cache currently-installed project IDs so we don't re-read instance.json from disk
    // on every dependency and conflict check.
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");
    let mut installed_project_ids: HashSet<String> = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Instance>(&raw).ok())
        .map(|inst| inst.mods.into_iter().map(|m| m.project_id).collect())
        .unwrap_or_default();

    let root = install_cf_one(
        instance_id,
        mod_id,
        loader,
        game_version,
        category,
        api_key,
        None,
        file_id,
        &mut visited_projects,
        &mut deps_installed,
        &mut dep_titles,
        &mut issues,
        true,
        window,
        &mut meta_cache,
        &mut installed_project_ids,
    )
    .await?;

    Ok(InstallResult {
        mod_entry: root,
        deps_installed,
        dep_titles,
        issues,
    })
}

async fn get_or_fetch_meta<'a>(
    api_key: &str,
    mod_id: &str,
    meta_cache: &'a mut HashMap<String, ProjectMeta>,
) -> &'a ProjectMeta {
    if !meta_cache.contains_key(mod_id) {
        let meta = curseforge::fetch_project_meta(api_key, mod_id).await;
        meta_cache.insert(mod_id.to_string(), meta);
    }
    meta_cache.get(mod_id).unwrap()
}

/// Resolve and install one CurseForge project. Recurses into required
/// dependencies, guarded by `visited_projects` against cycles.
#[allow(clippy::too_many_arguments)]
async fn install_cf_one(
    instance_id: &str,
    mod_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    api_key: &str,
    parent_title: Option<&str>,
    // Exact file to install: an explicit user choice on a root install. Never
    // set for a dependency — CurseForge relations carry no file id.
    pinned_file_id: Option<String>,
    visited_projects: &mut HashSet<String>,
    deps_installed: &mut Vec<String>,
    dep_titles: &mut Vec<String>,
    issues: &mut Vec<DependencyIssue>,
    is_root: bool,
    window: Option<&tauri::WebviewWindow>,
    meta_cache: &mut HashMap<String, ProjectMeta>,
    installed_project_ids: &mut HashSet<String>,
) -> Result<ModEntry, String> {
    if !visited_projects.insert(mod_id.to_string()) {
        return Err(format!("Cycle detected on CurseForge project {}", mod_id));
    }

    let had_explicit_file = pinned_file_id.is_some();
    let loader_filter = effective_loader(category, loader);

    // === Resolve which file to install ===
    let mut listed: Vec<CfFileInfo> = Vec::new();
    let chosen: Option<CfFileInfo> = match pinned_file_id.as_deref() {
        Some(pin) => match curseforge::get_file(api_key, mod_id, pin).await {
            Ok(f) => Some(f),
            Err(e) => {
                tracing::warn!(
                    "Pinned CurseForge file {} for project {} couldn't be fetched ({}); \
                     resolving newest compatible instead",
                    pin,
                    mod_id,
                    e
                );
                listed =
                    curseforge::get_project_files(api_key, mod_id, game_version, loader_filter)
                        .await?;
                let mut best = find_preferred_file(&listed, game_version, loader_filter).cloned();
                if best.is_none() && loader_filter == "quilt" {
                    if let Ok(fabric_files) =
                        curseforge::get_project_files(api_key, mod_id, game_version, "fabric").await
                    {
                        if let Some(f) = find_preferred_file(&fabric_files, game_version, loader_filter) {
                            best = Some(f.clone());
                        }
                        listed.extend(fabric_files);
                    }
                }
                best
            }
        },
        None => {
            listed =
                curseforge::get_project_files(api_key, mod_id, game_version, loader_filter).await?;
            let mut best = find_preferred_file(&listed, game_version, loader_filter).cloned();
            if best.is_none() && loader_filter == "quilt" {
                if let Ok(fabric_files) =
                    curseforge::get_project_files(api_key, mod_id, game_version, "fabric").await
                {
                    if let Some(f) = find_preferred_file(&fabric_files, game_version, loader_filter) {
                        best = Some(f.clone());
                    }
                    listed.extend(fabric_files);
                }
            }
            best
        }
    };

    let file = match chosen {
        Some(f) => f,
        None => {
            let meta = get_or_fetch_meta(api_key, mod_id, meta_cache).await;
            let dep_title = meta.name.clone().unwrap_or_else(|| mod_id.to_string());
            let mut all_loaders: Vec<String> = Vec::new();
            let mut all_versions: Vec<String> = Vec::new();
            for f in &listed {
                for l in &f.loaders {
                    if !all_loaders.contains(l) {
                        all_loaders.push(l.clone());
                    }
                }
                for g in &f.game_versions {
                    if !all_versions.contains(g) {
                        all_versions.push(g.clone());
                    }
                }
            }
            let kind = if listed.is_empty() { "missing" } else { "incompatible" };
            let reason = if listed.is_empty() {
                format!(
                    "CurseForge lists no files for this project on MC {}.",
                    game_version
                )
            } else {
                format!(
                    "No available file matches {} on MC {}.",
                    if loader_filter.is_empty() { "this instance" } else { loader_filter },
                    game_version
                )
            };
            issues.push(DependencyIssue {
                parent_title: parent_title.unwrap_or("(unknown)").to_string(),
                dep_title,
                dep_project_id: mod_id.to_string(),
                required_game_versions: all_versions,
                required_loaders: all_loaders,
                instance_game_version: game_version.to_string(),
                instance_loader: loader.to_string(),
                kind: kind.to_string(),
                reason,
            });
            return Err(format!(
                "No compatible file for CurseForge project {}",
                mod_id
            ));
        }
    };

    let file_version_id = file.file_id.to_string();

    let is_datapack = category == "datapack"
        || (file.loaders.iter().any(|l| l.eq_ignore_ascii_case("datapack"))
            && (file.loaders.len() == 1 || loader == "vanilla"));
    let effective_category = if is_datapack { "datapack" } else { category };

    let instance_dir = paths::instances_dir().join(instance_id);
    let folder = target_folder(effective_category);
    let target_dir = instance_dir.join(".minecraft").join(folder);

    let meta_path = instance_dir.join("instance.json");
    let installed_before: Option<ModEntry> = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Instance>(&raw).ok())
        .and_then(|inst| inst.mods.into_iter().find(|m| m.project_id == mod_id));

    if let Some(ref prev) = installed_before {
        let prev_file = target_dir.join(&prev.filename);
        if prev.version_id == file_version_id && prev_file.exists() && (!is_root || !had_explicit_file) {
            return Ok(prev.clone());
        }
        if prev.pinned && !had_explicit_file {
            let dep_title = prev.title.clone().unwrap_or_else(|| mod_id.to_string());
            let held_at = prev
                .version_number
                .clone()
                .unwrap_or_else(|| prev.version_id.clone());
            issues.push(DependencyIssue {
                parent_title: parent_title.unwrap_or("(unknown)").to_string(),
                dep_title: dep_title.clone(),
                dep_project_id: mod_id.to_string(),
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

    // === Download ===
    let download_url = match file.download_url.as_ref() {
        Some(u) => u.clone(),
        None => {
            // Check if Modrinth has this exact file via SHA-1
            let mut cross_resolved: Option<String> = None;
            if let Some(sha1) = file.hashes.first() {
                if let Ok(map) = crate::services::modrinth::get_versions_by_hashes(&[sha1.clone()]).await {
                    if let Some(version) = map.get(sha1) {
                        let matched_file = version
                            .files
                            .iter()
                            .find(|f| f.hashes.sha1.as_ref() == Some(sha1))
                            .or_else(|| version.files.iter().find(|f| f.primary))
                            .or_else(|| version.files.first());
                        if let Some(f) = matched_file {
                            tracing::info!(
                                "Cross-source resolved single mod {} via Modrinth SHA-1 (project: {})",
                                file.file_name,
                                version.project_id
                            );
                            cross_resolved = Some(f.url.clone());
                        }
                    }
                }
            }

            match cross_resolved {
                Some(resolved) => resolved,
                None => {
                    let meta = get_or_fetch_meta(api_key, mod_id, meta_cache).await;
                    let title = meta.name.clone().unwrap_or_else(|| mod_id.to_string());
                    let website = meta.website_url.clone();
                    crate::services::manual_download::notify(
                        window,
                        crate::services::manual_download::ManualDownload {
                            kind: "mod".to_string(),
                            title: title.clone(),
                            file_name: Some(file.file_name.clone()),
                            url: website,
                            instance_id: Some(instance_id.to_string()),
                        },
                    );
                    return Err(format!(
                        "{} can't be downloaded automatically — its author disabled \
                         third-party downloads. Get {} from CurseForge and drop it into the \
                         instance's mods folder.",
                        title, file.file_name
                    ));
                }
            }
        }
    };

    fs::create_dir_all(&target_dir).map_err(|e| format!("Create {}: {}", folder, e))?;

    let task = DownloadTask {
        url: download_url.clone(),
        dest: target_dir.join(&file.file_name),
        expected_sha1: file.hashes.first().cloned(),
        expected_size: Some(file.file_length),
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    // === Metadata (cached, zero redundant HTTP calls) ===
    let (title, icon_url, author) = {
        let meta = get_or_fetch_meta(api_key, mod_id, meta_cache).await;
        (meta.name.clone(), meta.icon_url.clone(), meta.author.clone())
    };
    let local_icon_path = match icon_url.as_deref() {
        Some(u) => icon_cache::cache_remote_icon(u).await,
        None => None,
    };

    let mut mod_entry = ModEntry {
        id: file_version_id.clone(),
        source: "curseforge".to_string(),
        project_id: mod_id.to_string(),
        version_id: file_version_id,
        filename: file.file_name.clone(),
        version_number: if file.display_name.is_empty() {
            None
        } else {
            Some(file.display_name.clone())
        },
        enabled: true,
        pinned: false,
        title: title.clone(),
        icon_url,
        local_icon_path,
        description: None,
        category: effective_category.to_string(),
        author,
        loaders: file.loaders.clone(),
        game_versions: file.game_versions.clone(),
    };

    // === Persist instance.json ===
    let content =
        fs::read_to_string(&meta_path).map_err(|e| format!("Read instance.json: {}", e))?;
    let mut instance: Instance =
        serde_json::from_str(&content).map_err(|e| format!("Parse instance.json: {}", e))?;

    match instance.mods.iter().position(|m| m.project_id == mod_id) {
        Some(pos) => {
            let previous = instance.mods[pos].clone();
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
            let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
            fs::write(&meta_path, json).map_err(|e| e.to_string())?;
        }
        None => {
            instance.mods.push(mod_entry.clone());
            let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
            fs::write(&meta_path, json).map_err(|e| e.to_string())?;

            if !is_root {
                deps_installed.push(mod_id.to_string());
                dep_titles.push(title.clone().unwrap_or_else(|| mod_id.to_string()));
            }
        }
    }
    installed_project_ids.insert(mod_id.to_string());

    let parent = title.clone().unwrap_or_else(|| mod_id.to_string());

    // === Declared conflicts (relationType 5) ===
    for clash_id in &file.incompatible {
        if installed_project_ids.contains(clash_id) {
            let present = serde_json::from_str::<Instance>(&fs::read_to_string(&meta_path).unwrap_or_default())
                .ok()
                .and_then(|inst| inst.mods.into_iter().find(|m| &m.project_id == clash_id));
            if let Some(clash) = present {
                let clash_title = clash.title.clone().unwrap_or_else(|| clash_id.clone());
                issues.push(DependencyIssue {
                    parent_title: parent.clone(),
                    dep_title: clash_title.clone(),
                    dep_project_id: clash_id.clone(),
                    required_game_versions: Vec::new(),
                    required_loaders: Vec::new(),
                    instance_game_version: game_version.to_string(),
                    instance_loader: loader.to_string(),
                    kind: "conflict".to_string(),
                    reason: format!(
                        "{} declares it cannot run alongside {}, which is installed. \
                         Remove one of them.",
                        parent, clash_title
                    ),
                });
            }
        }
    }

    // === Walk required dependencies ===
    // Batch-fetch metadata for all unvisited, uncached dependencies at once
    let unvisited_deps: Vec<String> = file
        .dependencies
        .iter()
        .filter(|dep_id| !visited_projects.contains(*dep_id) && !installed_project_ids.contains(*dep_id))
        .cloned()
        .collect();

    let uncached_dep_ids: Vec<String> = unvisited_deps
        .iter()
        .filter(|dep_id| !meta_cache.contains_key(*dep_id))
        .cloned()
        .collect();

    if !uncached_dep_ids.is_empty() {
        let batch = curseforge::fetch_projects_meta(api_key, &uncached_dep_ids).await;
        meta_cache.extend(batch);
    }

    for dep_id in &file.dependencies {
        if visited_projects.contains(dep_id) {
            continue;
        }
        if installed_project_ids.contains(dep_id) {
            visited_projects.insert(dep_id.clone());
            continue;
        }

        let dep_class = meta_cache.get(dep_id).and_then(|m| m.class_id);
        let dep_category = category_for_class(dep_class);

        if let Err(e) = Box::pin(install_cf_one(
            instance_id,
            dep_id,
            loader,
            game_version,
            &dep_category,
            api_key,
            Some(&parent),
            None,
            visited_projects,
            deps_installed,
            dep_titles,
            issues,
            false,
            window,
            meta_cache,
            installed_project_ids,
        ))
        .await
        {
            tracing::warn!("Skipping CurseForge dependency {} of {}: {}", dep_id, mod_id, e);
            if !issues.iter().any(|i| &i.dep_project_id == dep_id) {
                let dep_title = meta_cache
                    .get(dep_id)
                    .and_then(|m| m.name.clone())
                    .unwrap_or_else(|| dep_id.clone());
                issues.push(DependencyIssue {
                    parent_title: parent.clone(),
                    dep_title,
                    dep_project_id: dep_id.clone(),
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

/// Map a CurseForge `classId` to the launcher's category string. Unknown or
/// absent classes fall back to `"mod"`.
fn category_for_class(class_id: Option<u32>) -> String {
    match class_id {
        Some(CLASS_RESOURCE_PACKS) => "resourcepack",
        Some(CLASS_SHADERS) => "shader",
        Some(CLASS_DATA_PACKS) => "datapack",
        // Class 6 (Mods) and anything unrecognized install as a mod.
        _ => "mod",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal file fixture. `release_type`: 1 = Release, 2 = Beta, 3 = Alpha.
    fn file(
        id: u64,
        release_type: u32,
        game_versions: &[&str],
        loaders: &[&str],
        is_available: bool,
    ) -> CfFileInfo {
        CfFileInfo {
            file_id: id,
            file_name: format!("mod-{}.jar", id),
            display_name: format!("mod {}", id),
            download_url: Some("https://example.invalid/f.jar".to_string()),
            file_length: 1,
            hashes: Vec::new(),
            dependencies: Vec::new(),
            incompatible: Vec::new(),
            release_type,
            file_date: None,
            game_versions: game_versions.iter().map(|s| s.to_string()).collect(),
            loaders: loaders.iter().map(|s| s.to_string()).collect(),
            is_available,
        }
    }

    /// CurseForge ids are monotonic, so newest = highest id — but only among
    /// files that are actually compatible.
    #[test]
    fn highest_id_wins_within_the_stable_channel() {
        let files = vec![
            file(100, 1, &["1.21.1"], &["fabric"], true),
            file(300, 1, &["1.21.1"], &["fabric"], true),
            file(200, 1, &["1.21.1"], &["fabric"], true),
        ];
        assert_eq!(find_preferred_file(&files, "1.21.1", "fabric").unwrap().file_id, 300);
    }

    /// The same regression guarded on the Modrinth side: a newer alpha must not
    /// beat a stable release.
    #[test]
    fn stable_wins_over_a_newer_alpha() {
        let files = vec![
            file(999, 3, &["1.21.1"], &["fabric"], true),
            file(500, 1, &["1.21.1"], &["fabric"], true),
        ];
        assert_eq!(find_preferred_file(&files, "1.21.1", "fabric").unwrap().file_id, 500);
    }

    /// The whole reason selection is validated locally: the API's
    /// `modLoaderType` filter silently doesn't apply for a loader we can't map,
    /// so a Forge file can appear in the list for a Fabric instance.
    #[test]
    fn wrong_loader_is_rejected_even_when_it_is_newest() {
        let files = vec![
            file(999, 1, &["1.21.1"], &["forge"], true),
            file(100, 1, &["1.21.1"], &["fabric"], true),
        ];
        assert_eq!(find_preferred_file(&files, "1.21.1", "fabric").unwrap().file_id, 100);
    }

    /// A file CurseForge isn't serving would produce a download that can't
    /// succeed, so it must not be selected.
    #[test]
    fn unavailable_files_are_skipped() {
        let files = vec![
            file(999, 1, &["1.21.1"], &["fabric"], false),
            file(100, 1, &["1.21.1"], &["fabric"], true),
        ];
        assert_eq!(find_preferred_file(&files, "1.21.1", "fabric").unwrap().file_id, 100);
    }

    /// Older uploads and loader-agnostic content declare no loaders. Treating
    /// that as "incompatible" would make them uninstallable.
    #[test]
    fn untagged_files_are_treated_as_unconstrained() {
        let files = vec![file(100, 1, &["1.21.1"], &[], true)];
        assert!(find_preferred_file(&files, "1.21.1", "fabric").is_some());
    }

    /// An empty game version means "any" (resource packs / shaders with a blank
    /// version box). It must not reject everything.
    #[test]
    fn empty_game_version_matches_any_file() {
        let files = vec![file(100, 1, &["1.16.5"], &[], true)];
        assert!(find_preferred_file(&files, "", "").is_some());
    }

    #[test]
    fn wrong_game_version_is_rejected() {
        let files = vec![file(100, 1, &["1.16.5"], &["fabric"], true)];
        assert!(find_preferred_file(&files, "1.21.1", "fabric").is_none());
    }

    /// Dependencies must land in the folder matching their OWN content type,
    /// not the parent's.
    #[test]
    fn class_ids_map_to_content_categories() {
        assert_eq!(category_for_class(Some(12)), "resourcepack");
        assert_eq!(category_for_class(Some(6552)), "shader");
        assert_eq!(category_for_class(Some(6945)), "datapack");
        assert_eq!(category_for_class(Some(6)), "mod");
        assert_eq!(category_for_class(None), "mod");
    }

    #[test]
    fn quilt_loader_accepts_fabric_and_quilt_files() {
        let fabric_file = file(100, 1, &["1.20.1"], &["fabric"], true);
        let quilt_file = file(200, 1, &["1.20.1"], &["quilt"], true);
        let forge_file = file(300, 1, &["1.20.1"], &["forge"], true);

        assert!(is_file_compatible(&fabric_file, "1.20.1", "quilt"));
        assert!(is_file_compatible(&quilt_file, "1.20.1", "quilt"));
        assert!(!is_file_compatible(&forge_file, "1.20.1", "quilt"));

        let files = vec![fabric_file.clone(), forge_file];
        assert_eq!(
            find_preferred_file(&files, "1.20.1", "quilt").unwrap().file_id,
            100
        );

        let files_with_quilt = vec![fabric_file, quilt_file];
        assert_eq!(
            find_preferred_file(&files_with_quilt, "1.20.1", "quilt").unwrap().file_id,
            200
        );
    }
}
