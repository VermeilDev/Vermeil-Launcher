// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::auth::{self, MinecraftProfile, AccountSummary};
use crate::util::{paths, credentials};
use std::fs;
use tauri::Manager;

/// Start Microsoft login — opens a webview window for sign-in.
#[tauri::command]
pub async fn start_ms_login(app: tauri::AppHandle) -> Result<String, String> {
    let flow = auth::begin_login().await?;

    // Close any existing sign-in window
    if let Some(existing) = app.get_webview_window("signin") {
        let _ = existing.close();
    }

    // Isolate the sign-in webview's session in its own data directory and wipe it
    // before each login. Microsoft's webview persists session cookies, so without
    // this the account chooser keeps listing accounts the user already removed
    // from the launcher (and a fresh launcher has no way to drop a stale MS
    // session). A dedicated dir keeps the wipe from touching the main window's
    // webview storage (e.g. the Library sort saved in localStorage). Best-effort:
    // if the folder is briefly locked by a just-closed window, the next login
    // still gets a clean slate.
    let auth_webview_dir = paths::data_dir().join("auth-webview");
    let _ = fs::remove_dir_all(&auth_webview_dir);

    // Open a new webview window pointed at the Microsoft sign-in page
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "signin",
        tauri::WebviewUrl::External(flow.auth_url.parse().map_err(|e| format!("Bad auth URL: {}", e))?),
    )
    .title("Sign in to Minecraft")
    .inner_size(500.0, 650.0)
    .center()
    .always_on_top(true)
    // Paint the window in the app's dark background up front so it doesn't flash
    // white before Microsoft's page renders.
    .background_color(tauri::utils::config::Color(19, 17, 25, 255))
    .data_directory(auth_webview_dir)
    .build()
    .map_err(|e| format!("Failed to open sign-in window: {}", e))?;

    // Poll the window's URL every 50ms, looking for the redirect with the auth code
    let start = chrono::Utc::now();
    let timeout = chrono::Duration::minutes(10);

    loop {
        if chrono::Utc::now() - start > timeout {
            let _ = window.close();
            return Err("Login timed out (10 minutes)".to_string());
        }

        if window.title().is_err() {
            return Err("Login cancelled".to_string());
        }

        if let Ok(current_url) = window.url() {
            let url_str = current_url.as_str();
            if url_str.starts_with("https://login.live.com/oauth20_desktop.srf") {
                if let Some(code) = current_url.query_pairs()
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.to_string())
                {
                    let _ = window.close();
                    let profile = auth::finish_login(&code, &flow).await?;
                    add_or_update_account(profile.clone())?;
                    return Ok(serde_json::to_string(&profile.to_summary(false)).unwrap());
                }

                if let Some(error) = current_url.query_pairs()
                    .find(|(k, _)| k == "error")
                    .map(|(_, v)| v.to_string())
                {
                    let _ = window.close();
                    let desc = current_url.query_pairs()
                        .find(|(k, _)| k == "error_description")
                        .map(|(_, v)| v.to_string())
                        .unwrap_or_default();
                    return Err(format!("Login error: {} — {}", error, desc));
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// Pre-emptive refresh buffer in seconds (5 minutes for background idle check).
const REFRESH_BUFFER_SECS: i64 = 300;

/// Pre-launch refresh window in seconds (2 hours). Proactively refreshes tokens
/// approaching expiration to ensure multi-hour sessions and server quick joins
/// do not encounter mid-game authentication failures.
const PRE_LAUNCH_REFRESH_WINDOW_SECS: i64 = 7200;

/// Get the currently active account (with auto-refresh if expired).
#[tauri::command]
pub async fn get_active_account() -> Result<Option<AccountSummary>, String> {
    let mut accounts = load_accounts();
    let mut reauth_required = false;
    let now = chrono::Utc::now().timestamp();

    let active_idx = match accounts.iter().position(|a| a.active && !a.is_offline) {
        Some(idx) => idx,
        None => return Ok(accounts.into_iter().find(|a| a.active).map(|a| a.to_summary(false))),
    };

    let needs_refresh = accounts[active_idx].expires_at <= now + REFRESH_BUFFER_SECS
        && accounts[active_idx].refresh_token.as_ref().map(|rt| !rt.is_empty()).unwrap_or(false);

    if needs_refresh {
        let refresh_token = accounts[active_idx].refresh_token.clone().unwrap_or_default();
        match auth::refresh_token(&refresh_token).await {
            Ok(refreshed) => {
                let _ = update_account_session(&mut accounts, active_idx, refreshed);
            }
            Err(e) => {
                tracing::error!("Token refresh failed: {}", e);
                reauth_required = true;
            }
        }
    }

    let active = &accounts[active_idx];
    let expired_without_refresh = active.expires_at < now && active.refresh_token.is_none();
    Ok(Some(active.to_summary(reauth_required || expired_without_refresh)))
}

/// Validate and obtain active Minecraft account credentials for launch,
/// proactively refreshing the token if expired, expiring within 2 hours,
/// or failing pre-flight live validation against Mojang services.
pub async fn get_launch_account() -> Result<(String, String, String), String> {
    let mut accounts = load_accounts();
    let now = chrono::Utc::now().timestamp();

    let active_idx = accounts.iter().position(|a| a.active)
        .or(if !accounts.is_empty() { Some(0) } else { None })
        .ok_or_else(|| "No account found. Please sign in with your Microsoft account first.".to_string())?;

    if accounts[active_idx].is_offline {
        return Err("A valid Microsoft account with a Minecraft license is required to launch the game.".to_string());
    }

    let mut needs_refresh = accounts[active_idx].expires_at <= now + PRE_LAUNCH_REFRESH_WINDOW_SECS;

    // Pre-flight check: even if timestamp appears valid, test against Mojang's profile API
    // to detect server-side session invalidation before spawning the game.
    if !needs_refresh && !accounts[active_idx].access_token.is_empty() {
        match auth::validate_token(&accounts[active_idx].access_token).await {
            Ok(true) => {
                // Token is confirmed active by Mojang session services
            }
            Ok(false) => {
                tracing::info!("Pre-flight check: Mojang rejected current session (invalidated/expired); refreshing proactively");
                needs_refresh = true;
            }
            Err(e) => {
                // Network unreachable (offline mode, airplane, or temporary DNS issue)
                // Proceed with cached token rather than blocking game boot.
                tracing::debug!("Pre-flight check network unreachable ({}); proceeding with cached session", e);
            }
        }
    }

    if needs_refresh {
        if let Some(refresh_tok) = accounts[active_idx].refresh_token.as_ref().filter(|rt| !rt.is_empty()) {
            match auth::refresh_token(refresh_tok).await {
                Ok(refreshed) => {
                    let _ = update_account_session(&mut accounts, active_idx, refreshed);
                }
                Err(e) => {
                    tracing::warn!("Launch token refresh attempt failed: {}", e);
                    if accounts[active_idx].expires_at <= now {
                        return Err(format!("Minecraft session expired. Please sign in again: {}", e));
                    }
                }
            }
        } else if accounts[active_idx].expires_at <= now {
            return Err("Minecraft session expired. Please sign in with your Microsoft account again.".to_string());
        }
    }

    let account = &accounts[active_idx];
    if account.access_token.is_empty() || account.access_token == "0" {
        return Err("Invalid session token. Please sign in again.".to_string());
    }

    Ok((account.name.clone(), account.id.clone(), account.access_token.clone()))
}

/// Get all accounts.
#[tauri::command]
pub async fn get_all_accounts() -> Result<Vec<AccountSummary>, String> {
    let now = chrono::Utc::now().timestamp();
    let accounts = load_accounts();
    Ok(accounts.into_iter().map(|a| {
        let expired_without_refresh = !a.is_offline && a.expires_at < now && a.refresh_token.is_none();
        a.to_summary(expired_without_refresh)
    }).collect())
}

/// Set a specific account as active.
#[tauri::command]
pub async fn set_active_account(id: String) -> Result<(), String> {
    let mut accounts = load_accounts();

    for account in accounts.iter_mut() {
        account.active = account.id == id;
    }

    save_accounts(&accounts)
}


/// Upload a skin for the active account.
#[tauri::command]
pub async fn set_account_skin(skin_file_path: String) -> Result<String, String> {
    let mut accounts = load_accounts();

    let active = accounts.iter_mut().find(|a| a.active)
        .ok_or("No active account")?;

    let skins_dir = paths::data_dir().join("skins");
    fs::create_dir_all(&skins_dir).map_err(|e| e.to_string())?;

    let skin_filename = format!("{}.png", active.id);
    let dest_path = skins_dir.join(&skin_filename);

    fs::copy(&skin_file_path, &dest_path).map_err(|e| format!("Failed to copy skin: {}", e))?;

    active.skin_path = Some(dest_path.to_string_lossy().to_string());
    save_accounts(&accounts)?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// Remove a specific account. If it was active, activate the next one.
#[tauri::command]
pub async fn remove_account(id: String) -> Result<(), String> {
    let _ = credentials::delete_account_credentials(&id);

    let mut accounts = load_accounts();
    let was_active = accounts.iter().find(|a| a.id == id).map(|a| a.active).unwrap_or(false);

    accounts.retain(|a| a.id != id);

    // If we removed the active account, activate the first remaining one
    if was_active && !accounts.is_empty() {
        accounts[0].active = true;
    }

    save_accounts(&accounts)
}

/// Legacy logout — removes all accounts and wipes the credential vault.
#[tauri::command]
pub async fn logout() -> Result<(), String> {
    let _ = credentials::clear_all_credentials();
    let accounts_path = paths::data_dir().join("accounts.json");
    if accounts_path.exists() {
        fs::remove_file(&accounts_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// === HELPERS ===

fn load_accounts() -> Vec<MinecraftProfile> {
    let accounts_path = paths::data_dir().join("accounts.json");
    if !accounts_path.exists() {
        return Vec::new();
    }
    credentials::restrict_file_permissions(&accounts_path);
    let content = fs::read_to_string(&accounts_path).unwrap_or_default();
    let mut accounts: Vec<MinecraftProfile> = serde_json::from_str(&content).unwrap_or_default();

    let mut token_migrated = false;
    let mut metadata_changed = false;

    // Purge any legacy unauthenticated offline accounts so only verified Microsoft accounts remain
    let initial_count = accounts.len();
    accounts.retain(|a| !a.is_offline);
    if accounts.len() != initial_count {
        metadata_changed = true;
        if !accounts.is_empty() && !accounts.iter().any(|a| a.active) {
            accounts[0].active = true;
        }
        tracing::info!("Purged unauthenticated offline profiles from accounts.json");
    }

    for account in accounts.iter_mut() {
        // One-time migration: If legacy tokens are still present inside accounts.json, move them to credentials.enc
        if !account.is_offline && (!account.access_token.is_empty() && account.access_token != "offline" && account.access_token != "0" || account.refresh_token.is_some()) {
            let access = credentials::decrypt_credential(&account.access_token).unwrap_or_else(|_| account.access_token.clone());
            let refresh = account.refresh_token.as_ref().map(|rt| {
                credentials::decrypt_credential(rt).unwrap_or_else(|_| rt.clone())
            });

            let creds = credentials::AccountCredentials {
                access_token: access,
                refresh_token: refresh,
            };
            let _ = credentials::save_account_credentials(&account.id, &creds);
            token_migrated = true;
        }

        // Hydrate in-memory profile from the secure credentials vault
        if !account.is_offline {
            if let Ok(Some(creds)) = credentials::get_account_credentials(&account.id) {
                account.access_token = creds.access_token;
                account.refresh_token = creds.refresh_token;
            }

            // Synchronize expires_at with genuine JWT expiration claim if available
            if let Some((_, Some(real_exp))) = auth::extract_token_claims(&account.access_token) {
                if account.expires_at != real_exp {
                    account.expires_at = real_exp;
                    metadata_changed = true;
                }
            }
        }
    }

    if token_migrated {
        tracing::info!("Migrated accounts.json: moved authentication tokens to secure vault credentials.enc");
    }

    // Rewrite accounts.json with clean metadata only (stripping legacy tokens or updating expiry)
    if token_migrated || metadata_changed {
        let _ = save_accounts(&accounts);
    }

    accounts
}

/// Persists refreshed session credentials to the encrypted vault, updates the
/// in-memory profile, and saves the updated accounts metadata to disk.
fn update_account_session(
    accounts: &mut [MinecraftProfile],
    active_idx: usize,
    refreshed: MinecraftProfile,
) -> Result<(), String> {
    let account = &mut accounts[active_idx];
    let creds = credentials::AccountCredentials {
        access_token: refreshed.access_token.clone(),
        refresh_token: refreshed.refresh_token.clone(),
    };
    let _ = credentials::save_account_credentials(&account.id, &creds);

    account.access_token = refreshed.access_token;
    account.refresh_token = refreshed.refresh_token;
    account.expires_at = refreshed.expires_at;
    account.name = refreshed.name;

    save_accounts(accounts)
}

fn save_accounts(accounts: &[MinecraftProfile]) -> Result<(), String> {
    let data_dir = paths::data_dir();
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // Serializing MinecraftProfile directly skips access_token and refresh_token
    // entirely via #[serde(skip_serializing)], keeping accounts.json clean of all token keys.
    let json = serde_json::to_string_pretty(accounts).map_err(|e| e.to_string())?;
    let accounts_path = data_dir.join("accounts.json");
    credentials::atomic_write(&accounts_path, json.as_bytes())?;
    Ok(())
}

/// Add a new account or update an existing one (by ID). Sets it as active.
fn add_or_update_account(mut profile: MinecraftProfile) -> Result<(), String> {
    // If online account, persist credentials to the dedicated vault
    if !profile.is_offline && (!profile.access_token.is_empty() || profile.refresh_token.is_some()) {
        let creds = credentials::AccountCredentials {
            access_token: profile.access_token.clone(),
            refresh_token: profile.refresh_token.clone(),
        };
        credentials::save_account_credentials(&profile.id, &creds)?;
    }

    let mut accounts = load_accounts();

    // Deactivate all others
    for a in accounts.iter_mut() {
        a.active = false;
    }

    // Update existing or add new
    profile.active = true;
    if let Some(existing) = accounts.iter_mut().find(|a| a.id == profile.id) {
        *existing = profile;
    } else {
        accounts.push(profile);
    }

    save_accounts(&accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metadata_serialization_scrubs_tokens() {
        let profile = MinecraftProfile {
            id: "test-uuid-1".to_string(),
            name: "TestUser".to_string(),
            access_token: "super_secret_mc_token".to_string(),
            refresh_token: Some("super_secret_ms_refresh".to_string()),
            expires_at: 123456789,
            is_offline: false,
            skin_path: None,
            active: true,
        };

        let accounts = vec![profile];
        let json = serde_json::to_string(&accounts).unwrap();
        assert!(!json.contains("super_secret_mc_token"));
        assert!(!json.contains("super_secret_ms_refresh"));
        assert!(!json.contains("access_token"));
        assert!(!json.contains("refresh_token"));
        assert!(json.contains("TestUser"));
    }
}
