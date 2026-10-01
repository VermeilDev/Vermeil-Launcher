// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::meta;
use serde::Serialize;

#[derive(Serialize)]
pub struct GameVersionInfo {
    pub id: String,
    pub version_type: String,
    pub release_time: String,
}

#[tauri::command]
pub async fn get_game_versions(include_snapshots: bool) -> Result<Vec<GameVersionInfo>, String> {
    let manifest = meta::get_version_manifest(false).await?;

    let versions: Vec<GameVersionInfo> = manifest
        .versions
        .into_iter()
        .filter(|v| include_snapshots || v.version_type == "release")
        .map(|v| GameVersionInfo {
            id: v.id,
            version_type: v.version_type,
            release_time: v.release_time,
        })
        .collect();

    Ok(versions)
}

#[derive(Serialize)]
pub struct FabricVersionInfo {
    pub version: String,
    pub stable: bool,
}

#[tauri::command]
pub async fn get_fabric_loader_versions() -> Result<Vec<FabricVersionInfo>, String> {
    let versions = meta::get_fabric_versions().await?;

    Ok(versions
        .into_iter()
        .map(|v| FabricVersionInfo {
            version: v.version,
            stable: v.stable,
        })
        .collect())
}

#[derive(Serialize)]
pub struct NewsArticle {
    pub title: String,
    /// Patch-note version (e.g. `26.2-snapshot-8`). Empty for general news
    /// articles, which have no version.
    pub version: String,
    /// ISO-8601 publish date from the feed. Both the patch-notes feed
    /// (`...T15:39:47Z`) and the news feed (`2024-01-16`) carry one.
    pub date: String,
    pub image_url: String,
    pub url: String,
    /// `contentPath` for in-app patch notes; empty for general news (which
    /// open externally via `url`).
    pub body: String,
    /// Short plain-text summary. Patch notes carry a `shortText`; general news
    /// carries `text`. Shown in the reader when there's no in-app HTML body
    /// (general news) or as a fallback if the body fetch fails.
    pub excerpt: String,
}

#[tauri::command]
pub async fn get_java_news() -> Result<Vec<NewsArticle>, String> {
    // Two official Mojang launcher feeds make up "Java Edition News":
    //   • javaPatchNotes.json — snapshot/release patch notes (rich in-app body)
    //   • news.json — general Minecraft news (articles open on minecraft.net)
    // We fetch both concurrently and merge. If only one responds we still
    // return what we got, so a hiccup on one feed never blanks the section.
    let (patch, news) = tokio::join!(fetch_patch_notes(), fetch_general_news());

    let mut articles: Vec<NewsArticle> = Vec::new();
    let mut had_ok = false;
    match patch {
        Ok(mut v) => { had_ok = true; articles.append(&mut v); }
        Err(e) => tracing::warn!("Patch-notes feed failed: {}", e),
    }
    match news {
        Ok(mut v) => { had_ok = true; articles.append(&mut v); }
        Err(e) => tracing::warn!("News feed failed: {}", e),
    }
    if !had_ok {
        return Err("Both Mojang news feeds were unreachable.".to_string());
    }

    // Newest first. Both feeds use ISO-8601, which sorts correctly as plain
    // strings (date-only entries sort just before same-day timestamped ones,
    // which is acceptable for display ordering).
    articles.sort_by(|a, b| b.date.cmp(&a.date));

    Ok(articles)
}

/// Fetch and map the Java patch-notes feed (snapshots + releases).
async fn fetch_patch_notes() -> Result<Vec<NewsArticle>, String> {
    let resp = crate::util::http::HTTP
        .get("https://launchercontent.mojang.com/v2/javaPatchNotes.json")
        .send()
        .await
        .map_err(|e| format!("News fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("News HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct PatchNotes { entries: Vec<PatchEntry> }
    #[derive(serde::Deserialize)]
    struct PatchEntry {
        title: String,
        version: String,
        image: PatchImage,
        #[serde(default)]
        date: String,
        #[serde(rename = "shortText", default)]
        short_text: String,
        #[serde(rename = "contentPath")] content_path: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct PatchImage { url: String }

    let data: PatchNotes = resp.json().await.map_err(|e| format!("Parse news: {}", e))?;

    Ok(data.entries.iter().map(|e| {
        NewsArticle {
            title: e.title.clone(),
            version: e.version.clone(),
            date: e.date.clone(),
            image_url: format!("https://launchercontent.mojang.com{}", e.image.url),
            // Canonical minecraft.net article URL, rebuilt from the version
            // (confirmed live patterns — see `patch_note_url`).
            url: patch_note_url(&e.version),
            body: e.content_path.clone().unwrap_or_default(),
            excerpt: e.short_text.clone(),
        }
    }).collect())
}

/// Build the canonical minecraft.net article URL for a patch-note version.
///
/// Confirmed against live minecraft.net URLs:
///   26.2            → minecraft-java-edition-26-2          (full release)
///   26.2-snapshot-8 → minecraft-26-2-snapshot-8           (snapshot)
///   26.2-rc-1       → minecraft-26-2-release-candidate-1  (release candidate)
///   26.2-pre-6      → minecraft-26-2-pre-release-6        (pre-release)
///
/// Full releases use the `minecraft-java-edition-` prefix; every pre-release
/// kind (snapshot/rc/pre) uses the plain `minecraft-` prefix. `-rc-`/`-pre-`
/// expand to their long forms; snapshots keep their short form. Dots become
/// dashes throughout.
fn patch_note_url(version: &str) -> String {
    let is_prerelease =
        version.contains("snapshot") || version.contains("-pre-") || version.contains("-rc-");
    let slug = version
        .replace("-rc-", "-release-candidate-")
        .replace("-pre-", "-pre-release-")
        .replace('.', "-");
    let prefix = if is_prerelease { "minecraft-" } else { "minecraft-java-edition-" };
    format!("https://www.minecraft.net/en-us/article/{}{}", prefix, slug)
}

/// Fetch the general Minecraft news feed and keep only Java Edition articles.
/// These have no in-app body — clicking them opens `readMoreLink` externally.
async fn fetch_general_news() -> Result<Vec<NewsArticle>, String> {
    let resp = crate::util::http::HTTP
        .get("https://launchercontent.mojang.com/v2/news.json")
        .send()
        .await
        .map_err(|e| format!("News fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("News HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct NewsFeed { entries: Vec<NewsEntry> }
    #[derive(serde::Deserialize)]
    struct NewsEntry {
        title: String,
        #[serde(default)]
        category: String,
        #[serde(default)]
        date: String,
        #[serde(default)]
        text: String,
        #[serde(rename = "readMoreLink", default)]
        read_more_link: String,
        #[serde(rename = "newsType", default)]
        news_type: Vec<String>,
        #[serde(rename = "newsPageImage")]
        news_page_image: Option<NewsImage>,
        #[serde(rename = "playPageImage")]
        play_page_image: Option<NewsImage>,
    }
    #[derive(serde::Deserialize)]
    struct NewsImage { url: String }

    let data: NewsFeed = resp.json().await.map_err(|e| format!("Parse news: {}", e))?;

    Ok(data.entries.into_iter().filter_map(|e| {
        // Java Edition only — the feed is mostly Bedrock/Marketplace promos that
        // don't belong under "Java Edition News". Keep anything tagged "Java" or
        // categorised as Java Edition.
        let is_java = e.news_type.iter().any(|t| t.eq_ignore_ascii_case("java"))
            || e.category == "Minecraft: Java Edition";
        if !is_java {
            return None;
        }
        // Skip anything without a working external link — a card you can't open
        // is worse than no card.
        if e.read_more_link.is_empty() {
            return None;
        }
        let image_path = e.news_page_image.or(e.play_page_image).map(|i| i.url)?;
        Some(NewsArticle {
            title: e.title,
            version: String::new(),
            date: e.date,
            image_url: format!("https://launchercontent.mojang.com{}", image_path),
            url: e.read_more_link,
            body: String::new(),
            excerpt: e.text,
        })
    }).collect())
}

#[tauri::command]
pub async fn get_article_body(content_url: String) -> Result<String, String> {
    if content_url.is_empty() {
        return Ok(String::new());
    }

    // contentPath is like "javaPatchNotes/abc123.json" — needs /v2/ prefix
    let url = if content_url.starts_with("http") {
        content_url
    } else {
        format!("https://launchercontent.mojang.com/v2/{}", content_url)
    };

    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Fetch article failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(String::new());
    }

    let body = resp.text().await.map_err(|e| format!("Read article: {}", e))?;

    // Mojang returns `{"body": "<html content>"}` for v2 patch notes; older
    // entries are raw HTML. Pull the HTML out either way.
    let raw_html = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        parsed
            .get("body")
            .and_then(|b| b.as_str())
            .map(|s| s.to_string())
            .unwrap_or(body)
    } else {
        body
    };

    // Sanitize before sending to the webview. The frontend renders this via
    // `innerHTML`, so anything we let through becomes live DOM. Even though
    // the source is Mojang's CDN, treating it as untrusted means a CDN
    // compromise (or an attacker tricking us into fetching a different URL)
    // can't pivot into invoking Tauri commands. `ammonia` strips <script>,
    // <iframe>, on*= handlers, javascript:/data:/vbscript: URLs, and any
    // other XSS vectors not on its allow-list.
    Ok(ammonia::clean(&raw_html))
}

#[tauri::command]
pub async fn get_quilt_loader_versions() -> Result<Vec<FabricVersionInfo>, String> {
    let resp = crate::util::http::HTTP
        .get("https://meta.quiltmc.org/v3/versions/loader")
        .send()
        .await
        .map_err(|e| format!("Quilt versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Quilt meta HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct QuiltVersion { version: String }

    let versions: Vec<QuiltVersion> = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
    Ok(versions
        .iter()
        .map(|v| FabricVersionInfo {
            stable: !v.version.contains("beta") && !v.version.contains("alpha"),
            version: v.version.clone(),
        })
        .collect())
}

#[tauri::command]
pub async fn get_fabric_game_versions() -> Result<Vec<String>, String> {
    // Fetch modern Fabric supported game versions
    let mut versions: Vec<String> = Vec::new();

    if let Ok(resp) = crate::util::http::HTTP.get("https://meta.fabricmc.net/v2/versions/game")
        .send().await {
        if resp.status().is_success() {
            #[derive(serde::Deserialize)]
            struct GameVer { version: String }
            if let Ok(list) = resp.json::<Vec<GameVer>>().await {
                for v in list { versions.push(v.version); }
            }
        }
    }

    // Fetch Legacy Fabric supported game versions
    if let Ok(resp) = crate::util::http::HTTP.get("https://meta.legacyfabric.net/v2/versions/game")
        .send().await {
        if resp.status().is_success() {
            #[derive(serde::Deserialize)]
            struct GameVer { version: String }
            if let Ok(list) = resp.json::<Vec<GameVer>>().await {
                for v in list {
                    if !versions.contains(&v.version) {
                        versions.push(v.version);
                    }
                }
            }
        }
    }

    Ok(versions)
}

#[tauri::command]
pub async fn get_neoforge_versions(game_version: String) -> Result<Vec<FabricVersionInfo>, String> {
    // NeoForge versions are tied to MC version. Format: MC_VERSION-LOADER_VERSION (e.g., "21.4.1" for MC 1.21.4)
    let resp = crate::util::http::HTTP
        .get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        .send()
        .await
        .map_err(|e| format!("NeoForge versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("NeoForge maven HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct MavenVersions { versions: Vec<String> }

    let data: MavenVersions = resp.json().await.map_err(|e| format!("Parse: {}", e))?;

    // Filter versions that match the game version
    // NeoForge versions for MC 1.21.4 start with "21.4." , for MC 26.1.2 start with "26.1."
    let mc_prefix = if game_version.starts_with("1.") {
        // 1.21.4 -> "21.4"
        let parts: Vec<&str> = game_version.split('.').collect();
        if parts.len() >= 3 { format!("{}.{}", parts[1], parts[2]) }
        else if parts.len() == 2 { format!("{}.", parts[1]) }
        else { game_version.clone() }
    } else {
        // 26.1.2 -> "26.1"
        let parts: Vec<&str> = game_version.split('.').collect();
        if parts.len() >= 2 { format!("{}.{}", parts[0], parts[1]) }
        else { game_version.clone() }
    };

    let filtered: Vec<FabricVersionInfo> = data.versions.iter()
        .filter(|v| v.starts_with(&mc_prefix))
        .rev() // Latest first
        .take(20)
        .map(|v| {
            let lower = v.to_lowercase();
            FabricVersionInfo {
                version: v.clone(),
                stable: !lower.contains("beta") && !lower.contains("alpha"),
            }
        })
        .collect();

    Ok(filtered)
}

/// Returns the list of MC versions that NeoForge supports, derived from available NeoForge versions.
#[tauri::command]
pub async fn get_neoforge_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP
        .get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        .send()
        .await
        .map_err(|e| format!("NeoForge versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("NeoForge maven HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct MavenVersions { versions: Vec<String> }

    let data: MavenVersions = resp.json().await.map_err(|e| format!("Parse: {}", e))?;

    // Extract unique MC versions from NeoForge version numbers.
    // NeoForge "20.2.86" → MC 1.20.2, "21.4.1" → MC 1.21.4, "26.1.2" → MC 26.1.2
    let mut mc_versions: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for v in &data.versions {
        let parts: Vec<&str> = v.split('.').collect();
        if parts.len() < 2 { continue; }

        // Skip snapshot/special versions like "0.25w14craftmine.3-beta"
        let major: u32 = match parts[0].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if major == 0 { continue; }

        let minor: u32 = match parts[1].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };

        // Convert NeoForge prefix to MC version
        let mc_ver = if major >= 26 {
            // New MC format: 26.1.x → MC 26.1.2 (but we just need major.minor)
            // Actually for new format, NeoForge version IS the MC version prefix
            format!("{}.{}", major, minor)
        } else {
            // Old MC format: 20.2.x → MC 1.20.2, 21.4.x → MC 1.21.4
            format!("1.{}.{}", major, minor)
        };

        if seen.insert(mc_ver.clone()) {
            mc_versions.push(mc_ver);
        }
    }

    // Sort descending (newest first)
    mc_versions.sort_by(|a, b| {
        let a_parts: Vec<u32> = a.split('.').filter_map(|p| p.parse().ok()).collect();
        let b_parts: Vec<u32> = b.split('.').filter_map(|p| p.parse().ok()).collect();
        b_parts.cmp(&a_parts)
    });

    Ok(mc_versions)
}

#[tauri::command]
pub async fn get_forge_versions(game_version: String) -> Result<Vec<FabricVersionInfo>, String> {
    // Use Maven metadata to find all Forge versions for this MC version
    let resp = crate::util::http::HTTP.get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
        .send()
        .await
        .map_err(|e| format!("Forge maven fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    let text = resp.text().await.map_err(|e| format!("Read: {}", e))?;

    // Find versions that start with this game version prefix
    // e.g. for "1.8.9", match "1.8.9-11.15.1.2318-1.8.9" and "1.8.9-11.15.0.1656"
    let prefix = format!("{}-", game_version);
    let mut versions: Vec<FabricVersionInfo> = Vec::new();

    // Forge versions before MC 1.7.10 don't work reliably — versions below
    // 1.5.2 have no installer JARs on Maven, and 1.5.x–1.6.x have dead FML
    // bootstrap servers that cause runtime failures. 1.7.10 is the oldest
    // version with working infrastructure.
    let mc_parts: Vec<u32> = game_version.split('.').filter_map(|p| p.parse().ok()).collect();
    let too_old = if mc_parts.len() >= 2 && mc_parts[0] == 1 {
        if mc_parts[1] < 7 {
            true
        } else if mc_parts[1] == 7 {
            mc_parts.get(2).copied().unwrap_or(0) < 10
        } else {
            false
        }
    } else if mc_parts.first() == Some(&1) && mc_parts.len() == 1 {
        true // bare "1" — too old
    } else {
        false
    };

    if too_old {
        return Ok(Vec::new());
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<version>") && trimmed.ends_with("</version>") {
            let ver = &trimmed[9..trimmed.len() - 10];
            if ver.starts_with(&prefix) {
                // Return the FULL Maven version string (used as-is for the installer URL)
                versions.push(FabricVersionInfo {
                    version: ver.to_string(),
                    stable: !ver.contains("beta") && !ver.contains("pre"),
                });
            }
        }
    }

    // Reverse so latest is first, take top 5
    versions.reverse();
    versions.truncate(5);

    Ok(versions)
}

/// Returns the list of MC versions that Forge supports, derived from the Maven metadata.
#[tauri::command]
pub async fn get_forge_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP.get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
        .send()
        .await
        .map_err(|e| format!("Forge maven metadata fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    let text = resp.text().await.map_err(|e| format!("Read: {}", e))?;

    // Parse MC versions from <version>MC_VERSION-FORGE_VERSION</version> entries
    let mut mc_versions: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<version>") && trimmed.ends_with("</version>") {
            let ver = &trimmed[9..trimmed.len() - 10]; // strip tags
            // Format: "1.21.4-54.1.6" or "26.1.2-64.0.8"
            if let Some(mc_ver) = ver.split('-').next() {
                // Skip entries that don't look like MC versions (e.g. just numbers)
                if mc_ver.contains('.') && seen.insert(mc_ver.to_string()) {
                    // Filter out MC versions below 1.7.10 (no working Forge infrastructure)
                    let parts: Vec<u32> = mc_ver.split('.').filter_map(|p| p.parse().ok()).collect();
                    let too_old = if parts.len() >= 2 && parts[0] == 1 {
                        if parts[1] < 7 {
                            true
                        } else if parts[1] == 7 {
                            parts.get(2).copied().unwrap_or(0) < 10
                        } else {
                            false
                        }
                    } else { parts.first() == Some(&1) && parts.len() == 1 };
                    if !too_old {
                        mc_versions.push(mc_ver.to_string());
                    }
                }
            }
        }
    }

    // Sort descending (newest first)
    mc_versions.sort_by(|a, b| {
        let a_parts: Vec<u32> = a.split('.').filter_map(|p| p.parse().ok()).collect();
        let b_parts: Vec<u32> = b.split('.').filter_map(|p| p.parse().ok()).collect();
        b_parts.cmp(&a_parts)
    });

    Ok(mc_versions)
}

/// Returns the list of MC versions that Quilt supports.
#[tauri::command]
pub async fn get_quilt_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP.get("https://meta.quiltmc.org/v3/versions/game")
        .send()
        .await
        .map_err(|e| format!("Quilt game versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    #[derive(serde::Deserialize)]
    struct QuiltGameVer { version: String }

    let versions: Vec<QuiltGameVer> = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
    Ok(versions.into_iter().map(|v| v.version).collect())
}
