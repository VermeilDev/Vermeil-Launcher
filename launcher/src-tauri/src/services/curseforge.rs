// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! CurseForge API integration.
//!
//! Provides search, version listing, and file resolution for the CurseForge
//! mod platform. All requests go through `https://api.curseforge.com/v1` and
//! require an `x-api-key` header. The key is read from `LauncherSettings`.
//!
//! Results are mapped into the same `ModSearchResult` / `ModHit` shape that
//! the Modrinth service uses so the frontend can render both sources with
//! the same card components.

use crate::util::http::HTTP;
use serde::Deserialize;

const CF_BASE: &str = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID: u32 = 432;

/// CurseForge class IDs for Minecraft content types.
fn class_id_for(project_type: &str) -> u32 {
    match project_type {
        "mod" => 6,
        "resourcepack" => 12,
        "shader" => 6552,
        "modpack" => 4471,
        "datapack" => 6945,
        _ => 6,
    }
}

pub fn project_type_from_class_id(class_id: Option<u32>) -> Option<String> {
    match class_id {
        Some(6) => Some("mod".to_string()),
        Some(12) => Some("resourcepack".to_string()),
        Some(6552) => Some("shader".to_string()),
        Some(4471) => Some("modpack".to_string()),
        Some(6945) => Some("datapack".to_string()),
        _ => None,
    }
}

/// Map our loader name to CurseForge's modLoaderType enum.
fn loader_type_id(loader: &str) -> Option<u32> {
    match loader {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// Map our shared sort names to CurseForge's `sortField` enum.
///
/// Note that the launcher's sort dropdown is shared with Modrinth, but the
/// two APIs don't have a 1:1 sort vocabulary. Where they differ we pick the
/// closest CurseForge equivalent so the UI behavior stays coherent:
/// - `follows` → `popularity` (CF has no follower count; popularity is the
///   closest "social proof" sort).
/// - `featured` is a CF-only Modrinth doesn't surface; we treat it like
///   relevance.
fn sort_field_id(sort: &str) -> u32 {
    match sort {
        "relevance" | "featured" => 1,
        "popularity" | "follows" => 2,
        "updated" => 3,
        "name" => 4,
        "downloads" => 6,
        "newest" => 11,
        _ => 1,
    }
}

// ─── Response types (CurseForge JSON shape) ─────────────────────────────

#[derive(Debug, Deserialize)]
struct CfSearchResponse {
    data: Vec<CfMod>,
    pagination: CfPagination,
}

#[derive(Debug, Deserialize)]
struct CfPagination {
    index: u32,
    #[serde(rename = "pageSize")]
    page_size: u32,
    #[serde(rename = "totalCount")]
    total_count: u64,
}

#[derive(Debug, Deserialize)]
struct CfMod {
    id: u64,
    #[serde(rename = "classId")]
    class_id: Option<u32>,
    name: String,
    slug: String,
    summary: String,
    #[serde(rename = "downloadCount")]
    download_count: u64,
    #[serde(rename = "thumbsUpCount")]
    thumbs_up_count: u32,
    logo: Option<CfLogo>,
    categories: Vec<CfCategory>,
    /// Author list. CurseForge always returns at least one for published
    /// projects. We only display the first one to match Modrinth's
    /// single-author display.
    #[serde(default)]
    authors: Vec<CfAuthor>,
    #[serde(rename = "latestFilesIndexes")]
    latest_files_indexes: Vec<CfFileIndex>,
    /// Fuller per-file list. `gameVersions` mixes MC versions and loader names
    /// (e.g. `["1.8.9","Forge"]`), so it recovers the loader + versions that
    /// the compact `latestFilesIndexes` drops for older files.
    #[serde(rename = "latestFiles", default)]
    latest_files: Vec<CfLatestFile>,
}

#[derive(Debug, Deserialize)]
struct CfLatestFile {
    #[serde(rename = "gameVersions", default)]
    game_versions: Vec<String>,
    #[serde(rename = "displayName", default)]
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct CfAuthor {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CfLogo {
    #[serde(rename = "thumbnailUrl")]
    thumbnail_url: String,
    /// Full-size icon URL. Used as fallback when `thumbnailUrl` is empty
    /// (some CurseForge projects only populate the full `url` field).
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct CfCategory {
    slug: String,
}

#[derive(Debug, Deserialize)]
struct CfFileIndex {
    #[serde(rename = "gameVersion")]
    game_version: String,
    #[serde(rename = "fileId")]
    file_id: u64,
    #[serde(rename = "modLoader")]
    mod_loader: Option<u32>,
}

// ─── Public result types (shared with commands layer) ───────────────────

/// A single search hit, mapped to the same shape as Modrinth's `ModHit`.
pub struct CfHit {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub follows: u32,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub latest_version: Option<String>,
    /// Human-readable latest-file label (CurseForge `displayName`), shown as
    /// the content version on Browse cards. Free from the search response.
    pub version_name: Option<String>,
    /// Primary author display name (first entry in CurseForge's authors array).
    pub author: Option<String>,
    pub project_type: Option<String>,
}

pub struct CfSearchResult {
    pub hits: Vec<CfHit>,
    pub total_hits: u32,
    pub offset: u32,
    pub limit: u32,
}

// ─── Public API ─────────────────────────────────────────────────────────

/// Search CurseForge for mods/resource packs/shaders/modpacks.
///
/// Maps CurseForge's response into our unified `CfSearchResult` shape.
/// The `api_key` is read from settings by the command layer and passed in
/// so this service stays free of Tauri types.
pub async fn search(
    api_key: &str,
    query: &str,
    loader: &str,
    game_version: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    project_type: &str,
) -> Result<CfSearchResult, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured. Add it in Settings.".to_string());
    }

    if loader == "vanilla" && project_type == "mod" {
        return Ok(CfSearchResult {
            hits: vec![],
            total_hits: 0,
            offset,
            limit,
        });
    }

    let sort_field = sort_field_id(sort);

    let mut url = if project_type == "all" || project_type.is_empty() {
        format!(
            "{}/mods/search?gameId={}&index={}&pageSize={}&sortField={}&sortOrder=desc",
            CF_BASE, MINECRAFT_GAME_ID, offset, limit.min(50), sort_field
        )
    } else {
        let class_id = class_id_for(project_type);
        format!(
            "{}/mods/search?gameId={}&classId={}&index={}&pageSize={}&sortField={}&sortOrder=desc",
            CF_BASE, MINECRAFT_GAME_ID, class_id, offset, limit.min(50), sort_field
        )
    };

    if !query.is_empty() {
        url.push_str(&format!("&searchFilter={}", urlencoding::encode(query)));
    }
    if !game_version.is_empty() {
        url.push_str(&format!("&gameVersion={}", urlencoding::encode(game_version)));
    }
    // CurseForge's `modLoaderType` filter applies to mods AND modpacks
    // (both have a primary loader). Resource packs, shaders, and datapacks
    // are loader-agnostic — applying the filter to them returns 0 results.
    if project_type == "mod" || project_type == "modpack" {
        if let Some(loader_id) = loader_type_id(loader) {
            url.push_str(&format!("&modLoaderType={}", loader_id));
        }
    }

    let resp = crate::util::http::send_with_retry(|| HTTP.get(&url).header("x-api-key", api_key))
        .await
        .map_err(|e| format!("CurseForge search failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CurseForge HTTP {}: {}", status, body.chars().take(200).collect::<String>()));
    }

    let cf: CfSearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("CurseForge parse error: {}", e))?;

    let hits: Vec<CfHit> = cf.data.into_iter().filter(|m| {
        if loader == "vanilla" && (project_type == "all" || project_type == "mod" || project_type.is_empty()) {
            // Class 6 is Minecraft Mods
            m.class_id != Some(6)
        } else {
            true
        }
    }).map(|m| {
        // Collect unique game versions from the latest files index
        let mut versions: Vec<String> = m.latest_files_indexes
            .iter()
            .map(|f| f.game_version.clone())
            .collect();

        let latest_version = m.latest_files_indexes
            .first()
            .map(|f| f.file_id.to_string());

        // Latest file's human label (e.g. "sodium-fabric-0.5.8") for the
        // Browse card's content-version tag. Free from the search response.
        let version_name = m.latest_files
            .first()
            .map(|f| f.display_name.clone())
            .filter(|s| !s.is_empty());

        // Build categories list. Start with CF's category slugs, then inject
        // loader names derived from the modLoader field in latestFilesIndexes.
        // The frontend uses these to render loader badges on cards.
        let mut categories: Vec<String> = m.categories.into_iter().map(|c| c.slug).collect();
        for fi in &m.latest_files_indexes {
            if let Some(loader_id) = fi.mod_loader {
                let name = match loader_id {
                    1 => "forge",
                    4 => "fabric",
                    5 => "quilt",
                    6 => "neoforge",
                    _ => continue,
                };
                if !categories.contains(&name.to_string()) {
                    categories.push(name.to_string());
                }
            }
        }

        // The compact latestFilesIndexes omits the loader on older files and
        // doesn't always list every supported MC version. The fuller
        // latestFiles[].gameVersions mixes MC versions and loader names
        // (e.g. ["1.8.9","Forge"]); harvest both so old mods like BetterFps
        // get a loader badge and a complete version range.
        for f in &m.latest_files {
            for gv in &f.game_versions {
                let loader = match gv.to_lowercase().as_str() {
                    "forge" => Some("forge"),
                    "fabric" => Some("fabric"),
                    "quilt" => Some("quilt"),
                    "neoforge" => Some("neoforge"),
                    _ => None,
                };
                match loader {
                    Some(name) => {
                        if !categories.contains(&name.to_string()) {
                            categories.push(name.to_string());
                        }
                    }
                    // MC version strings start with a digit (e.g. "1.8.9").
                    None if gv.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
                        versions.push(gv.clone());
                    }
                    None => {}
                }
            }
        }

        versions.sort();
        versions.dedup();

        CfHit {
            project_id: m.id.to_string(),
            slug: m.slug,
            title: m.name,
            description: m.summary,
            icon_url: m.logo.map(|l| {
                if l.thumbnail_url.is_empty() { l.url } else { l.thumbnail_url }
            }).filter(|u| !u.is_empty()),
            downloads: m.download_count,
            follows: m.thumbs_up_count,
            categories,
            versions,
            latest_version,
            version_name,
            author: m.authors.into_iter().next().map(|a| a.name),
            project_type: project_type_from_class_id(m.class_id),
        }
    }).collect();

    Ok(CfSearchResult {
        total_hits: cf.pagination.total_count as u32,
        offset: cf.pagination.index,
        limit: cf.pagination.page_size,
        hits,
    })
}

/// Get file versions for a specific CurseForge project.
pub async fn get_project_files(
    api_key: &str,
    mod_id: &str,
    game_version: &str,
    loader: &str,
) -> Result<Vec<CfFileInfo>, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured.".to_string());
    }

    let mut url = format!("{}/mods/{}/files?pageSize=50", CF_BASE, mod_id);
    if !game_version.is_empty() {
        url.push_str(&format!("&gameVersion={}", urlencoding::encode(game_version)));
    }
    match loader_type_id(loader) {
        Some(loader_id) => url.push_str(&format!("&modLoaderType={}", loader_id)),
        // An empty loader is intentional (loader-agnostic content). A non-empty
        // one we can't map means the server-side filter silently doesn't apply,
        // so every loader's files come back — the caller MUST validate the
        // chosen file's own loader list rather than trusting this response.
        None if !loader.is_empty() => tracing::warn!(
            "No CurseForge modLoaderType for loader '{}'; file list is unfiltered by loader",
            loader
        ),
        None => {}
    }

    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge files fetch failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CurseForge HTTP {}: {}", status, body.chars().take(200).collect::<String>()));
    }

    let wrapper: CfFilesResponse = resp
        .json()
        .await
        .map_err(|e| format!("CurseForge files parse: {}", e))?;

    Ok(wrapper.data.into_iter().map(to_file_info).collect())
}

/// Fetch one file by id: `GET /mods/{modId}/files/{fileId}`.
///
/// Exists because a list query is the wrong tool for resolving a *pinned* file.
/// `get_project_files` applies `gameVersion` / `modLoaderType` server-side and
/// returns a single page of 50, so the set it returns depends on the filters the
/// caller happened to pass. The version picker and the installer don't pass the
/// same ones, which meant a pinned id could be absent from the installer's page
/// and get silently substituted. Addressing the file directly is immune to both
/// the filters and the paging.
pub async fn get_file(
    api_key: &str,
    mod_id: &str,
    file_id: &str,
) -> Result<CfFileInfo, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured.".to_string());
    }
    let url = format!("{}/mods/{}/files/{}", CF_BASE, mod_id, file_id);
    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge file fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "CurseForge HTTP {} when fetching file {}",
            resp.status(),
            file_id
        ));
    }

    #[derive(Deserialize)]
    struct Wrapper {
        data: CfFile,
    }
    let wrapper: Wrapper = resp
        .json()
        .await
        .map_err(|e| format!("CurseForge file parse: {}", e))?;
    Ok(to_file_info(wrapper.data))
}

/// Map CurseForge's file JSON onto the launcher's shape.
///
/// `downloadUrl` is passed through as given. A null (or empty) value means the
/// author opted out of third-party distribution (`allowModDistribution: false`),
/// and callers turn that into a manual download prompt — see
/// `services::manual_download`.
///
/// This used to reconstruct a CDN URL from the numeric file id and fetch it
/// regardless. That circumvented the author's choice, and when CurseForge blocked
/// it the user got a generic retry failure instead of a link they could act on.
fn to_file_info(f: CfFile) -> CfFileInfo {
    // Treat "" the same as null: an empty URL would otherwise reach the
    // downloader and surface as a retry failure rather than the prompt.
    let download_url = f.download_url.clone().filter(|u| !u.trim().is_empty());
    let (mc_versions, loaders) = classify_game_versions(f.game_versions);
    let mut required = Vec::new();
    let mut incompatible = Vec::new();
    for d in f.dependencies {
        match d.relation_type {
            3 => required.push(d.mod_id.to_string()),
            5 => incompatible.push(d.mod_id.to_string()),
            // Embedded / Optional / Tool / Include impose no obligation.
            _ => {}
        }
    }
    CfFileInfo {
        file_id: f.id,
        file_name: f.file_name,
        display_name: f.display_name,
        download_url,
        file_length: f.file_length,
        hashes: f
            .hashes
            .into_iter()
            .filter(|h| h.algo == 1) // SHA-1
            .map(|h| h.value)
            .collect(),
        dependencies: required,
        incompatible,
        release_type: f.release_type,
        file_date: f.file_date,
        game_versions: mc_versions,
        loaders,
        is_available: f.is_available,
    }
}

// ─── File response types ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CfFilesResponse {
    data: Vec<CfFile>,
}

#[derive(Debug, Deserialize)]
struct CfFile {
    id: u64,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(rename = "fileLength")]
    file_length: u64,
    hashes: Vec<CfHash>,
    dependencies: Vec<CfDependency>,
    /// 1 = Release, 2 = Beta, 3 = Alpha. Drives the stable-first preference
    /// when choosing a file; without it an alpha upload wins purely by being
    /// newest.
    #[serde(rename = "releaseType", default)]
    release_type: u32,
    /// ISO-8601 upload timestamp. CurseForge does publish this per file — the
    /// launcher previously didn't read it, which is why update detection fell
    /// back to comparing numeric file ids.
    #[serde(rename = "fileDate", default)]
    file_date: Option<String>,
    /// Mixed bag: Minecraft version strings AND loader names (and sometimes
    /// "Client"/"Server") share this one array. `classify_game_versions` splits
    /// them so a file can actually be validated client-side.
    #[serde(rename = "gameVersions", default)]
    game_versions: Vec<String>,
    /// False when CurseForge is not currently serving the file. Picking one of
    /// these yields a download that can't succeed.
    #[serde(rename = "isAvailable", default = "default_true")]
    is_available: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct CfHash {
    value: String,
    algo: u32, // 1 = SHA-1, 2 = MD5
}

#[derive(Debug, Deserialize)]
struct CfDependency {
    #[serde(rename = "modId")]
    mod_id: u64,
    /// 1 = EmbeddedLibrary, 2 = Optional, 3 = Required, 4 = Tool,
    /// 5 = Incompatible, 6 = Include. Only 3 and 5 carry obligations for us.
    #[serde(rename = "relationType")]
    relation_type: u32,
}

/// Loader names CurseForge mixes into a file's `gameVersions` array. Compared
/// case-insensitively because the casing there ("Fabric", "NeoForge") differs
/// from the launcher's internal lowercase loader ids.
const CF_LOADER_NAMES: [&str; 5] = ["forge", "fabric", "quilt", "neoforge", "liteloader"];

/// Split a file's `gameVersions` into `(minecraft_versions, loaders)`.
///
/// CurseForge has no separate loader field on a file — MC versions, loader
/// names, and occasionally environment tags all share one string array. An
/// entry starting with a digit is a Minecraft version; one matching a known
/// loader name is a loader; anything else is ignored. This deliberately avoids
/// `sortableGameVersions[].gameVersionTypeId`, whose numeric values aren't
/// documented per game and would be a guess.
fn classify_game_versions(raw: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut mc = Vec::new();
    let mut loaders = Vec::new();
    for entry in raw {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with(|c: char| c.is_ascii_digit()) {
            mc.push(trimmed.to_string());
        } else {
            let lower = trimmed.to_ascii_lowercase();
            if CF_LOADER_NAMES.contains(&lower.as_str()) {
                loaders.push(lower);
            }
        }
    }
    (mc, loaders)
}

/// Processed file info ready for the install flow.
#[derive(Debug, Clone)]
pub struct CfFileInfo {
    pub file_id: u64,
    pub file_name: String,
    /// CurseForge's human-readable file label (e.g. "sodium-fabric-0.5.8").
    /// Used as the content version on Installed cards. Empty when absent.
    pub display_name: String,
    pub download_url: Option<String>,
    pub file_length: u64,
    pub hashes: Vec<String>, // SHA-1 only
    pub dependencies: Vec<String>, // mod IDs of required deps
    /// mod IDs this file declares it cannot run alongside (relationType 5).
    pub incompatible: Vec<String>,
    /// 1 = Release, 2 = Beta, 3 = Alpha.
    pub release_type: u32,
    /// ISO-8601 upload timestamp, when CurseForge supplied one.
    pub file_date: Option<String>,
    /// Minecraft versions this file declares, split out of `gameVersions`.
    pub game_versions: Vec<String>,
    /// Loaders this file declares, lowercased. Empty for loader-agnostic
    /// content and for older uploads that never tagged one.
    pub loaders: Vec<String>,
    /// Whether CurseForge is currently serving this file.
    pub is_available: bool,
}

// ─── Modpack install from project ID ────────────────────────────────────

/// Complete project metadata fetched from CurseForge's mod endpoint.
#[derive(Debug, Clone, Default)]
pub struct ProjectMeta {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub icon_url: Option<String>,
    pub author: Option<String>,
    pub class_id: Option<u32>,
    pub website_url: Option<String>,
}

fn parse_project_meta_item(item: &serde_json::Value) -> ProjectMeta {
    let name = item.get("name").and_then(|n| n.as_str()).map(str::to_string);
    let summary = item.get("summary").and_then(|s| s.as_str()).map(str::to_string);
    let website_url = item
        .get("links")
        .and_then(|l| l.get("websiteUrl"))
        .and_then(|u| u.as_str())
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    let class_id = item.get("classId").and_then(|c| c.as_u64()).map(|c| c as u32);
    let author = item
        .get("authors")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .map(str::to_string);
    let icon_url = item.get("logo").and_then(|l| {
        let thumb = l.get("thumbnailUrl").and_then(|u| u.as_str()).unwrap_or_default();
        let regular = l.get("url").and_then(|u| u.as_str()).unwrap_or_default();
        let chosen = if !thumb.is_empty() { thumb } else { regular };
        if chosen.is_empty() {
            None
        } else {
            Some(chosen.to_string())
        }
    });

    ProjectMeta {
        name,
        summary,
        icon_url,
        author,
        class_id,
        website_url,
    }
}

/// Batch-fetch complete project metadata for many mod IDs in one request.
/// Uses the batch `POST /v1/mods` endpoint (up to 50 IDs per batch).
pub async fn fetch_projects_meta(
    api_key: &str,
    mod_ids: &[String],
) -> std::collections::HashMap<String, ProjectMeta> {
    use std::collections::HashMap;
    let mut out: HashMap<String, ProjectMeta> = HashMap::new();
    if api_key.is_empty() || mod_ids.is_empty() {
        return out;
    }

    for chunk in mod_ids.chunks(50) {
        let ids: Vec<u64> = chunk.iter().filter_map(|s| s.parse::<u64>().ok()).collect();
        if ids.is_empty() {
            continue;
        }
        let resp = HTTP
            .post(format!("{}/mods", CF_BASE))
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "modIds": ids }))
            .send()
            .await;
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(list) = body.get("data").and_then(|d| d.as_array()) else {
            continue;
        };
        for item in list {
            let Some(id) = item.get("id").and_then(|i| i.as_u64()) else {
                continue;
            };
            out.insert(id.to_string(), parse_project_meta_item(item));
        }
    }
    out
}

/// Fetch project metadata for one CurseForge project ID.
pub async fn fetch_project_meta(
    api_key: &str,
    mod_id: &str,
) -> ProjectMeta {
    let mut batch = fetch_projects_meta(api_key, &[mod_id.to_string()]).await;
    if let Some(meta) = batch.remove(mod_id) {
        return meta;
    }

    // Fallback: single GET endpoint if not returned in batch
    let url = format!("{}/mods/{}", CF_BASE, mod_id);
    let resp = match HTTP.get(&url).header("x-api-key", api_key).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return ProjectMeta::default(),
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return ProjectMeta::default(),
    };
    let data = body.get("data").unwrap_or(&body);
    parse_project_meta_item(data)
}

/// Brief project info for one CurseForge id: `(name, website_url)`.
pub async fn fetch_project_brief(
    api_key: &str,
    mod_id: &str,
) -> (Option<String>, Option<String>) {
    let meta = fetch_project_meta(api_key, mod_id).await;
    (meta.name, meta.website_url)
}

/// Same as `fetch_project_brief` for many ids in one request.
pub async fn fetch_projects_brief(
    api_key: &str,
    mod_ids: &[String],
) -> std::collections::HashMap<String, (Option<String>, Option<String>)> {
    let metas = fetch_projects_meta(api_key, mod_ids).await;
    metas.into_iter().map(|(id, m)| (id, (m.name, m.website_url))).collect()
}

/// Resolved CurseForge mod and file metadata from a Murmur2 fingerprint match.
#[derive(Debug, Clone)]
pub struct CfFingerprintMatch {
    pub mod_id: String,
    pub file_id: String,
    pub display_name: Option<String>,
}

/// Computes CurseForge's whitespace-stripped 32-bit MurmurHash2 (seed = 1) for a file buffer.
pub fn compute_cf_fingerprint(bytes: &[u8]) -> u32 {
    const M: u32 = 0x5bd1e995;
    let len = bytes
        .iter()
        .filter(|&&b| b != 9 && b != 10 && b != 13 && b != 32)
        .count() as u32;

    let mut h: u32 = 1 ^ len;
    let mut k: u32 = 0;
    let mut shift: u32 = 0;

    for &b in bytes {
        if b == 9 || b == 10 || b == 13 || b == 32 {
            continue;
        }
        k |= (b as u32) << shift;
        shift += 8;
        if shift == 32 {
            k = k.wrapping_mul(M);
            k ^= k >> 24;
            k = k.wrapping_mul(M);
            h = h.wrapping_mul(M) ^ k;
            k = 0;
            shift = 0;
        }
    }

    if shift > 0 {
        h ^= k;
        h = h.wrapping_mul(M);
    }

    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h
}

/// Batch-resolves Murmur2 file fingerprints against `POST /v1/fingerprints/432`.
/// Returns a map from `fingerprint (u32)` -> `CfFingerprintMatch`.
pub async fn match_fingerprints(
    api_key: &str,
    fingerprints: &[u32],
) -> std::collections::HashMap<u32, CfFingerprintMatch> {
    let mut out = std::collections::HashMap::new();
    if api_key.is_empty() || fingerprints.is_empty() {
        return out;
    }

    let url = format!("{}/fingerprints/{}", CF_BASE, MINECRAFT_GAME_ID);
    let payload = serde_json::json!({ "fingerprints": fingerprints });

    let resp = match HTTP
        .post(&url)
        .header("x-api-key", api_key)
        .json(&payload)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return out,
    };

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return out,
    };

    if let Some(matches) = body
        .get("data")
        .and_then(|d| d.get("exactMatches"))
        .and_then(|m| m.as_array())
    {
        for item in matches {
            let mod_id = item
                .get("id")
                .and_then(|v| v.as_u64())
                .map(|n| n.to_string());
            let file_obj = item.get("file");
            let file_id = file_obj
                .and_then(|f| f.get("id"))
                .and_then(|v| v.as_u64())
                .map(|n| n.to_string());
            let fp = file_obj
                .and_then(|f| f.get("fileFingerprint"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let display_name = file_obj
                .and_then(|f| f.get("displayName"))
                .and_then(|v| v.as_str())
                .map(str::to_string);

            if let (Some(fp_val), Some(mid), Some(fid)) = (fp, mod_id, file_id) {
                out.insert(
                    fp_val,
                    CfFingerprintMatch {
                        mod_id: mid,
                        file_id: fid,
                        display_name,
                    },
                );
            }
        }
    }

    out
}

/// Fetch the download URL for the latest (or specified) file of a CurseForge
/// modpack project. Returns `(download_url, file_name)`.
///
/// `download_url` is `None` when the author opted out of third-party
/// distribution. That's not an error here — the caller turns it into a manual
/// download prompt, which needs the file name to tell the user what to look for.
pub async fn get_modpack_file_url(
    api_key: &str,
    project_id: &str,
    file_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured. Add it in Settings.".to_string());
    }

    let is_numeric_file_id = file_id
        .map(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false);

    let url = if let (true, Some(fid)) = (is_numeric_file_id, file_id) {
        format!("{}/mods/{}/files/{}", CF_BASE, project_id, fid)
    } else {
        // Fetch recent files so we can match a version string (e.g. "8.2") or fall back to latest
        format!("{}/mods/{}/files?pageSize=50", CF_BASE, project_id)
    };

    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge file fetch failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "CurseForge HTTP {} when fetching modpack file: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse CurseForge file response: {}", e))?;

    // Single file endpoint returns { data: { ... } }
    // List endpoint returns { data: [ ... ] }
    let file_data = if is_numeric_file_id {
        body.get("data").cloned()
    } else {
        let arr_opt = body.get("data").and_then(|d| d.as_array());
        if let (Some(arr), Some(ver_str)) = (arr_opt, file_id) {
            let needle = ver_str.trim().to_lowercase();
            arr.iter()
                .find(|item| {
                    let disp = item
                        .get("displayName")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let fname = item
                        .get("fileName")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    disp.contains(&needle) || fname.contains(&needle)
                })
                .or_else(|| arr.first())
                .cloned()
        } else {
            arr_opt.and_then(|arr| arr.first()).cloned()
        }
    };

    let file_data = file_data.ok_or("No file data returned from CurseForge")?;

    // Absent (or JSON null) means the author disabled third-party downloads.
    let download_url = file_data
        .get("downloadUrl")
        .and_then(|u| u.as_str())
        .filter(|u| !u.is_empty())
        .map(str::to_string);

    let file_name = file_data
        .get("fileName")
        .and_then(|n| n.as_str())
        .unwrap_or("modpack.zip")
        .to_string();

    Ok((download_url, file_name))
}

#[cfg(test)]
mod tests {
    use super::classify_game_versions;

    /// CurseForge puts Minecraft versions, loader names, and environment tags in
    /// one array. Everything downstream that validates a file depends on this
    /// split being right — mistaking "Fabric" for a game version, or "1.21.1"
    /// for a loader, breaks compatibility checking in opposite directions.
    #[test]
    fn splits_minecraft_versions_from_loader_names() {
        let (mc, loaders) = classify_game_versions(vec![
            "1.21.1".to_string(),
            "Fabric".to_string(),
            "1.21".to_string(),
            "NeoForge".to_string(),
            // Environment tags belong to neither and must be dropped.
            "Client".to_string(),
            "Server".to_string(),
        ]);
        assert_eq!(mc, vec!["1.21.1", "1.21"]);
        assert_eq!(loaders, vec!["fabric", "neoforge"]);
    }

    /// Loader names are lowercased so they compare against the launcher's
    /// internal loader ids without per-call case handling.
    #[test]
    fn loader_names_are_normalized_to_lowercase() {
        let (_, loaders) = classify_game_versions(vec!["FORGE".to_string(), "Quilt".to_string()]);
        assert_eq!(loaders, vec!["forge", "quilt"]);
    }

    #[test]
    fn blank_entries_are_ignored() {
        let (mc, loaders) = classify_game_versions(vec!["".to_string(), "   ".to_string()]);
        assert!(mc.is_empty());
        assert!(loaders.is_empty());
    }
}
