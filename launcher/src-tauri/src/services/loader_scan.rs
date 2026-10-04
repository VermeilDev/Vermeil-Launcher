// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Loader-version validation.
//!
//! Modpack manifests pin a loader version, but individual mods inside the
//! pack sometimes require a *newer* loader than the author declared. When
//! that mismatch exists the game crashes at startup with a "requires loader
//! version >= X" error.
//!
//! This module scans every mod JAR's embedded manifest, extracts each mod's
//! declared minimum loader version, and finds the maximum across the pack.
//! If that exceeds the instance's current loader version, the caller bumps
//! the loader to a satisfying version and re-installs the loader libraries.
//!
//! Works uniformly across loaders because every loader stores its dependency
//! declarations in a manifest file inside the JAR:
//!   • Fabric → `fabric.mod.json`        → `depends.fabricloader`
//!   • Quilt  → `quilt.mod.json`         → `quilt_loader.depends[id=quilt_loader]`
//!             (Quilt mods often also ship `fabric.mod.json` as a fallback)
//!   • Forge  → `META-INF/mods.toml`     → dependency block `modId="forge"`
//!   • NeoForge → `META-INF/neoforge.mods.toml` or `META-INF/mods.toml`
//!               → dependency block `modId="neoforge"`

use crate::models::instance::LoaderType;
use std::fs;
use std::io::Read;
use std::path::Path;

/// A single mod's declared minimum loader version requirement.
#[derive(Debug, Clone)]
pub struct LoaderRequirement {
    /// The mod JAR filename (for diagnostics / user-facing messages).
    pub mod_file: String,
    /// Extracted minimum loader version (e.g. "0.15.0", "47.1.3").
    pub min_version: String,
}

/// Scan every `.jar` in `mods_dir` and extract its loader-version requirement.
/// Mods that don't declare a requirement (or fail to parse) are skipped.
///
/// Synchronous + filesystem-heavy — call from a blocking context or wrap in
/// `spawn_blocking`.
pub fn scan_mod_loader_requirements(
    mods_dir: &Path,
    loader_type: &LoaderType,
) -> Vec<LoaderRequirement> {
    let mut out = Vec::new();

    let entries = match fs::read_dir(mods_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        // Only scan enabled mods. Disabled mods carry a `.disabled` suffix
        // (see mod toggle) and won't be loaded by the game, so their loader
        // requirement is irrelevant.
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.ends_with(".jar") {
            continue;
        }

        if let Some(min_version) = read_requirement(&path, loader_type) {
            out.push(LoaderRequirement {
                mod_file: name,
                min_version,
            });
        }
    }

    out
}

/// Read a single mod JAR and extract its loader-version requirement.
fn read_requirement(jar_path: &Path, loader_type: &LoaderType) -> Option<String> {
    let file = fs::File::open(jar_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    match loader_type {
        LoaderType::Fabric => read_fabric_requirement(&mut archive),
        LoaderType::Quilt => {
            // Quilt mods may ship quilt.mod.json (preferred) and/or
            // fabric.mod.json. Try Quilt's first, fall back to Fabric's.
            read_quilt_requirement(&mut archive)
                .or_else(|| read_fabric_requirement(&mut archive))
        }
        LoaderType::Forge => read_forge_requirement(&mut archive, "forge"),
        LoaderType::Neoforge => {
            // NeoForge moved to neoforge.mods.toml in 1.20.5+; older mods use
            // mods.toml with modId="neoforge". Check both.
            read_neoforge_toml(&mut archive)
                .or_else(|| read_forge_requirement(&mut archive, "neoforge"))
        }
        LoaderType::Vanilla => None,
    }
}

/// Read the entry named `name` from the archive into a string, if present.
fn read_entry<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

/// Parse `fabric.mod.json` → `depends.fabricloader`.
fn read_fabric_requirement<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let content = read_entry(archive, "fabric.mod.json")?;
    // Fabric's JSON allows comments / trailing junk in some mods; serde_json
    // is strict, so on parse failure we just skip this mod.
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    let depends = v.get("depends")?;
    let predicate = depends.get("fabricloader")?;
    extract_min_from_predicate(predicate)
}

/// Parse `quilt.mod.json` → `quilt_loader.depends[] where id == "quilt_loader"`.
fn read_quilt_requirement<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let content = read_entry(archive, "quilt.mod.json")?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    let depends = v.get("quilt_loader")?.get("depends")?.as_array()?;
    for dep in depends {
        // Entries are either a bare string id or an object {id, versions}.
        if let Some(obj) = dep.as_object() {
            if obj.get("id").and_then(|i| i.as_str()) == Some("quilt_loader") {
                if let Some(versions) = obj.get("versions") {
                    if let Some(min) = extract_min_from_predicate(versions) {
                        return Some(min);
                    }
                }
            }
        }
    }
    None
}

/// Parse `META-INF/neoforge.mods.toml`.
fn read_neoforge_toml<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let content = read_entry(archive, "META-INF/neoforge.mods.toml")?;
    parse_forge_toml(&content, "neoforge")
}

/// Parse `META-INF/mods.toml` for the dependency block matching `loader_id`.
fn read_forge_requirement<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    loader_id: &str,
) -> Option<String> {
    let content = read_entry(archive, "META-INF/mods.toml")?;
    parse_forge_toml(&content, loader_id)
}

/// Parse a Forge/NeoForge `mods.toml` and pull the `versionRange` of the
/// dependency whose `modId` matches `loader_id`, then extract its lower bound.
fn parse_forge_toml(content: &str, loader_id: &str) -> Option<String> {
    let parsed: toml::Value = toml::from_str(content).ok()?;
    // dependencies is a table keyed by the declaring mod's id, each value is
    // an array of dependency tables.
    let deps = parsed.get("dependencies")?.as_table()?;
    for (_mod_id, dep_list) in deps {
        let arr = match dep_list.as_array() {
            Some(a) => a,
            None => continue,
        };
        for dep in arr {
            let dep_table = match dep.as_table() {
                Some(t) => t,
                None => continue,
            };
            let mod_id = dep_table.get("modId").and_then(|v| v.as_str());
            if mod_id == Some(loader_id) {
                if let Some(range) = dep_table.get("versionRange").and_then(|v| v.as_str()) {
                    if let Some(min) = extract_min_from_maven_range(range) {
                        return Some(min);
                    }
                }
            }
        }
    }
    None
}

/// Extract a minimum version from a Fabric/Quilt version predicate.
///
/// Handles the common forms:
///   • `">=0.15.0"`            → `0.15.0`
///   • `"0.15.0"`              → `0.15.0`
///   • `["*"]` / `"*"`         → None (no constraint)
///   • array of predicates     → first usable min
fn extract_min_from_predicate(predicate: &serde_json::Value) -> Option<String> {
    match predicate {
        serde_json::Value::String(s) => extract_min_from_fabric_string(s),
        serde_json::Value::Array(arr) => {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if let Some(min) = extract_min_from_fabric_string(s) {
                        return Some(min);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Pull a concrete minimum version out of a single Fabric predicate string.
/// `">=0.15.0"` → `0.15.0`, `"0.15.0"` → `0.15.0`, `"*"`/`"<0.16"` → None.
fn extract_min_from_fabric_string(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s == "*" {
        return None;
    }
    // Strip a leading comparator. We only care about lower bounds (>=, >, =,
    // ~, ^, or bare). A pure upper-bound predicate (`<0.16`) imposes no
    // minimum we need to satisfy, so we skip it.
    let stripped = s
        .trim_start_matches(">=")
        .trim_start_matches('>')
        .trim_start_matches('~')
        .trim_start_matches('^')
        .trim_start_matches('=')
        .trim();
    // If after stripping it still starts with `<`, it's an upper bound only.
    if stripped.starts_with('<') {
        return None;
    }
    // Take the leading dotted-numeric run (drop any build/pre suffix).
    let version = take_version_prefix(stripped);
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Extract the lower bound from a Maven version range.
/// `"[47.1.0,)"` → `47.1.0`, `"[47,48)"` → `47`, `"47.1.0"` → `47.1.0`.
/// Open lower bounds (`"(,48)"`) impose no minimum → None.
fn extract_min_from_maven_range(range: &str) -> Option<String> {
    let range = range.trim();
    if range.is_empty() {
        return None;
    }
    // Bracketed range: [low,high] / [low,) / (low,high)
    if range.starts_with('[') || range.starts_with('(') {
        let inner = &range[1..];
        let low = inner.split(',').next().unwrap_or("").trim();
        if low.is_empty() {
            return None; // open lower bound
        }
        let v = take_version_prefix(low);
        return if v.is_empty() { None } else { Some(v) };
    }
    // Bare version string.
    let v = take_version_prefix(range);
    if v.is_empty() { None } else { Some(v) }
}

/// Take the leading dotted-numeric version prefix from a string.
/// `"0.15.0+build.1"` → `"0.15.0"`, `"47.1.3-beta"` → `"47.1.3"`.
fn take_version_prefix(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            out.push(ch);
        } else {
            break;
        }
    }
    // Trim a trailing dot if the version ended oddly.
    out.trim_end_matches('.').to_string()
}

/// Compare two dotted-numeric version strings. Returns true if `a` < `b`.
/// Missing components are treated as 0 (e.g. "47" < "47.1.0").
pub fn version_less_than(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let pb: Vec<u64> = b.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

/// The maximum required loader version across all scanned mods, or None if
/// no mod declares a requirement.
pub fn max_required_version(reqs: &[LoaderRequirement]) -> Option<String> {
    reqs.iter()
        .map(|r| r.min_version.clone())
        .reduce(|acc, v| if version_less_than(&acc, &v) { v } else { acc })
}


// ─── Orchestration: scan → decide → bump ────────────────────────────────

use crate::models::instance::Instance;
use crate::util::paths;

/// Result of a loader validation pass.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LoaderFixResult {
    /// Whether the loader version was changed.
    pub bumped: bool,
    /// Loader version before the fix (the instance's original).
    pub from_version: Option<String>,
    /// Loader version after the fix (None if no change).
    pub to_version: Option<String>,
    /// How many mods declared a requirement higher than the original.
    pub mods_requiring: usize,
}

/// Scan an instance's mods and, if any require a newer loader than the
/// instance currently uses, bump the instance's loader version to a
/// satisfying release and rewrite `instance.json`.
///
/// Does NOT re-download loader libraries — the caller should run the prepare
/// flow afterward (it picks up the new version from instance.json). Returns
/// what changed so the caller can surface a toast.
///
/// No-op (returns `bumped: false`) for vanilla instances, instances with no
/// loader version, or when the current loader already satisfies every mod.
pub async fn validate_and_fix_loader(instance_id: &str) -> Result<LoaderFixResult, String> {
    let meta_path = paths::instances_dir().join(instance_id).join("instance.json");
    let content = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let mut instance: Instance = serde_json::from_str(&content)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    let no_op = LoaderFixResult {
        bumped: false,
        from_version: instance.loader.version.clone(),
        to_version: None,
        mods_requiring: 0,
    };

    // Vanilla or no pinned loader version → nothing to validate.
    let current_version = match &instance.loader.version {
        Some(v) if !v.is_empty() => v.clone(),
        _ => return Ok(no_op),
    };
    if matches!(instance.loader.loader_type, LoaderType::Vanilla) {
        return Ok(no_op);
    }

    // Scan the mods folder on a blocking thread (filesystem + zip heavy).
    let mods_dir = paths::instances_dir()
        .join(instance_id)
        .join(".minecraft")
        .join("mods");
    let loader_type = instance.loader.loader_type.clone();
    let reqs = tokio::task::spawn_blocking(move || {
        scan_mod_loader_requirements(&mods_dir, &loader_type)
    })
    .await
    .map_err(|e| format!("Scan task panicked: {}", e))?;

    // Forge/NeoForge instance versions can carry the `{mc}-{forge}` prefix
    // (e.g. "1.20.1-47.1.0"); mods only declare the forge-side number. Strip
    // the MC prefix for an apples-to-apples comparison.
    let current_loader_num = strip_mc_prefix(&current_version, &instance.game_version);

    // How many mods need something newer than what we have?
    let unmet: Vec<&LoaderRequirement> = reqs
        .iter()
        .filter(|r| version_less_than(&current_loader_num, &r.min_version))
        .collect();

    if unmet.is_empty() {
        return Ok(no_op);
    }

    let max_required = match max_required_version(&reqs) {
        Some(v) => v,
        None => return Ok(no_op),
    };

    // Resolve a loader version that satisfies `max_required`. We bump to the
    // latest stable release for the loader/MC, which always satisfies the
    // requirement (it's the newest available).
    let target = match resolve_bump_target(
        &instance.loader.loader_type,
        &instance.game_version,
        &max_required,
    )
    .await
    {
        Some(t) => t,
        None => {
            tracing::warn!(
                "Loader bump needed (require {}) but no satisfying version found for {:?} {}",
                max_required, instance.loader.loader_type, instance.game_version
            );
            return Ok(no_op);
        }
    };

    // Write the new version back.
    instance.loader.version = Some(target.clone());
    let json = serde_json::to_string_pretty(&instance)
        .map_err(|e| format!("Serialize instance: {}", e))?;
    fs::write(&meta_path, json).map_err(|e| format!("Write instance.json: {}", e))?;

    tracing::info!(
        "Bumped {:?} loader {} → {} for instance {} ({} mods required a newer loader: {})",
        instance.loader.loader_type, current_version, target, instance_id, unmet.len(),
        unmet.iter().map(|r| r.mod_file.as_str()).collect::<Vec<_>>().join(", ")
    );

    Ok(LoaderFixResult {
        bumped: true,
        from_version: Some(current_version),
        to_version: Some(target),
        mods_requiring: unmet.len(),
    })
}

/// Strip a `{game_version}-` prefix from a Forge/NeoForge loader version so it
/// compares cleanly against the forge-side number mods declare.
/// `"1.20.1-47.1.0"` with mc `"1.20.1"` → `"47.1.0"`. No prefix → unchanged.
fn strip_mc_prefix(loader_version: &str, game_version: &str) -> String {
    let prefix = format!("{}-", game_version);
    loader_version
        .strip_prefix(&prefix)
        .unwrap_or(loader_version)
        .to_string()
}

/// Find a loader version that satisfies `min_required`, preferring the latest
/// stable release for the loader/MC. Returns the version string to store in
/// `instance.json` (in the same format the install pipeline expects).
async fn resolve_bump_target(
    loader_type: &LoaderType,
    game_version: &str,
    min_required: &str,
) -> Option<String> {
    match loader_type {
        LoaderType::Fabric => {
            // Fabric loader versions are MC-independent. Latest stable always
            // satisfies; fall back to the newest of any stability if needed.
            let versions = crate::services::meta::get_fabric_versions().await.ok()?;
            let stable = versions.iter().find(|v| v.stable).map(|v| v.version.clone());
            let chosen = stable.or_else(|| versions.first().map(|v| v.version.clone()))?;
            // Guard: only return it if it actually satisfies the requirement.
            if version_less_than(&chosen, min_required) {
                None
            } else {
                Some(chosen)
            }
        }
        LoaderType::Quilt => {
            let v = fetch_latest_quilt().await?;
            if version_less_than(&v, min_required) { None } else { Some(v) }
        }
        LoaderType::Forge => {
            // Forge stores `{mc}-{forge}` in the instance. Fetch the latest
            // forge-side number for this MC and re-prefix it.
            let forge_num = fetch_latest_forge(game_version).await?;
            if version_less_than(&forge_num, min_required) {
                None
            } else {
                Some(format!("{}-{}", game_version, forge_num))
            }
        }
        LoaderType::Neoforge => {
            let v = fetch_latest_neoforge(game_version).await?;
            if version_less_than(&v, min_required) { None } else { Some(v) }
        }
        LoaderType::Vanilla => None,
    }
}

/// Latest Quilt loader version (MC-independent).
async fn fetch_latest_quilt() -> Option<String> {
    #[derive(serde::Deserialize)]
    struct QuiltVersion { version: String }
    let resp = crate::util::http::HTTP
        .get("https://meta.quiltmc.org/v3/versions/loader")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() { return None; }
    let versions: Vec<QuiltVersion> = resp.json().await.ok()?;
    versions.into_iter().next().map(|v| v.version)
}

/// Latest Forge version (forge-side number) for a given MC version.
async fn fetch_latest_forge(game_version: &str) -> Option<String> {
    let resp = crate::util::http::HTTP
        .get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() { return None; }
    let text = resp.text().await.ok()?;
    let prefix = format!("{}-", game_version);
    // Maven lists oldest→newest, so the last matching entry is the newest.
    let mut latest: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("<version>") && t.ends_with("</version>") {
            let ver = &t[9..t.len() - 10];
            if let Some(forge_part) = ver.strip_prefix(&prefix) {
                // Drop any legacy `-{mc}` suffix (old Forge format).
                let clean = forge_part.split('-').next().unwrap_or(forge_part);
                latest = Some(clean.to_string());
            }
        }
    }
    latest
}

/// Latest NeoForge version for a given MC version.
async fn fetch_latest_neoforge(game_version: &str) -> Option<String> {
    let resp = crate::util::http::HTTP
        .get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() { return None; }
    #[derive(serde::Deserialize)]
    struct MavenVersions { versions: Vec<String> }
    let data: MavenVersions = resp.json().await.ok()?;
    // NeoForge prefix mapping: MC 1.21.4 → "21.4."
    let parts: Vec<&str> = game_version.split('.').collect();
    let mc_prefix = if parts.len() >= 3 && parts[0] == "1" {
        format!("{}.{}.", parts[1], parts[2])
    } else if parts.len() == 2 && parts[0] == "1" {
        format!("{}.", parts[1])
    } else {
        game_version.to_string()
    };
    data.versions
        .iter()
        .filter(|v| v.starts_with(&mc_prefix))
        .next_back()
        .cloned()
}

/// Inspect a mod JAR file and detect its supported loaders based on manifest files inside the archive.
/// Returns a list of loader IDs (e.g. `["fabric", "quilt"]`, `["neoforge"]`, `["forge"]`).
pub fn detect_jar_loaders(jar_path: &Path) -> Vec<String> {
    let file = match fs::File::open(jar_path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };

    let mut loaders = Vec::new();

    let has_quilt = archive.by_name("quilt.mod.json").is_ok();
    let has_fabric = archive.by_name("fabric.mod.json").is_ok();
    let has_neoforge_toml = archive.by_name("META-INF/neoforge.mods.toml").is_ok();
    let has_mods_toml = archive.by_name("META-INF/mods.toml").is_ok();
    let has_mcmod_info = archive.by_name("mcmod.info").is_ok();

    if has_neoforge_toml {
        loaders.push("neoforge".to_string());
    }

    if has_mods_toml {
        if let Some(content) = read_entry(&mut archive, "META-INF/mods.toml") {
            if content.contains("modId=\"neoforge\"") || content.contains("modId = \"neoforge\"") {
                if !loaders.contains(&"neoforge".to_string()) {
                    loaders.push("neoforge".to_string());
                }
            } else if !loaders.contains(&"forge".to_string()) {
                loaders.push("forge".to_string());
            }
        } else if !loaders.contains(&"forge".to_string()) {
            loaders.push("forge".to_string());
        }
    } else if has_mcmod_info && !loaders.contains(&"forge".to_string()) {
        loaders.push("forge".to_string());
    }

    if has_quilt {
        loaders.push("quilt".to_string());
        if has_fabric && !loaders.contains(&"fabric".to_string()) {
            loaders.push("fabric".to_string());
        }
    } else if has_fabric {
        if !loaders.contains(&"fabric".to_string()) {
            loaders.push("fabric".to_string());
        }
        // Fabric mods run on Quilt
        if !loaders.contains(&"quilt".to_string()) {
            loaders.push("quilt".to_string());
        }
    }

    loaders
}

/// Determine whether a mod with the declared `mod_loaders` can run under the given instance `loader`.
/// If `mod_loaders` is empty, returns `true` (permissive fallback for unclassified/custom assets).
pub fn is_mod_compatible_with_loader(loader: &LoaderType, mod_loaders: &[String]) -> bool {
    if mod_loaders.is_empty() {
        return true;
    }

    let target = match loader {
        LoaderType::Fabric => "fabric",
        LoaderType::Quilt => "quilt",
        LoaderType::Forge => "forge",
        LoaderType::Neoforge => "neoforge",
        LoaderType::Vanilla => "vanilla",
    };

    match loader {
        LoaderType::Vanilla => false,
        LoaderType::Quilt => {
            // Quilt loader can run Quilt mods AND Fabric mods
            mod_loaders.iter().any(|l| {
                let l_lower = l.to_lowercase();
                l_lower == "quilt" || l_lower == "fabric"
            })
        }
        _ => {
            mod_loaders.iter().any(|l| l.eq_ignore_ascii_case(target))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_mod_compatible_with_loader() {
        // Empty loaders is permissive
        assert!(is_mod_compatible_with_loader(&LoaderType::Fabric, &[]));
        assert!(is_mod_compatible_with_loader(&LoaderType::Neoforge, &[]));

        // Vanilla runs no mods
        assert!(!is_mod_compatible_with_loader(&LoaderType::Vanilla, &[format!("fabric")]));

        // Fabric mods
        let fabric = vec!["fabric".to_string(), "quilt".to_string()];
        assert!(is_mod_compatible_with_loader(&LoaderType::Fabric, &fabric));
        assert!(is_mod_compatible_with_loader(&LoaderType::Quilt, &fabric));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Neoforge, &fabric));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Forge, &fabric));

        // NeoForge mods
        let neoforge = vec!["neoforge".to_string()];
        assert!(is_mod_compatible_with_loader(&LoaderType::Neoforge, &neoforge));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Fabric, &neoforge));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Forge, &neoforge));

        // Forge mods
        let forge = vec!["forge".to_string()];
        assert!(is_mod_compatible_with_loader(&LoaderType::Forge, &forge));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Neoforge, &forge));
        assert!(!is_mod_compatible_with_loader(&LoaderType::Fabric, &forge));
    }
}


