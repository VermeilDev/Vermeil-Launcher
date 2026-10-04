// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::{Deserialize, Serialize};

const MODRINTH_API: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthSearchResult {
    pub hits: Vec<ModrinthProject>,
    pub total_hits: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthProject {
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
    pub project_type: String,
    /// Human-readable latest version label (Modrinth `version_number`), shown
    /// as the content version on Browse cards. Not in the search response —
    /// filled in by a single batched `/v2/versions?ids=` call per page.
    #[serde(default)]
    pub version_name: Option<String>,
    /// Username of the project's primary author (Modrinth's `author` field
    /// in search hits — populated for /search responses, NOT for
    /// /project/{id} where it's named `team` instead).
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub client_side: Option<String>,
    #[serde(default)]
    pub server_side: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub files: Vec<ModrinthFile>,
    pub dependencies: Vec<ModrinthDependency>,
    /// ISO 8601 timestamp when this version was published. Used to decide
    /// "newer than installed" for the update detector.
    #[serde(default)]
    pub date_published: Option<String>,
    /// Release channel: `"release"`, `"beta"`, or `"alpha"`. Drives the
    /// stable-first preference in `find_preferred_version` — without it an
    /// alpha build published after the latest stable would always win.
    /// Optional so a malformed/absent value degrades to "unknown channel"
    /// rather than failing the whole version list parse.
    #[serde(default)]
    pub version_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthFile {
    pub url: String,
    pub filename: String,
    pub hashes: ModrinthHashes,
    pub size: u64,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthHashes {
    pub sha1: Option<String>,
    pub sha512: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthDependency {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub dependency_type: String,
}

pub(crate) async fn resolve_modrinth_token() -> Option<String> {
    crate::services::settings_service::load().await.ok().and_then(|s| {
        let t = s.modrinth_token.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    })
}

pub(crate) fn build_search_facets(project_type: &str, loader: &str, game_version: &str) -> String {
    let clean_version = game_version.trim().trim_end_matches('.');
    let has_version = !clean_version.is_empty();

    if loader == "vanilla" {
        match project_type {
            "all" | "" => {
                if has_version {
                    format!(
                        "[[\"project_type:resourcepack\", \"categories:datapack\"], [\"versions:{}\"]]",
                        clean_version
                    )
                } else {
                    "[[\"project_type:resourcepack\", \"categories:datapack\"]]".to_string()
                }
            }
            "resourcepack" => {
                if has_version {
                    format!("[[\"versions:{}\"], [\"project_type:resourcepack\"]]", clean_version)
                } else {
                    "[[\"project_type:resourcepack\"]]".to_string()
                }
            }
            "datapack" => {
                if has_version {
                    format!("[[\"versions:{}\"], [\"categories:datapack\"]]", clean_version)
                } else {
                    "[[\"categories:datapack\"]]".to_string()
                }
            }
            _ => "[]".to_string(),
        }
    } else {
        match project_type {
            "all" | "" => {
                let mut facets = Vec::new();
                if loader != "all" && !loader.is_empty() {
                    let loader_part = if loader == "quilt" {
                        "\"categories:quilt\", \"categories:fabric\", "
                    } else {
                        &format!("\"categories:{}\", ", loader)
                    };
                    facets.push(format!(
                        "[{} \"project_type:resourcepack\", \"project_type:shader\", \"categories:datapack\"]",
                        loader_part
                    ));
                }
                if has_version {
                    facets.push(format!("[\"versions:{}\"]", clean_version));
                }
                if facets.is_empty() {
                    "[]".to_string()
                } else {
                    format!("[{}]", facets.join(", "))
                }
            }
            "mod" => {
                let mut facets = vec!["[\"project_type:mod\"]".to_string()];
                if loader != "all" && !loader.is_empty() {
                    if loader == "quilt" {
                        facets.push("[\"categories:quilt\", \"categories:fabric\"]".to_string());
                    } else {
                        facets.push(format!("[\"categories:{}\"]", loader));
                    }
                }
                if has_version {
                    facets.push(format!("[\"versions:{}\"]", clean_version));
                }
                format!("[{}]", facets.join(", "))
            }
            "datapack" => {
                if has_version {
                    format!("[[\"versions:{}\"], [\"categories:datapack\"]]", clean_version)
                } else {
                    "[[\"categories:datapack\"]]".to_string()
                }
            }
            _ => {
                // "resourcepack", "shader"
                if has_version {
                    format!("[[\"versions:{}\"], [\"project_type:{}\"]]", clean_version, project_type)
                } else {
                    format!("[[\"project_type:{}\"]]", project_type)
                }
            }
        }
    }
}

/// Search on Modrinth, filtered by loader and game version
pub async fn search_mods(
    query: &str,
    loader: &str,
    game_version: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    project_type: &str,
) -> Result<ModrinthSearchResult, String> {
    if loader == "vanilla" && (project_type == "mod" || project_type == "shader") {
        return Ok(ModrinthSearchResult {
            hits: vec![],
            offset,
            limit,
            total_hits: 0,
        });
    }

    let facets = build_search_facets(project_type, loader, game_version);

    let url = format!(
        "{}/search?query={}&facets={}&offset={}&limit={}&index={}",
        MODRINTH_API,
        urlencoding::encode(query),
        urlencoding::encode(&facets),
        offset,
        limit,
        sort
    );

    let token = resolve_modrinth_token().await;
    let resp = crate::util::http::send_with_retry(|| {
        let mut req = crate::util::http::HTTP.get(&url);
        if let Some(ref t) = token {
            req = req.header("Authorization", t);
        }
        req
    })
    .await
    .map_err(|e| format!("Modrinth search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    let mut result = resp
        .json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth search: {}", e))?;
    attach_version_names(&mut result).await;
    Ok(result)
}

/// Fetch multiple versions by id in one batched call
/// (`GET /v2/versions?ids=[...]`). Best-effort: returns an empty map on any
/// failure so search degrades gracefully (cards just omit the version tag).
pub async fn get_versions_by_ids(ids: &[String]) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    if ids.is_empty() {
        return HashMap::new();
    }
    let ids_json = serde_json::to_string(ids).unwrap_or_default();
    let url = format!(
        "{}/versions?ids={}",
        MODRINTH_API,
        urlencoding::encode(&ids_json)
    );
    let token = resolve_modrinth_token().await;
    let resp = match crate::util::http::send_with_retry(|| {
        let mut req = crate::util::http::HTTP.get(&url);
        if let Some(ref t) = token {
            req = req.header("Authorization", t);
        }
        req
    }).await {
        Ok(r) if r.status().is_success() => r,
        _ => return HashMap::new(),
    };
    match resp.json::<Vec<ModrinthVersion>>().await {
        Ok(versions) => versions
            .into_iter()
            .map(|v| (v.id, v.version_number))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

/// Attach a human version label to each search hit by batch-resolving the
/// hits' `latest_version` ids. One extra API call per page; best-effort.
async fn attach_version_names(result: &mut ModrinthSearchResult) {
    let ids: Vec<String> = result
        .hits
        .iter()
        .filter_map(|h| h.latest_version.clone())
        .collect();
    if ids.is_empty() {
        return;
    }
    let map = get_versions_by_ids(&ids).await;
    if map.is_empty() {
        return;
    }
    for h in &mut result.hits {
        if let Some(vid) = &h.latest_version {
            h.version_name = map.get(vid).cloned();
        }
    }
}

/// Search modpacks on Modrinth
pub async fn search_modpacks(
    query: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    loader: &str,
    game_version: &str,
) -> Result<ModrinthSearchResult, String> {
    // Build facets: always filter to modpacks, optionally filter by loader and game version
    let clean_version = game_version.trim().trim_end_matches('.');
    let mut facet_parts = vec!["[\"project_type:modpack\"]".to_string()];
    if !loader.is_empty() {
        facet_parts.push(format!("[\"categories:{}\"]", loader));
    }
    if !clean_version.is_empty() {
        facet_parts.push(format!("[\"versions:{}\"]", clean_version));
    }
    let facets = format!("[{}]", facet_parts.join(","));

    let url = format!(
        "{}/search?query={}&facets={}&offset={}&limit={}&index={}",
        MODRINTH_API,
        urlencoding::encode(query),
        urlencoding::encode(&facets),
        offset,
        limit,
        sort
    );

    let token = resolve_modrinth_token().await;
    let resp = crate::util::http::send_with_retry(|| {
        let mut req = crate::util::http::HTTP.get(&url);
        if let Some(ref t) = token {
            req = req.header("Authorization", t);
        }
        req
    })
    .await
    .map_err(|e| format!("Modrinth modpack search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    let mut result = resp
        .json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth modpacks: {}", e))?;
    attach_version_names(&mut result).await;
    Ok(result)
}

/// Get versions for a specific project (to find the right file to download)
pub async fn get_project_versions(
    project_id: &str,
    loader: &str,
    game_version: &str,
) -> Result<Vec<ModrinthVersion>, String> {
    // Build query params lazily so empty filters drop out — Modrinth treats
    // `game_versions=[""]` as a literal empty-string filter and returns nothing,
    // which broke fallback fetches that wanted the project's full version list.
    //
    // `include_changelog=false` is always sent: the endpoint defaults it to
    // true, so every call was pulling the full changelog text of every version.
    // We never read the changelog, and this endpoint runs once per mod on every
    // install and every update check — on a rate-limited API that payload is
    // pure waste.
    let mut params: Vec<String> = vec!["include_changelog=false".to_string()];
    if !loader.is_empty() {
        params.push(format!("loaders=[\"{}\"]", loader));
    }
    if !game_version.is_empty() {
        params.push(format!("game_versions=[\"{}\"]", game_version));
    }
    let url = format!(
        "{}/project/{}/version?{}",
        MODRINTH_API,
        project_id,
        params.join("&")
    );

    let token = resolve_modrinth_token().await;
    let mut req = crate::util::http::HTTP.get(&url);
    if let Some(ref t) = token {
        req = req.header("Authorization", t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Modrinth versions failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth versions error: {}", text));
    }

    resp.json::<Vec<ModrinthVersion>>()
        .await
        .map_err(|e| format!("Parse Modrinth versions: {}", e))
}

/// Bulk lookup Modrinth versions by file SHA-1 hashes (up to 1,000 hashes per request).
pub async fn get_versions_by_hashes(
    hashes: &[String],
) -> Result<std::collections::HashMap<String, ModrinthVersion>, String> {
    if hashes.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let url = format!("{}/version_files", MODRINTH_API);
    let body = serde_json::json!({
        "hashes": hashes,
        "algorithm": "sha1"
    });

    let token = resolve_modrinth_token().await;
    let mut req = crate::util::http::HTTP.post(&url).json(&body);
    if let Some(ref t) = token {
        req = req.header("Authorization", t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Modrinth version_files failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth version_files error: {}", text));
    }

    resp.json::<std::collections::HashMap<String, ModrinthVersion>>()
        .await
        .map_err(|e| format!("Parse Modrinth version_files response: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_hashes_returns_empty_map_without_network() {
        let result = get_versions_by_hashes(&[]).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn known_sha1_resolves_exact_version_file() {
        // Entity Culling 1.11.1 Forge for 1.20.1
        let sha1 = "0932b2cf25d7667abbaab4f1859435adc5480621";
        let result = get_versions_by_hashes(&[sha1.to_string()]).await;
        // Modrinth API / Cloudflare WAF may block CI runner IPs (HTTP 403) or rate-limit.
        // If the live request succeeds, assert the deserialized metadata format.
        if let Ok(map) = result {
            assert!(map.contains_key(sha1), "Map should contain requested SHA-1");
            let version = &map[sha1];
            assert_eq!(version.version_number, "1.11.1");
            assert!(version.loaders.contains(&"forge".to_string()));
            assert!(version.game_versions.contains(&"1.20.1".to_string()));
            assert!(version.files.iter().any(|f| f.filename == "entityculling-forge-1.11.1-mc1.20.1.jar"));
        }
    }

    #[test]
    fn test_build_search_facets_sanitizes_trailing_dots() {
        // Trailing dots (e.g. typing "1." or "1.20.") break Meilisearch numeric parsing with EOF error.
        // build_search_facets must trim them or omit when empty.
        let facets_dot = build_search_facets("resourcepack", "fabric", "1.");
        assert_eq!(facets_dot, "[[\"versions:1\"], [\"project_type:resourcepack\"]]");

        let facets_partial_version = build_search_facets("shader", "fabric", "1.20.");
        assert_eq!(facets_partial_version, "[[\"versions:1.20\"], [\"project_type:shader\"]]");

        let facets_empty_dot = build_search_facets("resourcepack", "fabric", ".");
        assert_eq!(facets_empty_dot, "[[\"project_type:resourcepack\"]]");

        let facets_empty = build_search_facets("resourcepack", "fabric", "");
        assert_eq!(facets_empty, "[[\"project_type:resourcepack\"]]");

        let facets_valid = build_search_facets("shader", "fabric", "1.20.1");
        assert_eq!(facets_valid, "[[\"versions:1.20.1\"], [\"project_type:shader\"]]");
    }
}


