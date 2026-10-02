// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Google Cloud settings backup and restore service using Google Drive's isolated
//! `appDataFolder` sandbox (https://www.googleapis.com/auth/drive.appdata).
//!
//! Features:
//! - Local loopback OAuth 2.0 PKCE flow (RFC 7636 / RFC 8252) on an ephemeral port
//! - Seamless system browser authorization
//! - Zero-telemetry design: tokens are ephemeral and revoked immediately upon transfer completion
//! - Sandboxed storage: backup files remain completely hidden from the user's regular Google Drive UI

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::models::settings::{GlobalVideoSettings, LauncherSettings};
use crate::services::settings_service;
use crate::util::credentials;
use crate::util::http::HTTP;
use crate::util::paths;

pub const GOOGLE_CLIENT_ID: &str = match option_env!("VERMEIL_GOOGLE_CLIENT_ID") {
    Some(val) => val,
    None => "",
};
/// Google OAuth 2.0 Client Secret for the installed desktop client.
/// Injected at compile-time via VERMEIL_GOOGLE_CLIENT_SECRET (or GitHub Actions Secrets).
/// Per RFC 8252 Section 8.5 and Google's official documentation for installed apps:
/// "In this context, the client secret is obviously not treated as a secret."
/// Google's /token endpoint mandates it for quota routing, while PKCE (RFC 7636)
/// provides the cryptographic security.
pub const GOOGLE_CLIENT_SECRET: &str = match option_env!("VERMEIL_GOOGLE_CLIENT_SECRET") {
    Some(val) => val,
    None => "",
};
const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_DRIVE_FILES_API: &str = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE_DRIVE_APPDATA: &str = "https://www.googleapis.com/auth/drive.appdata";
const BACKUP_FILENAME: &str = "vermeil_cloud_backup.json";

static OAUTH_CANCEL_TX: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Aborts any in-flight Google Cloud OAuth loopback server and returns immediately.
pub fn cancel_google_oauth() {
    if let Ok(mut lock) = OAUTH_CANCEL_TX.lock() {
        if let Some(tx) = lock.take() {
            let _ = tx.send(());
            tracing::info!("Google Cloud OAuth cancelled by user/client.");
        }
    }
}

/// Serialized payload written into Google Drive `appDataFolder`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VermeilCloudBackup {
    pub format_version: u32,
    pub created_at: String,
    pub app_version: String,
    pub settings: LauncherSettings,
    #[serde(default)]
    pub pinned_instances: Vec<CloudPinnedInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPinnedInstance {
    pub id: String,
    pub name: String,
    pub game_version: String,
    pub loader: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudBackupSummary {
    pub timestamp: String,
    pub file_size_bytes: usize,
    pub pinned_instances_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudRestoreSummary {
    pub timestamp: String,
    pub settings_restored: bool,
    pub pinned_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudConnectSummary {
    pub connected: bool,
    pub restored: bool,
    pub timestamp: String,
    pub details: String,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveFileList {
    #[serde(default)]
    pub files: Vec<DriveFileEntry>,
}

#[derive(Debug, Deserialize)]
struct DriveFileEntry {
    pub id: String,
}

/// Generates a cryptographically random PKCE code verifier and SHA-256 challenge.
fn generate_pkce() -> (String, String) {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    let verifier = BASE64_URL_SAFE.encode(bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = BASE64_URL_SAFE.encode(hasher.finalize());

    (verifier, challenge)
}

/// Runs the local loopback OAuth 2.0 PKCE flow in the user's default browser,
/// exchanges the authorization code for an access token and optional refresh token.
pub async fn start_google_oauth() -> Result<(String, Option<String>), String> {
    if GOOGLE_CLIENT_ID.is_empty() {
        return Err("Google Cloud credentials are not configured in this build. Please configure VERMEIL_GOOGLE_CLIENT_ID and VERMEIL_GOOGLE_CLIENT_SECRET.".to_string());
    }

    let (code_verifier, code_challenge) = generate_pkce();
    // Generate cryptographic OAuth `state` token (RFC 6749 §10.12 / RFC 8252 §8.9)
    // to prevent Login CSRF / session fixation attacks on the loopback callback.
    let (oauth_state, _) = generate_pkce();

    // Bind to an ephemeral loopback port on 127.0.0.1
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local OAuth loopback port: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local OAuth loopback port: {}", e))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}", port);

    // Build Google OAuth 2.0 authorization URL
    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        GOOGLE_AUTH_ENDPOINT,
        urlencoding::encode(GOOGLE_CLIENT_ID),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPE_DRIVE_APPDATA),
        urlencoding::encode(&oauth_state),
        urlencoding::encode(&code_challenge),
    );

    // Generate a single-use local entry nonce so the verification link opened by
    // the launcher points to 127.0.0.1:<port>/start?nonce=... instead of directly
    // to accounts.google.com. Once consumed (or once cancelled/expired), any repeat
    // attempt to open the link is blocked locally before Google ever loads.
    let (entry_nonce, _) = generate_pkce();
    let local_start_url = format!("http://127.0.0.1:{}/start?nonce={}", port, urlencoding::encode(&entry_nonce));

    tracing::info!("Launching system browser for Google Cloud OAuth via single-use local gate: 127.0.0.1:{}", port);
    open::that(&local_start_url).map_err(|e| format!("Failed to open default system browser: {}", e))?;

    // Set up cancellation channel
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    if let Ok(mut lock) = OAUTH_CANCEL_TX.lock() {
        *lock = Some(cancel_tx);
    }

    struct CancelGuard;
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            if let Ok(mut lock) = OAUTH_CANCEL_TX.lock() {
                *lock = None;
            }
        }
    }
    let _guard = CancelGuard;

    let mut nonce_consumed = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);

    let (code, mut stream) = loop {
        let accept_res = tokio::select! {
            res = tokio::time::timeout_at(deadline, listener.accept()) => {
                match res {
                    Ok(Ok(pair)) => pair,
                    Ok(Err(e)) => return Err(format!("Failed to accept OAuth loopback connection: {}", e)),
                    Err(_) => return Err("Google authorization timed out (no response received within 60 seconds).".to_string()),
                }
            }
            _ = &mut cancel_rx => {
                return Err("Google authorization was cancelled.".to_string());
            }
        };

        let (mut s, _) = accept_res;
        let mut buffer = [0u8; 4096];
        let n = match s.read(&mut buffer).await {
            Ok(0) | Err(_) => continue,
            Ok(n) => n,
        };

        let request_str = String::from_utf8_lossy(&buffer[..n]);
        let first_line = request_str.lines().next().unwrap_or_default();
        let query_part = first_line.split_whitespace().nth(1).unwrap_or("/");

        // Ignore automatic browser favicon / preflight requests so they don't consume the listener
        if query_part.starts_with("/favicon.ico") {
            let _ = s.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
            let _ = s.flush().await;
            continue;
        }

        // Single-use local gate: only redirect to Google on the very first visit with a valid nonce
        if query_part.starts_with("/start") {
            let expected_query = format!("nonce={}", urlencoding::encode(&entry_nonce));
            if !nonce_consumed && query_part.contains(&expected_query) {
                nonce_consumed = true;
                let redirect_resp = format!(
                    "HTTP/1.1 302 Found\r\nLocation: {}\r\nCache-Control: no-store, no-cache, must-revalidate\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n",
                    auth_url
                );
                let _ = s.write_all(redirect_resp.as_bytes()).await;
                let _ = s.flush().await;
            } else {
                let expired_html = "\
                    HTTP/1.1 410 Gone\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n\
                    <!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Vermeil — Verification Link Expired</title></head>\
                    <body style=\"background:#0f0e13;color:#ece9f2;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\">\
                    <div style=\"background:#1d1b24;border:1px solid #322f3d;border-left:3px solid #f87171;padding:36px 40px;max-width:420px;text-align:center;\">\
                    <h2 style=\"color:#f87171;margin:0 0 10px 0;\">Verification Link Expired</h2>\
                    <p style=\"color:#a6a1b5;font-size:13.5px;line-height:1.6;margin:0;\">This single-use verification link has already been used or expired. Please start a new connection from Vermeil.</p>\
                    </div>\
                    <script>if(window.history&&window.history.replaceState){window.history.replaceState({l:1},document.title,window.location.pathname);for(var i=0;i<25;i++)window.history.pushState({l:1},document.title,window.location.pathname);window.addEventListener('popstate',function(){window.history.pushState({l:1},document.title,window.location.pathname);});}</script>\
                    </body></html>";
                let _ = s.write_all(expired_html.as_bytes()).await;
                let _ = s.flush().await;
            }
            continue;
        }

        // Handle Google OAuth callback (?code=...&state=... or ?error=...)
        if let Some(q_idx) = query_part.find('?') {
            let query = &query_part[q_idx + 1..];
            let mut code_val = None;
            let mut state_val = None;
            let mut error_val = None;

            for pair in query.split('&') {
                let mut parts = pair.splitn(2, '=');
                let key = parts.next().unwrap_or_default();
                let val = parts.next().unwrap_or_default();
                if key == "code" {
                    code_val = Some(urlencoding::decode(val).unwrap_or_default().into_owned());
                } else if key == "state" {
                    state_val = Some(urlencoding::decode(val).unwrap_or_default().into_owned());
                } else if key == "error" {
                    error_val = Some(urlencoding::decode(val).unwrap_or_default().into_owned());
                }
            }

            if let Some(err) = error_val {
                let error_html = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n\
                    <!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Vermeil — Authorization Cancelled</title></head>\
                    <body style=\"background:#0f0e13;color:#f4f3f6;font-family:sans-serif;padding:40px;text-align:center;\">\
                    <h2 style=\"color:#f87171;\">Authorization Cancelled</h2><p>Google authentication failed: {}</p>\
                    <script>if(window.history&&window.history.replaceState){{window.history.replaceState({{l:1}},document.title,window.location.pathname);for(var i=0;i<25;i++)window.history.pushState({{l:1}},document.title,window.location.pathname);window.addEventListener('popstate',function(){{window.history.pushState({{l:1}},document.title,window.location.pathname);}});}}</script>\
                    </body></html>",
                    err
                );
                let _ = s.write_all(error_html.as_bytes()).await;
                let _ = s.flush().await;
                return Err(format!("Google authorization denied: {}", err));
            }

            if let Some(c) = code_val {
                if state_val.as_deref() != Some(oauth_state.as_str()) {
                    let csrf_html = "\
                        HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n\
                        <!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Vermeil — Invalid Session State</title></head>\
                        <body style=\"background:#0f0e13;color:#f4f3f6;font-family:sans-serif;padding:40px;text-align:center;\">\
                        <h2 style=\"color:#f87171;\">Invalid Session State</h2><p>OAuth state mismatch. Please start a new connection from Vermeil.</p>\
                        <script>if(window.history&&window.history.replaceState){window.history.replaceState({l:1},document.title,window.location.pathname);for(var i=0;i<25;i++)window.history.pushState({l:1},document.title,window.location.pathname);window.addEventListener('popstate',function(){window.history.pushState({l:1},document.title,window.location.pathname);});}</script>\
                        </body></html>";
                    let _ = s.write_all(csrf_html.as_bytes()).await;
                    let _ = s.flush().await;
                    return Err("Google OAuth state mismatch (potential CSRF or stale session).".to_string());
                }
                break (c, s);
            }
        }
    };

    // Send stylized success page to browser — matches Vermeil's tactile dark UI
    let success_html = "\
        HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
        <!DOCTYPE html>\
        <html>\
        <head>\
          <meta charset=\"utf-8\">\
          <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\
          <title>Vermeil — Google Cloud Connected</title>\
          <style>\
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');\
            * { box-sizing: border-box; margin: 0; padding: 0; }\
            body {\
              background:\
                radial-gradient(ellipse 70% 55% at 50% 42%, rgba(139, 92, 246, 0.12), transparent 72%),\
                radial-gradient(circle at 50% 120%, rgba(124, 77, 222, 0.08), transparent 60%),\
                #0f0e13;\
              color: #ece9f2;\
              font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\
              display: flex;\
              flex-direction: column;\
              align-items: center;\
              justify-content: center;\
              height: 100vh;\
              padding: 24px;\
              -webkit-font-smoothing: antialiased;\
            }\
            .card {\
              background: #1d1b24;\
              border: 1px solid #322f3d;\
              border-left: 3px solid #8b5cf6;\
              padding: 42px 40px 36px 40px;\
              border-radius: 0;\
              text-align: center;\
              max-width: 440px;\
              width: 100%;\
              box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);\
              animation: cardIn 0.35s ease-out both;\
            }\
            .card-tag {\
              display: inline-block;\
              background: rgba(139, 92, 246, 0.12);\
              border: 1px solid rgba(139, 92, 246, 0.35);\
              color: #a78bfa;\
              font-family: 'DM Mono', monospace;\
              font-size: 10px;\
              font-weight: 600;\
              padding: 3px 10px;\
              border-radius: 0;\
              text-transform: uppercase;\
              letter-spacing: 0.1em;\
              margin-bottom: 22px;\
            }\
            .check-well {\
              width: 48px;\
              height: 48px;\
              margin: 0 auto 18px auto;\
              background: #0f0e13;\
              border: 1px solid #322f3d;\
              display: flex;\
              align-items: center;\
              justify-content: center;\
            }\
            .check-well svg {\
              width: 24px;\
              height: 24px;\
              stroke: #4ade80;\
              fill: none;\
              stroke-width: 2.5;\
              stroke-linecap: round;\
              stroke-linejoin: round;\
            }\
            h2 {\
              color: #ece9f2;\
              font-size: 21px;\
              font-weight: 700;\
              margin-bottom: 10px;\
              letter-spacing: -0.01em;\
            }\
            p {\
              color: #a6a1b5;\
              font-size: 13.5px;\
              line-height: 1.6;\
              margin-bottom: 0;\
            }\
            .divider {\
              width: 100%;\
              height: 1px;\
              background: #322f3d;\
              margin: 24px 0 20px 0;\
            }\
            .shortcut-pill {\
              display: inline-flex;\
              align-items: center;\
              justify-content: center;\
              gap: 8px;\
              background: #0f0e13;\
              border: 1px solid #3c384a;\
              padding: 10px 18px;\
              font-family: 'DM Mono', monospace;\
              font-size: 11.5px;\
              color: #c4b5fd;\
            }\
            .key-cap {\
              background: #25222f;\
              border: 1px solid #4d475f;\
              border-bottom: 2px solid #15141c;\
              color: #ece9f2;\
              padding: 2px 7px;\
              font-size: 11px;\
              font-weight: 600;\
              border-radius: 2px;\
            }\
            @keyframes cardIn {\
              from { opacity: 0; transform: translateY(10px); }\
              to   { opacity: 1; transform: translateY(0); }\
            }\
          </style>\
        </head>\
        <body>\
          <div class=\"card\">\
            <div class=\"card-tag\">CLOUD SYNC</div>\
            <div class=\"check-well\"><svg viewBox=\"0 0 24 24\"><polyline points=\"20 6 9 17 4 12\"/></svg></div>\
            <h2>Connected</h2>\
            <p>Your Google account has been authorized. You can close this tab and return to Vermeil.</p>\
            <div class=\"divider\"></div>\
            <div class=\"shortcut-pill\">\
              <span>Press</span>\
              <kbd class=\"key-cap\" id=\"cmd-key\">Ctrl</kbd> + <kbd class=\"key-cap\">W</kbd>\
              <span>or</span>\
              <button onclick=\"window.close();\" style=\"background:#8b5cf6;border:none;color:#ffffff;padding:2px 8px;font-family:'DM Sans',sans-serif;font-weight:700;font-size:11px;cursor:pointer;\">Close Tab</button>\
            </div>\
          </div>\
          <script>\
            try { window.close(); } catch(e) {}\
            setTimeout(function() { try { window.close(); } catch(e) {} }, 600);\
            if (window.history && window.history.replaceState) {\
              window.history.replaceState({ vermeilLocked: true }, document.title, window.location.pathname);\
              for (var i = 0; i < 25; i++) {\
                window.history.pushState({ vermeilLocked: true }, document.title, window.location.pathname);\
              }\
              window.addEventListener('popstate', function () {\
                window.history.pushState({ vermeilLocked: true }, document.title, window.location.pathname);\
              });\
            }\
            var isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;\
            var keyEl = document.getElementById('cmd-key');\
            if (keyEl && isMac) keyEl.textContent = '⌘';\
          </script>\
        </body>\
        </html>";

    let _ = stream.write_all(success_html.as_bytes()).await;
    let _ = stream.flush().await;

    // Exchange auth code + PKCE verifier for access token
    let mut params = vec![
        ("client_id", GOOGLE_CLIENT_ID),
        ("code", &code),
        ("code_verifier", &code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", &redirect_uri),
    ];
    if !GOOGLE_CLIENT_SECRET.is_empty() {
        params.push(("client_secret", GOOGLE_CLIENT_SECRET));
    }

    let token_resp = HTTP
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to request token from Google: {}", e))?;

    if !token_resp.status().is_success() {
        let err_body = token_resp.text().await.unwrap_or_default();
        return Err(format!("Google token exchange failed: {}", err_body));
    }

    let token_data: GoogleTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google token response: {}", e))?;

    Ok((token_data.access_token, token_data.refresh_token))
}

fn token_file_path() -> std::path::PathBuf {
    paths::data_dir().join("google_cloud.enc")
}

pub fn is_cloud_connected() -> bool {
    token_file_path().exists()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredGoogleTokens {
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: Option<String>,
}

pub fn save_tokens(tokens: &StoredGoogleTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens)
        .map_err(|e| format!("Failed to serialize Google tokens: {}", e))?;
    let encrypted = credentials::encrypt_credential(&json)?;
    let path = token_file_path();
    credentials::atomic_write(&path, encrypted.as_bytes())
}

pub fn read_tokens() -> Result<StoredGoogleTokens, String> {
    let path = token_file_path();
    if !path.exists() {
        return Err("Not connected to Google Cloud".to_string());
    }
    credentials::restrict_file_permissions(&path);
    let encrypted = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Google token file: {}", e))?;
    let decrypted = credentials::decrypt_credential(&encrypted)?;
    match serde_json::from_str::<StoredGoogleTokens>(&decrypted) {
        Ok(toks) => Ok(toks),
        Err(_) => Ok(StoredGoogleTokens {
            refresh_token: decrypted.trim().to_string(),
            access_token: None,
        }),
    }
}

pub fn read_refresh_token() -> Result<String, String> {
    read_tokens().map(|t| t.refresh_token)
}

pub fn delete_tokens() {
    let path = token_file_path();
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

pub async fn refresh_access_token(refresh_token: &str) -> Result<String, String> {
    let mut params = vec![
        ("client_id", GOOGLE_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];
    if !GOOGLE_CLIENT_SECRET.is_empty() {
        params.push(("client_secret", GOOGLE_CLIENT_SECRET));
    }

    let resp = HTTP
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to refresh Google token: {}", e))?;

    if !resp.status().is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("Google token refresh failed: {}", err_body));
    }

    let token_data: GoogleTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google refresh response: {}", e))?;

    // Persist current active access token alongside refresh token
    let new_refresh = token_data.refresh_token.unwrap_or_else(|| refresh_token.to_string());
    let _ = save_tokens(&StoredGoogleTokens {
        refresh_token: new_refresh,
        access_token: Some(token_data.access_token.clone()),
    });

    Ok(token_data.access_token)
}

/// Atomically revokes an ephemeral Google OAuth token (access token or refresh token) with Google servers.
async fn revoke_token(token: &str) {
    let url = format!("{}?token={}", GOOGLE_REVOKE_ENDPOINT, urlencoding::encode(token));
    let params = [("token", token)];
    let resp = HTTP.post(&url).form(&params).send().await;
    match resp {
        Ok(r) if r.status().is_success() => {
            tracing::info!("Google Cloud OAuth token successfully revoked from Google servers");
        }
        Ok(r) => {
            tracing::debug!("Google token revocation returned status: {}", r.status());
        }
        Err(e) => {
            tracing::warn!("Google token revocation network error: {}", e);
        }
    }
}

/// Searches the private `appDataFolder` for `vermeil_cloud_backup.json`
async fn find_existing_backup_file_id(access_token: &str) -> Result<Option<String>, String> {
    let query = format!("name = '{}' and trashed = false", BACKUP_FILENAME);
    let resp = HTTP
        .get(GOOGLE_DRIVE_FILES_API)
        .bearer_auth(access_token)
        .query(&[
            ("spaces", "appDataFolder"),
            ("q", &query),
            ("fields", "files(id, name)"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to query Google Drive appDataFolder: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Drive search failed (status {}): {}", status, body));
    }

    let list: DriveFileList = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Drive file list: {}", e))?;

    Ok(list.files.first().map(|f| f.id.clone()))
}

/// Uploads launcher settings and pinned instances to Google Cloud `appDataFolder`.
pub async fn backup_to_google_cloud() -> Result<CloudBackupSummary, String> {
    if is_cloud_connected() {
        let refresh_token = read_refresh_token()?;
        let access_token = refresh_access_token(&refresh_token).await?;
        perform_backup(&access_token).await
    } else {
        let (access_token, _) = start_google_oauth().await?;
        let backup_result = perform_backup(&access_token).await;

        // Zero-telemetry guarantee: burn token immediately for ephemeral one-off login
        revoke_token(&access_token).await;

        backup_result
    }
}

/// Strips all hardware-dependent and machine-specific settings, keeping ONLY portable preferences:
/// 1. General settings (launcher lifecycle, splash, toasts, dock, Discord RPC, auto-update, snapshots, force delete, download limits, mod sources)
/// 2. Display & Video settings (max_fps, vsync, gui_scale, brightness/gamma, fov, view_bobbing)
/// 3. Accessibility & Motion settings (fov_effects, show_subtitles)
/// 4. Controls & Mouse settings (mouse_sensitivity, invert_y_mouse, auto_jump)
/// 5. Sound level settings (master, music, weather, hostile, block, player volume)
/// 6. Custom keybinds (muscle-memory keyboard shortcuts)
///
/// Hardware-dependent settings are strictly LOCAL ONLY and never uploaded to cloud:
/// - RAM allocation & Adaptive RAM (default_memory_mb, adaptive_ram, min/max)
/// - Window dimensions (window_width, window_height, start_maximized)
/// - Java runtime, paths, and GC presets (java_runtime, java_paths, gc_preset)
/// - Concurrency limits (concurrent_downloads, concurrent_writes)
pub fn sanitize_settings_for_cloud(source: &LauncherSettings) -> LauncherSettings {
    let defaults = LauncherSettings::default();

    LauncherSettings {
        // 1. General settings:
        close_on_launch: source.close_on_launch,
        popout_logs: source.popout_logs,
        auto_update: source.auto_update,
        update_channel: source.update_channel.clone(),
        discord_rpc: source.discord_rpc,
        show_snapshots: source.show_snapshots,
        splash_screen: source.splash_screen,
        download_toasts: source.download_toasts,
        theme: source.theme.clone(),
        auto_hide_dock: source.auto_hide_dock,
        pagination_position: source.pagination_position.clone(),
        force_delete: source.force_delete,
        download_speed_limit_mb: source.download_speed_limit_mb,
        mod_sources: source.mod_sources.clone(),
        enable_companion_mod: source.enable_companion_mod,

        // 2. Video, Audio, Controls, and Accessibility settings (synced to cloud):
        video_settings: GlobalVideoSettings {
            // Display & Video:
            max_fps: source.video_settings.max_fps,
            vsync: source.video_settings.vsync,
            gui_scale: source.video_settings.gui_scale,
            gamma: source.video_settings.gamma,
            fov: source.video_settings.fov,
            view_bobbing: source.video_settings.view_bobbing,

            // Accessibility:
            fov_effects: source.video_settings.fov_effects,
            show_subtitles: source.video_settings.show_subtitles,

            // Controls & Mouse:
            mouse_sensitivity: source.video_settings.mouse_sensitivity,
            invert_y_mouse: source.video_settings.invert_y_mouse,
            auto_jump: source.video_settings.auto_jump,

            // Sound levels:
            master_volume: source.video_settings.master_volume,
            music_volume: source.video_settings.music_volume,
            weather_volume: source.video_settings.weather_volume,
            hostile_volume: source.video_settings.hostile_volume,
            block_volume: source.video_settings.block_volume,
            player_volume: source.video_settings.player_volume,

            // Machine-specific hardware window dimensions (local only):
            window_width: None,
            window_height: None,
            start_maximized: None,
        },

        // 3. Custom keybinds (synced to cloud):
        keybinds: source.keybinds.clone(),

        // Everything else: Reset to defaults (LOCAL HARDWARE / LOCAL STATE ONLY)
        // Memory defaults (machine-specific):
        default_memory_mb: defaults.default_memory_mb,
        adaptive_ram: defaults.adaptive_ram,
        adaptive_ram_min_mb: defaults.adaptive_ram_min_mb,
        adaptive_ram_max_mb: defaults.adaptive_ram_max_mb,
        java_runtime: defaults.java_runtime,
        gc_preset: defaults.gc_preset,
        java_paths: HashMap::new(),
        concurrent_downloads: defaults.concurrent_downloads,
        concurrent_writes: defaults.concurrent_writes,
        curseforge_api_key: String::new(),
        modrinth_token: String::new(),
        onboarded: defaults.onboarded,
        sidebar_pinned_instances: Vec::new(),
        ingame_cape: defaults.ingame_cape,
        last_cloud_backup: source.last_cloud_backup.clone(),
        lifetime_play_seconds: source.lifetime_play_seconds,
        last_active_at: source.last_active_at.clone(),
        last_app_version: defaults.last_app_version,
    }
}

/// Applies restored cloud settings while strictly preserving all local-only configurations:
/// - Java runtime, GC preset, and Java paths (local only)
/// - RAM and adaptive memory (local only)
/// - Concurrency limits (local only)
/// - Window dimensions (local only)
/// - Sidebar pinned instances (local only)
/// Compares two ISO-8601 / RFC3339 timestamps by parsed UTC epoch time (falling back to
/// lexicographical comparison if unparseable) so fractional-second length differences or
/// timezone offsets never skew which timestamp is newer.
pub(crate) fn is_timestamp_newer(candidate: &str, existing: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(candidate),
        chrono::DateTime::parse_from_rfc3339(existing),
    ) {
        (Ok(c), Ok(e)) => c > e,
        _ => candidate > existing,
    }
}

/// Applies restored cloud settings while strictly preserving all local-only configurations:
/// - Java runtime, GC preset, and Java paths (local only)
/// - RAM and adaptive memory (local only)
/// - Concurrency limits (local only)
/// - Window dimensions (local only)
/// - Sidebar pinned instances (local only)
pub fn merge_restored_settings(
    cloud_backup: &LauncherSettings,
    local_settings: &LauncherSettings,
    backup_timestamp: &str,
) -> LauncherSettings {
    let mut merged = local_settings.clone();
    merged.last_cloud_backup = Some(backup_timestamp.to_string());

    // 1. General settings (restored from cloud)
    merged.close_on_launch = cloud_backup.close_on_launch;
    merged.popout_logs = cloud_backup.popout_logs;
    merged.auto_update = cloud_backup.auto_update;
    merged.update_channel = cloud_backup.update_channel.clone();
    merged.discord_rpc = cloud_backup.discord_rpc;
    merged.show_snapshots = cloud_backup.show_snapshots;
    merged.splash_screen = cloud_backup.splash_screen;
    merged.download_toasts = cloud_backup.download_toasts;
    if !cloud_backup.theme.is_empty() {
        merged.theme = cloud_backup.theme.clone();
    }
    merged.auto_hide_dock = cloud_backup.auto_hide_dock;
    merged.pagination_position = cloud_backup.pagination_position.clone();
    merged.force_delete = cloud_backup.force_delete;
    merged.download_speed_limit_mb = cloud_backup.download_speed_limit_mb;
    if !cloud_backup.mod_sources.is_empty() {
        merged.mod_sources = cloud_backup.mod_sources.clone();
    }
    merged.enable_companion_mod = cloud_backup.enable_companion_mod;

    // 2. Video & Display settings (restored from cloud)
    merged.video_settings.max_fps = cloud_backup.video_settings.max_fps;
    merged.video_settings.vsync = cloud_backup.video_settings.vsync;
    merged.video_settings.gui_scale = cloud_backup.video_settings.gui_scale;
    merged.video_settings.gamma = cloud_backup.video_settings.gamma;
    merged.video_settings.fov = cloud_backup.video_settings.fov;
    if cloud_backup.video_settings.view_bobbing.is_some() {
        merged.video_settings.view_bobbing = cloud_backup.video_settings.view_bobbing;
    }

    // 3. Accessibility & Motion settings (restored from cloud)
    if cloud_backup.video_settings.fov_effects.is_some() {
        merged.video_settings.fov_effects = cloud_backup.video_settings.fov_effects;
    }
    if cloud_backup.video_settings.show_subtitles.is_some() {
        merged.video_settings.show_subtitles = cloud_backup.video_settings.show_subtitles;
    }

    // 4. Controls & Mouse settings (restored from cloud)
    if cloud_backup.video_settings.mouse_sensitivity.is_some() {
        merged.video_settings.mouse_sensitivity = cloud_backup.video_settings.mouse_sensitivity;
    }
    if cloud_backup.video_settings.invert_y_mouse.is_some() {
        merged.video_settings.invert_y_mouse = cloud_backup.video_settings.invert_y_mouse;
    }
    if cloud_backup.video_settings.auto_jump.is_some() {
        merged.video_settings.auto_jump = cloud_backup.video_settings.auto_jump;
    }

    // 5. Sound level settings (restored from cloud)
    merged.video_settings.master_volume = cloud_backup.video_settings.master_volume;
    merged.video_settings.music_volume = cloud_backup.video_settings.music_volume;
    merged.video_settings.weather_volume = cloud_backup.video_settings.weather_volume;
    merged.video_settings.hostile_volume = cloud_backup.video_settings.hostile_volume;
    merged.video_settings.block_volume = cloud_backup.video_settings.block_volume;
    merged.video_settings.player_volume = cloud_backup.video_settings.player_volume;

    // 6. Custom keybinds (restored from cloud)
    merged.keybinds = cloud_backup.keybinds.clone();

    // 7. Lifetime play stats: take the greater playtime and most recent active date
    if cloud_backup.lifetime_play_seconds > merged.lifetime_play_seconds {
        merged.lifetime_play_seconds = cloud_backup.lifetime_play_seconds;
    }
    if let Some(ref cloud_last) = cloud_backup.last_active_at {
        if merged
            .last_active_at
            .as_ref()
            .is_none_or(|local_last| is_timestamp_newer(cloud_last, local_last))
        {
            merged.last_active_at = Some(cloud_last.clone());
        }
    }

    // Memory (default_memory_mb, adaptive_ram) and Window dimensions
    // (window_width, window_height, start_maximized) remain strictly machine-specific/local.

    merged
}

async fn fetch_backup_by_id(access_token: &str, file_id: &str) -> Result<VermeilCloudBackup, String> {
    let download_url = format!("{}/{}?alt=media", GOOGLE_DRIVE_FILES_API, file_id);
    let resp = HTTP
        .get(&download_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to download backup from Google Cloud: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Drive download failed (status {}): {}", status, body));
    }

    let content = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read backup response body: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse cloud backup JSON payload: {}", e))
}

async fn perform_backup(access_token: &str) -> Result<CloudBackupSummary, String> {
    perform_backup_with_context(access_token, None, None).await
}

async fn perform_backup_with_context(
    access_token: &str,
    known_file_id: Option<String>,
    preloaded_cloud: Option<&VermeilCloudBackup>,
) -> Result<CloudBackupSummary, String> {
    // 1. Gather local settings
    let mut settings = settings_service::load()
        .await
        .map_err(|e| format!("Failed to load local settings: {}", e))?;

    // 2. Reuse known file ID if already resolved by caller, otherwise query Drive appDataFolder once
    let existing_file_id = match known_file_id {
        Some(id) => Some(id),
        None => find_existing_backup_file_id(access_token).await?,
    };

    // Monotonic cloud guard: if an existing backup in Drive has higher lifetime_play_seconds
    // or a more recent last_active_at (e.g. when syncing from a fresh install before restore),
    // merge those monotonic counters into `settings` first so we NEVER reset cloud playtime to 0.
    let fetched_cloud: Option<VermeilCloudBackup>;
    let cloud_ref = if let Some(preloaded) = preloaded_cloud {
        Some(preloaded)
    } else if let Some(ref file_id) = existing_file_id {
        fetched_cloud = fetch_backup_by_id(access_token, file_id).await.ok();
        fetched_cloud.as_ref()
    } else {
        None
    };

    if let Some(existing_cloud) = cloud_ref {
        if existing_cloud.settings.lifetime_play_seconds > settings.lifetime_play_seconds {
            settings.lifetime_play_seconds = existing_cloud.settings.lifetime_play_seconds;
        }
        if let Some(ref cloud_last) = existing_cloud.settings.last_active_at {
            if settings
                .last_active_at
                .as_ref()
                .is_none_or(|local_last| is_timestamp_newer(cloud_last, local_last))
            {
                settings.last_active_at = Some(cloud_last.clone());
            }
        }
    }

    let now_iso = Utc::now().to_rfc3339();
    settings.last_cloud_backup = Some(now_iso.clone());

    let cloud_settings = sanitize_settings_for_cloud(&settings);

    let backup = VermeilCloudBackup {
        format_version: 1,
        created_at: now_iso.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        settings: cloud_settings,
        pinned_instances: Vec::new(),
    };

    let json_bytes = serde_json::to_string_pretty(&backup)
        .map_err(|e| format!("Failed to serialize cloud backup payload: {}", e))?
        .into_bytes();
    let file_size_bytes = json_bytes.len();

    if let Some(file_id) = existing_file_id {
        // Update existing file via PATCH media upload
        let update_url = format!("{}/{}?uploadType=media", GOOGLE_DRIVE_UPLOAD_API, file_id);
        let resp = HTTP
            .patch(&update_url)
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .body(json_bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to upload backup patch to Google Cloud: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive update failed (status {}): {}", status, body));
        }
    } else {
        // Create new file in appDataFolder using multipart upload
        let boundary = "-------VermeilCloudBoundaryX9";
        let metadata_part = serde_json::json!({
            "name": BACKUP_FILENAME,
            "parents": ["appDataFolder"]
        });

        let mut body_bytes = Vec::new();
        body_bytes.extend_from_slice(format!("--{}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n", boundary).as_bytes());
        body_bytes.extend_from_slice(serde_json::to_string(&metadata_part).unwrap_or_default().as_bytes());
        body_bytes.extend_from_slice(format!("\r\n--{}\r\nContent-Type: application/json\r\n\r\n", boundary).as_bytes());
        body_bytes.extend_from_slice(&json_bytes);
        body_bytes.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

        let upload_url = format!("{}?uploadType=multipart", GOOGLE_DRIVE_UPLOAD_API);
        let resp = HTTP
            .post(&upload_url)
            .bearer_auth(access_token)
            .header("Content-Type", format!("multipart/related; boundary={}", boundary))
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to create backup file in Google Cloud: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive multipart create failed (status {}): {}", status, body));
        }
    }

    // Persist updated last_cloud_backup (and any merged monotonic playtime) locally
    let _ = settings_service::save(&settings).await;

    Ok(CloudBackupSummary {
        timestamp: now_iso,
        file_size_bytes,
        pinned_instances_count: 0,
    })
}

/// Downloads launcher settings from Google Cloud `appDataFolder` and restores them locally.
pub async fn restore_from_google_cloud(app: Option<&tauri::AppHandle>) -> Result<CloudRestoreSummary, String> {
    if is_cloud_connected() {
        let refresh_token = read_refresh_token()?;
        let access_token = refresh_access_token(&refresh_token).await?;
        perform_restore_with_id(&access_token, None, app).await
    } else {
        let (access_token, _) = start_google_oauth().await?;
        let restore_result = perform_restore_with_id(&access_token, None, app).await;

        // Zero-telemetry guarantee: burn token immediately for ephemeral one-off restore
        revoke_token(&access_token).await;

        restore_result
    }
}

async fn perform_restore_with_id(
    access_token: &str,
    known_file_id: Option<String>,
    app: Option<&tauri::AppHandle>,
) -> Result<CloudRestoreSummary, String> {
    // 1. Locate backup in appDataFolder (reuse known_file_id if caller already resolved it)
    let existing_file_id = match known_file_id {
        Some(id) => id,
        None => find_existing_backup_file_id(access_token)
            .await?
            .ok_or_else(|| "No Vermeil cloud backup found in this Google account's app storage.".to_string())?,
    };

    // 2. Download media
    let backup = fetch_backup_by_id(access_token, &existing_file_id).await?;

    // 3. Merge / apply settings locally while strictly preserving local machine-specific settings
    let current_settings = settings_service::load().await.unwrap_or_default();
    let restored_settings = merge_restored_settings(&backup.settings, &current_settings, &backup.created_at);

    // Apply live backend settings immediately (Discord RPC, download speed limiter)
    crate::services::discord::set_enabled(restored_settings.discord_rpc);
    crate::services::download::set_speed_limit_mb(restored_settings.download_speed_limit_mb);

    settings_service::save(&restored_settings)
        .await
        .map_err(|e| format!("Failed to save restored settings to disk: {}", e))?;

    // 4. Bidirectional sync: if local settings had higher lifetime_play_seconds or a newer
    // last_active_at than what was in the cloud backup, push the merged counters back up to
    // Google Drive immediately reusing the known file ID and preloaded cloud backup (zero extra GETs).
    let local_had_newer_stats = restored_settings.lifetime_play_seconds > backup.settings.lifetime_play_seconds
        || restored_settings.last_active_at != backup.settings.last_active_at;
    if local_had_newer_stats {
        let _ = perform_backup_with_context(access_token, Some(existing_file_id), Some(&backup)).await;
    }

    // 5. Notify all windows to refresh live runtime signals (theme, dock, toasts, settings UI)
    if let Some(handle) = app {
        use tauri::Emitter;
        let _ = handle.emit("cloud-settings-synced", ());
    }

    Ok(CloudRestoreSummary {
        timestamp: backup.created_at,
        settings_restored: true,
        pinned_count: 0,
    })
}

/// Connects user's Google Account once, securely persists refresh token,
/// and automatically performs an initial restore (if backup exists) or initial backup.
pub async fn connect_google_account(app: Option<&tauri::AppHandle>) -> Result<CloudConnectSummary, String> {
    let (access_token, refresh_token_opt) = start_google_oauth().await?;

    if let Some(ref ref_tok) = refresh_token_opt {
        save_tokens(&StoredGoogleTokens {
            refresh_token: ref_tok.clone(),
            access_token: Some(access_token.clone()),
        })?;
    } else {
        tracing::warn!("Google OAuth did not return a refresh token");
    }

    // Check if cloud backup exists in appDataFolder once and pass file_id down
    let existing_backup = find_existing_backup_file_id(&access_token).await?;

    if let Some(file_id) = existing_backup {
        let restore_res = perform_restore_with_id(&access_token, Some(file_id), app).await?;
        tracing::info!("Google Cloud connected: restored existing settings from cloud");
        Ok(CloudConnectSummary {
            connected: true,
            restored: true,
            timestamp: restore_res.timestamp,
            details: "Restored General, Display, Sound, and Keybind preferences from cloud.".to_string(),
        })
    } else {
        let backup_res = perform_backup_with_context(&access_token, None, None).await?;
        tracing::info!("Google Cloud connected: initial settings backup uploaded to cloud");
        Ok(CloudConnectSummary {
            connected: true,
            restored: false,
            timestamp: backup_res.timestamp,
            details: "Settings successfully backed up to Google Cloud.".to_string(),
        })
    }
}

/// Signs out of Google Cloud on this device only.
///
/// Purges all local authentication tokens (access token and refresh token) from disk
/// and stops synchronization without contacting Google's revocation endpoint.
/// This logs out the launcher while keeping the app authorized on the user's
/// Google Account ("Third-party apps & services") so future logins remain seamless.
pub async fn sign_out_google_account(app: Option<&tauri::AppHandle>) -> Result<(), String> {
    delete_tokens();
    SYNC_PENDING.store(false, Ordering::Relaxed);

    if let Ok(mut settings) = settings_service::load().await {
        settings.last_cloud_backup = None;
        let _ = settings_service::save(&settings).await;
    }

    if let Some(handle) = app {
        use tauri::Emitter;
        let _ = handle.emit("cloud-settings-synced", ());
    }

    tracing::info!("Google Cloud signed out locally: access token and refresh token removed (Google link preserved)");
    Ok(())
}

/// Disconnects Google Cloud and unlinks the application completely.
///
/// Revokes the OAuth grant with Google servers (unlinking Vermeil from the user's
/// Google Account under "Third-party apps & services") and purges all local tokens
/// (access token and refresh token) from disk.
pub async fn disconnect_google_account(app: Option<&tauri::AppHandle>) -> Result<(), String> {
    if let Ok(toks) = read_tokens() {
        if let Some(ref access_tok) = toks.access_token {
            revoke_token(access_tok).await;
        }
        if !toks.refresh_token.is_empty() {
            revoke_token(&toks.refresh_token).await;
        }
    }
    delete_tokens();
    SYNC_PENDING.store(false, Ordering::Relaxed);

    if let Ok(mut settings) = settings_service::load().await {
        settings.last_cloud_backup = None;
        let _ = settings_service::save(&settings).await;
    }

    if let Some(handle) = app {
        use tauri::Emitter;
        let _ = handle.emit("cloud-settings-synced", ());
    }

    tracing::info!("Google Cloud disconnected and unlinked: access revoked with Google servers and local tokens removed");
    Ok(())
}

static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static SYNC_PENDING: AtomicBool = AtomicBool::new(false);

/// Spawns a non-blocking, coalesced background task to synchronize launcher settings to Google Cloud
/// if a Google Cloud account is currently connected.
pub fn spawn_background_sync() {
    if is_cloud_connected() {
        tokio::spawn(async {
            sync_settings_background().await;
        });
    }
}

/// Silently reconciles local settings and stats (`lifetime_play_seconds`, `last_active_at`)
/// with Google Cloud on launcher startup when connected, then notifies the frontend to refresh
/// live runtime signals (`cloud-settings-synced`).
pub fn sync_on_startup(app: tauri::AppHandle) {
    if !is_cloud_connected() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let refresh_token = match read_refresh_token() {
            Ok(tok) => tok,
            Err(_) => return,
        };
        let access_token = match refresh_access_token(&refresh_token).await {
            Ok(tok) => tok,
            Err(e) => {
                tracing::warn!("Startup Google Cloud sync failed to obtain access token: {}", e);
                return;
            }
        };
        let existing_backup = match find_existing_backup_file_id(&access_token).await {
            Ok(opt) => opt,
            Err(e) => {
                tracing::warn!("Startup Google Cloud sync failed to check backup: {}", e);
                return;
            }
        };
        if let Some(file_id) = existing_backup {
            if perform_restore_with_id(&access_token, Some(file_id), Some(&app)).await.is_ok() {
                tracing::info!("Startup Google Cloud sync reconciled settings & play time");
            }
        } else {
            let _ = perform_backup_with_context(&access_token, None, None).await;
        }
    });
}

/// Silently synchronizes launcher settings in the background whenever settings change.
/// Coalesces rapid concurrent updates so only one Drive upload runs at a time, reusing the same access token.
pub async fn sync_settings_background() {
    if SYNC_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        SYNC_PENDING.store(true, Ordering::SeqCst);
        return;
    }

    let refresh_token = match read_refresh_token() {
        Ok(tok) => tok,
        Err(_) => {
            SYNC_IN_PROGRESS.store(false, Ordering::SeqCst);
            return;
        }
    };

    let access_token = match refresh_access_token(&refresh_token).await {
        Ok(tok) => tok,
        Err(e) => {
            tracing::warn!("Background Google Cloud sync failed to obtain access token: {}", e);
            SYNC_IN_PROGRESS.store(false, Ordering::SeqCst);
            return;
        }
    };

    loop {
        SYNC_PENDING.store(false, Ordering::SeqCst);
        if let Err(e) = perform_backup(&access_token).await {
            tracing::warn!("Background Google Cloud sync failed: {}", e);
        } else {
            tracing::info!("Settings automatically synced to Google Cloud in background");
        }
        if !SYNC_PENDING.swap(false, Ordering::SeqCst) {
            break;
        }
    }

    SYNC_IN_PROGRESS.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_generation() {
        let (verifier, challenge) = generate_pkce();
        assert!(!verifier.is_empty());
        assert!(!challenge.is_empty());
        assert_ne!(verifier, challenge);
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn test_cloud_backup_serialization_roundtrip() {
        let backup = VermeilCloudBackup {
            format_version: 1,
            created_at: "2026-09-22T21:00:00Z".to_string(),
            app_version: "1.1.1".to_string(),
            settings: LauncherSettings::default(),
            pinned_instances: vec![CloudPinnedInstance {
                id: "inst-123".to_string(),
                name: "Survival 1.20".to_string(),
                game_version: "1.20.1".to_string(),
                loader: "fabric".to_string(),
            }],
        };

        let json = serde_json::to_string(&backup).expect("serialize backup");
        let deserialized: VermeilCloudBackup = serde_json::from_str(&json).expect("deserialize backup");

        assert_eq!(deserialized.format_version, 1);
        assert_eq!(deserialized.app_version, "1.1.1");
        assert_eq!(deserialized.pinned_instances.len(), 1);
        assert_eq!(deserialized.pinned_instances[0].name, "Survival 1.20");
    }

    #[test]
    fn test_machine_specific_settings_sanitized_and_preserved() {
        use std::collections::HashMap;

        // Machine A:
        let mut machine_a = LauncherSettings::default();
        machine_a.discord_rpc = false;
        machine_a.auto_hide_dock = false;
        machine_a.force_delete = true;
        machine_a.download_speed_limit_mb = 0;
        machine_a.theme = "inferno".to_string();

        // Memory defaults:
        machine_a.default_memory_mb = 8192;
        machine_a.adaptive_ram_min_mb = 4096;
        machine_a.adaptive_ram_max_mb = 16384;

        // Window & Display & Sound & Controls & Accessibility:
        machine_a.video_settings.window_width = Some(1920);
        machine_a.video_settings.window_height = Some(1080);
        machine_a.video_settings.start_maximized = Some(true);
        machine_a.video_settings.max_fps = Some(144);
        machine_a.video_settings.view_bobbing = Some(false);
        machine_a.video_settings.fov_effects = Some(0.75);
        machine_a.video_settings.show_subtitles = Some(true);
        machine_a.video_settings.mouse_sensitivity = Some(0.7);
        machine_a.video_settings.invert_y_mouse = Some(true);
        machine_a.video_settings.auto_jump = Some(false);
        machine_a.video_settings.master_volume = Some(0.8);

        // Local-only settings:
        let mut custom_paths_a = HashMap::new();
        custom_paths_a.insert(21, "C:\\Java\\jdk-21\\bin\\javaw.exe".to_string());
        machine_a.java_paths = custom_paths_a;
        machine_a.java_runtime = "custom".to_string();
        machine_a.gc_preset = "shenandoah".to_string();
        machine_a.concurrent_downloads = 5;
        let mut keybinds_a = HashMap::new();
        keybinds_a.insert("open_search".to_string(), "Ctrl+K".to_string());
        machine_a.keybinds = keybinds_a;
        machine_a.lifetime_play_seconds = 7200;
        machine_a.last_active_at = Some("2026-09-23T20:00:00Z".to_string());

        // Sanitize for cloud
        let cloud = sanitize_settings_for_cloud(&machine_a);

        // Verify synced: General, Display, Sound, Controls, Accessibility, Keybinds, and Lifetime Playtime
        assert_eq!(cloud.discord_rpc, false);
        assert_eq!(cloud.auto_hide_dock, false);
        assert_eq!(cloud.force_delete, true);
        assert_eq!(cloud.theme, "inferno");
        assert_eq!(cloud.video_settings.max_fps, Some(144));
        assert_eq!(cloud.video_settings.view_bobbing, Some(false));
        assert_eq!(cloud.video_settings.fov_effects, Some(0.75));
        assert_eq!(cloud.video_settings.show_subtitles, Some(true));
        assert_eq!(cloud.video_settings.mouse_sensitivity, Some(0.7));
        assert_eq!(cloud.video_settings.invert_y_mouse, Some(true));
        assert_eq!(cloud.video_settings.auto_jump, Some(false));
        assert_eq!(cloud.video_settings.master_volume, Some(0.8));
        assert_eq!(cloud.keybinds.get("open_search").map(|s| s.as_str()), Some("Ctrl+K"));
        assert_eq!(cloud.lifetime_play_seconds, 7200);
        assert_eq!(cloud.last_active_at, Some("2026-09-23T20:00:00Z".to_string()));

        // Verify local-only settings were stripped (Memory, Concurrency & Window are machine-specific)
        assert_eq!(cloud.default_memory_mb, 4096); // default, not Machine A's 8192
        assert_eq!(cloud.video_settings.window_width, None);
        assert_eq!(cloud.video_settings.window_height, None);
        assert_eq!(cloud.video_settings.start_maximized, None);
        assert!(cloud.java_paths.is_empty());
        assert_eq!(cloud.java_runtime, "adoptium");
        assert_eq!(cloud.gc_preset, "g1gc");
        assert_eq!(cloud.concurrent_downloads, 10);

        // Machine B with its own local memory, window size, and Java
        let mut machine_b = LauncherSettings::default();
        machine_b.default_memory_mb = 2048;
        machine_b.video_settings.window_width = Some(1280);
        machine_b.video_settings.window_height = Some(720);
        let mut custom_paths_b = HashMap::new();
        custom_paths_b.insert(21, "/usr/lib/jvm/java-21/bin/java".to_string());
        machine_b.java_paths = custom_paths_b;
        machine_b.java_runtime = "system".to_string();
        machine_b.gc_preset = "zgc".to_string();
        machine_b.download_speed_limit_mb = 15;
        machine_b.concurrent_downloads = 3;
        machine_b.video_settings.mouse_sensitivity = Some(0.4);
        machine_b.lifetime_play_seconds = 3600;
        machine_b.last_active_at = Some("2026-09-22T20:00:00Z".to_string());

        // Restore cloud backup onto Machine B
        let restored_on_b = merge_restored_settings(&cloud, &machine_b, "2026-09-22T21:00:00Z");

        // Machine B gets General, Display, Sound, Controls, Accessibility, and Keybinds from cloud
        assert_eq!(restored_on_b.discord_rpc, false);
        assert_eq!(restored_on_b.auto_hide_dock, false);
        assert_eq!(restored_on_b.force_delete, true);
        assert_eq!(restored_on_b.download_speed_limit_mb, 0);
        assert_eq!(restored_on_b.theme, "inferno");
        assert_eq!(restored_on_b.video_settings.max_fps, Some(144));
        assert_eq!(restored_on_b.video_settings.view_bobbing, Some(false));
        assert_eq!(restored_on_b.video_settings.fov_effects, Some(0.75));
        assert_eq!(restored_on_b.video_settings.show_subtitles, Some(true));
        assert_eq!(restored_on_b.video_settings.mouse_sensitivity, Some(0.7));
        assert_eq!(restored_on_b.video_settings.invert_y_mouse, Some(true));
        assert_eq!(restored_on_b.video_settings.auto_jump, Some(false));
        assert_eq!(restored_on_b.video_settings.master_volume, Some(0.8));
        assert_eq!(restored_on_b.keybinds.get("open_search").map(|s| s.as_str()), Some("Ctrl+K"));

        // Machine B preserves local-only settings (Memory, Window, Java)
        assert_eq!(restored_on_b.default_memory_mb, 2048);
        assert_eq!(restored_on_b.video_settings.window_width, Some(1280));
        assert_eq!(restored_on_b.video_settings.window_height, Some(720));
        assert_eq!(restored_on_b.java_paths.get(&21).unwrap(), "/usr/lib/jvm/java-21/bin/java");
        assert_eq!(restored_on_b.java_runtime, "system");
        assert_eq!(restored_on_b.gc_preset, "zgc");
        assert_eq!(restored_on_b.concurrent_downloads, 3);

        // Machine A had 7200s, Machine B had 3600s: restored gets 7200s
        assert_eq!(restored_on_b.lifetime_play_seconds, 7200);
        assert_eq!(restored_on_b.last_active_at, Some("2026-09-23T20:00:00Z".to_string()));
    }
}
