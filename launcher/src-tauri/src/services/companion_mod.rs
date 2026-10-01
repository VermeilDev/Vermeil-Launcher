// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Download-on-demand install of the Vermeil companion mod jar.
//!
//! The mod jars are published as GitHub release assets on `mod-v*` tags, each
//! release carrying a `companion-manifest.json` that lists every jar's Minecraft
//! version, loaders, URL, SHA-1, and size (see
//! `.github/workflows/mod-release.yml`).
//!
//! At launch, for a **supported** instance with the companion **enabled** (the
//! per-instance toggle), we ensure the matching jar is the active build in the
//! instance's `mods/` — fetching and SHA-1-verifying it the first time it's
//! needed — and when it's toggled off (or unsupported) we **disable** our jar in
//! place by renaming it `.disabled` rather than deleting it, so flipping it back
//! on needs no re-download. The mod reads its data (cape, `vermeil-settings.json`)
//! from the global `companion/` dir (see `instance_cape`).
//!
//! Best-effort throughout: a cosmetic cape must never block or fail a launch, so
//! every network/IO error is logged and swallowed.

use crate::models::instance::Instance;
use crate::services::download::{download_file, DownloadTask};
use crate::services::instance_cape;
use crate::util::{http, paths};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Repo that hosts the companion mod releases.
const REPO: &str = "VermeilDev/Vermeil-Companion";
/// Filename prefix for jars we manage. Only files matching our published naming
/// (`vermeil-<modVersion>+<mcVersion>.jar`) are ever added, disabled, or
/// removed, so a user's own mods are never touched.
const JAR_PREFIX: &str = "vermeil-";
/// Suffix used to disable a managed jar in place (loaders ignore `.jar.disabled`),
/// so toggling the companion off then on needs no re-download.
const DISABLED_SUFFIX: &str = ".disabled";

/// Parse a managed jar filename into `(loader_prefix, mod_version, mc_suffix)`.
/// E.g. `"vermeil-fabric-0.2.4+mc26.3.jar"` -> `("vermeil-fabric", "0.2.4", "mc26.3.jar")`.
fn parse_managed_filename(filename: &str) -> Option<(&str, &str, &str)> {
    let clean = filename.strip_suffix(DISABLED_SUFFIX).unwrap_or(filename);
    if !clean.starts_with(JAR_PREFIX) || !clean.ends_with(".jar") {
        return None;
    }
    let (left, mc_suffix) = clean.split_once('+')?;
    let (prefix, version) = left.rsplit_once('-')?;
    Some((prefix, version, mc_suffix))
}

/// Compare two numeric dotted version strings (e.g. "0.2.5" vs "0.2.4").
fn version_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = a.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let pb: Vec<u64> = b.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    pa.cmp(&pb)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    /// Every Minecraft version this single jar supports. One jar can cover a
    /// whole render-era range (e.g. `["26.1","26.1.1","26.1.2","26.2"]`), so the
    /// launcher matches an instance's exact version against this list.
    #[serde(rename = "minecraftVersions")]
    minecraft_versions: Vec<String>,
    loaders: Vec<String>,
    file: String,
    url: String,
    sha1: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn companion_cache_dir() -> PathBuf {
    paths::cache_dir().join("companion")
}

fn central_jars_dir() -> PathBuf {
    companion_cache_dir().join("jars")
}

fn manifest_cache_path() -> PathBuf {
    companion_cache_dir().join("manifest.json")
}

fn mods_dir(instance_id: &str) -> PathBuf {
    paths::instances_dir().join(instance_id).join(".minecraft").join("mods")
}

/// Whether a filename is one of our managed jars, active or disabled (our naming
/// includes a `+` version separator, so this won't match arbitrary user mods).
pub fn is_managed(name: &str) -> bool {
    is_managed_active(name) || is_managed_disabled(name)
}

/// An active managed jar — our naming, ends `.jar`.
fn is_managed_active(name: &str) -> bool {
    name.starts_with(JAR_PREFIX) && name.contains('+') && name.ends_with(".jar")
}

/// A disabled managed jar — our naming with the `.disabled` suffix.
fn is_managed_disabled(name: &str) -> bool {
    name.starts_with(JAR_PREFIX) && name.contains('+') && name.ends_with(".jar.disabled")
}

/// Query the companion mod version for an instance.
/// Checks the instance's `mods/` directory for any managed jar (active or disabled).
/// Returns `None` if the companion mod is not installed on disk for this instance.
pub fn get_companion_version(instance_id: &str, _game_version: &str, _loader: &str) -> Option<String> {
    let mods = mods_dir(instance_id);
    let names = read_dir_names(&mods);
    for name in &names {
        if let Some((_prefix, version, _mc)) = parse_managed_filename(name) {
            return Some(version.to_string());
        }
    }
    None
}

/// Result of `ensure_installed`. Surfaced as a launch-time event so the user
/// can see whether the cape will work this run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "detail")]
pub enum CompanionStatus {
    /// Already there or freshly installed — cape will render this run.
    Installed { file: String },
    /// Cape off or instance unsupported — no jar managed (any prior one removed).
    Skipped,
    /// Tried to install but it failed (network / no matching build / disk). The
    /// cape won't render this run; everything else launches fine.
    Failed { reason: String },
}

/// Ensure the companion jar matches this instance's per-instance toggle. Called
/// at launch, before the game starts. Best-effort: never throws.
pub async fn ensure_installed(instance: &Instance) -> CompanionStatus {
    // The per-instance toggle plus the support gate decide it. The mod is a
    // feature host (cape, FOV effects, in-game settings), so its presence is
    // tied to the user wanting it on this instance and the instance being a
    // supported loader + Minecraft version — not to a cape being set.
    let want = instance.companion_enabled && instance_cape::is_supported(instance);
    let mods = mods_dir(&instance.id);

    if !want {
        // Toggled off (or unsupported): disable the jar by renaming it
        // `.disabled` rather than deleting it, so flipping it back on needs no
        // re-download. The game's loader ignores `.jar.disabled`.
        disable_managed(&mods);
        return CompanionStatus::Skipped;
    }

    // Fast path: if an active managed jar is already present in mods/, use it directly.
    // Launching Minecraft should never block on network or auto-upgrade without user consent.
    let names = read_dir_names(&mods);
    if let Some(active) = names.iter().find(|n| is_managed_active(n)) {
        return CompanionStatus::Installed { file: active.clone() };
    }
    if let Some(file) = reenable_existing(&mods) {
        return CompanionStatus::Installed { file };
    }

    // Missing from instance mods/ → resolve against manifest and install
    match resolve_and_install(instance, &mods).await {
        Ok(file) => CompanionStatus::Installed { file },
        Err(e) => {
            tracing::warn!("Companion mod not installed for instance {}: {}", instance.id, e);
            CompanionStatus::Failed { reason: e }
        }
    }
}

/// Time-To-Live for the companion manifest cache (10 minutes).
const MANIFEST_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Ensure the companion jar is present in the central `<data_dir>/companion/jars/`
/// cache, downloading and SHA-1 verifying it if missing.
async fn ensure_central_jar(entry: &ManifestEntry) -> Result<PathBuf, String> {
    let jars_dir = central_jars_dir();
    fs::create_dir_all(&jars_dir).map_err(|e| format!("create central jars dir: {}", e))?;
    let central_jar = jars_dir.join(&entry.file);

    // Exact build already in central cache with matching size → fast path.
    if central_jar.exists() {
        if let Ok(meta) = fs::metadata(&central_jar) {
            if meta.len() == entry.size {
                return Ok(central_jar);
            }
        }
    }

    let task = DownloadTask {
        url: entry.url.clone(),
        dest: central_jar.clone(),
        expected_sha1: Some(entry.sha1.clone()),
        expected_size: Some(entry.size),
    };
    download_file(&http::HTTP, &task).await?;
    tracing::info!("Cached companion mod {} in central store", entry.file);
    Ok(central_jar)
}

/// Fetch the manifest, pick the jar for this instance, ensure it's the active
/// build in `mods/`, then prune any other managed jars. Returns the active
/// filename.
///
/// Order of cheap-first paths:
/// 1. Exact build already active in instance `mods/` → return immediately (0 IO, 0 network).
/// 2. Exact build sitting disabled → rename to active (0 network).
/// 3. Otherwise obtain from central cache (or download to central cache), copy to instance `mods/`.
async fn resolve_and_install(instance: &Instance, mods: &Path) -> Result<String, String> {
    let manifest = fetch_manifest().await?;
    let loader = instance.loader.loader_type.as_str();

    let entry = manifest
        .entries
        .into_iter()
        .find(|e| {
            e.minecraft_versions.iter().any(|v| v == &instance.game_version)
                && e.loaders.iter().any(|l| l == loader)
        })
        .ok_or_else(|| {
            format!("no companion build for Minecraft {} ({})", instance.game_version, loader)
        })?;

    fs::create_dir_all(mods).map_err(|e| format!("create mods dir: {}", e))?;

    let dest = mods.join(&entry.file);
    let disabled = mods.join(format!("{}{}", entry.file, DISABLED_SUFFIX));

    // Exact build already active in instance mods/ → fast path, no IO, no network.
    if dest.exists() {
        prune_managed_except(mods, &entry.file);
        return Ok(entry.file);
    }

    // Exact build sitting disabled (user toggled off then on) → re-enable it
    // with a rename, no download.
    if disabled.exists() {
        fs::rename(&disabled, &dest).map_err(|e| format!("re-enable companion jar: {}", e))?;
        prune_managed_except(mods, &entry.file);
        return Ok(entry.file);
    }

    // A newer build (e.g. local development build) already present in mods/ → keep
    // it, never downgrade a newer local jar to an older manifest release.
    if let Some((target_prefix, target_ver, target_mc)) = parse_managed_filename(&entry.file) {
        let existing_files = read_dir_names(mods);
        for name in &existing_files {
            if let Some((ex_prefix, ex_ver, ex_mc)) = parse_managed_filename(name) {
                if ex_prefix == target_prefix
                    && ex_mc == target_mc
                    && version_compare(ex_ver, target_ver) != std::cmp::Ordering::Less
                {
                    if is_managed_active(name) {
                        prune_managed_except(mods, name);
                        return Ok(name.clone());
                    } else if is_managed_disabled(name) {
                        let active_name = name.trim_end_matches(DISABLED_SUFFIX).to_string();
                        fs::rename(mods.join(name), mods.join(&active_name))
                            .map_err(|e| format!("re-enable companion jar: {}", e))?;
                        prune_managed_except(mods, &active_name);
                        return Ok(active_name);
                    }
                }
            }
        }
    }

    // Missing from instance mods/ → obtain from central cache (downloading if missing)
    let central_path = ensure_central_jar(&entry).await?;
    fs::copy(&central_path, &dest).map_err(|e| format!("copy companion jar from central cache: {}", e))?;

    prune_managed_except(mods, &entry.file);
    tracing::info!("Installed companion mod {} into instance {}", entry.file, instance.id);
    Ok(entry.file)
}

/// Fetch the manifest, using the locally cached copy if fresh (< 6 hours old),
/// or querying GitHub releases if stale/missing. Falls back to stale cache if
/// GitHub is unreachable or rate-limited.
async fn fetch_manifest() -> Result<Manifest, String> {
    let cache_file = manifest_cache_path();

    // 1. Fresh local cache within TTL → fast path
    if let Ok(meta) = fs::metadata(&cache_file) {
        if let Ok(modified) = meta.modified() {
            if let Ok(elapsed) = modified.elapsed() {
                if elapsed < MANIFEST_TTL {
                    if let Ok(content) = fs::read_to_string(&cache_file) {
                        if let Ok(manifest) = serde_json::from_str::<Manifest>(&content) {
                            return Ok(manifest);
                        }
                    }
                }
            }
        }
    }

    // 2. Fetch the latest manifest from GitHub releases
    match fetch_manifest_remote().await {
        Ok(manifest) => {
            if let Some(parent) = cache_file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&manifest) {
                let _ = fs::write(&cache_file, json);
            }
            Ok(manifest)
        }
        Err(net_err) => {
            // 3. Fallback: if network fails (offline, 403 rate limit, etc.),
            // use the cached manifest if available, even if older than TTL.
            if let Ok(content) = fs::read_to_string(&cache_file) {
                if let Ok(manifest) = serde_json::from_str::<Manifest>(&content) {
                    tracing::warn!(
                        "GitHub manifest fetch failed ({}); using cached companion manifest",
                        net_err
                    );
                    return Ok(manifest);
                }
            }
            Err(net_err)
        }
    }
}

/// Query GitHub releases API and download the published `companion-manifest.json`.
async fn fetch_manifest_remote() -> Result<Manifest, String> {
    let api = format!("https://api.github.com/repos/{}/releases?per_page=50", REPO);
    let resp = http::send_with_retry(|| {
        http::HTTP.get(&api).header("Accept", "application/vnd.github+json")
    })
    .await?;
    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|e| format!("parse releases list: {}", e))?;

    // The API returns releases newest-first; take the latest published mod release.
    let release = releases
        .into_iter()
        .find(|r| !r.draft && (r.tag_name.starts_with('v') || r.tag_name.starts_with("mod-v")))
        .ok_or_else(|| "no published companion release found".to_string())?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "companion-manifest.json")
        .ok_or_else(|| format!("release {} has no companion-manifest.json", release.tag_name))?;

    let resp = http::send_with_retry(|| http::HTTP.get(&asset.browser_download_url)).await?;
    resp.json::<Manifest>()
        .await
        .map_err(|e| format!("parse manifest: {}", e))
}

/// Returns the active managed filename in use, re-enabling a disabled one if
/// that's all we have. Used only for offline grace when the manifest check fails:
/// we only ever keep a single managed jar per instance, so any present is *the*
/// companion jar. Filenames embed a version *range*, so we match by our naming
/// rather than an exact version. Best-effort on the rename.
fn reenable_existing(mods: &Path) -> Option<String> {
    let names = read_dir_names(mods);
    if let Some(active) = names.iter().find(|n| is_managed_active(n)) {
        return Some(active.clone());
    }
    let disabled = names.into_iter().find(|n| is_managed_disabled(n))?;
    let active_name = disabled.trim_end_matches(DISABLED_SUFFIX).to_string();
    match fs::rename(mods.join(&disabled), mods.join(&active_name)) {
        Ok(_) => Some(active_name),
        Err(e) => {
            tracing::warn!("Could not re-enable companion jar {}: {}", disabled, e);
            None
        }
    }
}

/// Disable every active managed jar by renaming it `<name>.disabled` (the loader
/// ignores it), keeping the file so re-enabling needs no re-download. Best-effort.
fn disable_managed(mods: &Path) {
    for name in read_dir_names(mods) {
        if !is_managed_active(&name) {
            continue;
        }
        let from = mods.join(&name);
        let to = mods.join(format!("{}{}", name, DISABLED_SUFFIX));
        if let Err(e) = fs::rename(&from, &to) {
            tracing::warn!("Could not disable companion jar {}: {}", from.display(), e);
        }
    }
}

/// Remove every managed file (active or disabled) except the active `keep`.
/// Cleans up old versions and any stale disabled copy so only the current build
/// remains. Best-effort.
fn prune_managed_except(mods: &Path, keep: &str) {
    for name in read_dir_names(mods) {
        if !is_managed(&name) || name == keep {
            continue;
        }
        let path = mods.join(&name);
        if let Err(e) = fs::remove_file(&path) {
            tracing::warn!("Could not remove companion jar {}: {}", path.display(), e);
        }
    }
}

/// All entry names directly under `mods/` (no recursion). Empty on error.
fn read_dir_names(mods: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(mods) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_managed_jar_detection() {
        // Modern multi-loader naming from Stonecutter
        assert!(is_managed_active("vermeil-fabric-0.1.9+mc26.3.jar"));
        assert!(is_managed_active("vermeil-neoforge-0.1.9+mc26.3.jar"));
        assert!(is_managed_active("vermeil-fabric-0.1.9+mc1.21.11.jar"));

        // Legacy Forge 1.8.9 naming
        assert!(is_managed_active("vermeil-0.1.8+1.8.9.jar"));

        // Disabled variants
        assert!(is_managed_disabled("vermeil-fabric-0.1.9+mc26.3.jar.disabled"));
        assert!(is_managed_disabled("vermeil-0.1.8+1.8.9.jar.disabled"));

        // User mods must NEVER be matched as managed
        assert!(!is_managed("sodium-fabric-0.5.8+mc1.20.4.jar"));
        assert!(!is_managed("iris-1.7.0.jar"));
        assert!(!is_managed("vermeil.jar")); // missing + version separator
        assert!(!is_managed("vermeil-custom.jar"));
    }

    #[test]
    fn test_manifest_serde_roundtrip() {
        let json = r#"{
            "entries": [
                {
                    "minecraftVersions": ["26.3", "26.2"],
                    "loaders": ["fabric", "quilt"],
                    "file": "vermeil-fabric-0.1.9+mc26.3.jar",
                    "url": "https://example.com/mod.jar",
                    "sha1": "da39a3ee5e6b4b0d3255bfef95601890afd80709",
                    "size": 54321
                }
            ]
        }"#;

        let manifest: Manifest = serde_json::from_str(json).expect("deserialize manifest");
        assert_eq!(manifest.entries.len(), 1);
        let entry = &manifest.entries[0];
        assert_eq!(entry.file, "vermeil-fabric-0.1.9+mc26.3.jar");
        assert_eq!(entry.loaders, vec!["fabric", "quilt"]);
        assert_eq!(entry.minecraft_versions, vec!["26.3", "26.2"]);
        assert_eq!(entry.size, 54321);

        // Verify it serializes cleanly for caching
        let serialized = serde_json::to_string_pretty(&manifest).expect("serialize manifest");
        let parsed_back: Manifest = serde_json::from_str(&serialized).expect("re-parse manifest");
        assert_eq!(parsed_back.entries[0].file, entry.file);
    }

    #[test]
    fn test_parse_managed_filename_and_version_compare() {
        assert_eq!(
            parse_managed_filename("vermeil-fabric-0.2.4+mc26.3.jar"),
            Some(("vermeil-fabric", "0.2.4", "mc26.3.jar"))
        );
        assert_eq!(
            parse_managed_filename("vermeil-neoforge-0.2.5+mc26.3.jar"),
            Some(("vermeil-neoforge", "0.2.5", "mc26.3.jar"))
        );
        assert_eq!(
            parse_managed_filename("vermeil-0.2.4+1.8.9.jar"),
            Some(("vermeil", "0.2.4", "1.8.9.jar"))
        );
        assert_eq!(
            parse_managed_filename("vermeil-fabric-0.2.5+mc26.3.jar.disabled"),
            Some(("vermeil-fabric", "0.2.5", "mc26.3.jar"))
        );
        assert_eq!(parse_managed_filename("sodium-fabric-0.5.8+mc1.20.4.jar"), None);
        assert_eq!(parse_managed_filename("vermeil.jar"), None);

        assert_eq!(version_compare("0.2.5", "0.2.4"), std::cmp::Ordering::Greater);
        assert_eq!(version_compare("0.2.4", "0.2.5"), std::cmp::Ordering::Less);
        assert_eq!(version_compare("0.2.4", "0.2.4"), std::cmp::Ordering::Equal);
        assert_eq!(version_compare("0.10.0", "0.2.0"), std::cmp::Ordering::Greater);
        assert_eq!(version_compare("1.0.0", "0.9.9"), std::cmp::Ordering::Greater);
    }
}
