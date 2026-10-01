// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use reqwest::Client;

/// Single source of truth for the launcher's User-Agent. Drives every
/// outbound request through `HTTP` and the `${launcher_version}` token in
/// the Minecraft launch arguments. Bound to `CARGO_PKG_VERSION` so a
/// version bump in `Cargo.toml` propagates everywhere automatically — no
/// manual edits to comments or string literals per release.
pub const LAUNCHER_NAME: &str = "Vermeil";
pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");

lazy_static::lazy_static! {
    /// Shared HTTP client used across all services.
    /// Single instance with connection pooling and a consistent User-Agent.
    ///
    /// `connect_timeout` bounds DNS + TCP + TLS handshake so a cold-start network
    /// stall (common right after an app update) can't hang a request forever.
    /// We deliberately set NO overall request timeout here — large file downloads
    /// (mod jars, Java, modpacks) go through this same client and can legitimately
    /// run for minutes. API reads bound themselves per-attempt in `send_with_retry`.
    pub static ref HTTP: Client = Client::builder()
        .user_agent(format!("{}/{}", LAUNCHER_NAME, LAUNCHER_VERSION))
        .pool_max_idle_per_host(5)
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("Failed to create HTTP client");
}

/// Send a request built by `build`, retrying transient failures with a short
/// backoff. Intended for read-only API calls (search, metadata) where a
/// momentary backend blip shouldn't surface as a user-facing error — e.g.
/// Modrinth's search backend occasionally returns 5xx for a few seconds.
///
/// Retries on connection errors, HTTP 429 (rate limit), and 5xx. Client errors
/// (4xx other than 429) are returned as-is so the caller can surface the body —
/// they won't change on retry. `build` is called once per attempt so each retry
/// gets a fresh request (no `RequestBuilder` clone needed).
///
/// Each attempt carries a per-request timeout. The shared client only bounds the
/// *connect* phase, which leaves a request that connects but then stalls
/// mid-response able to hang forever — exactly the "search never loads until I
/// restart" failure, since a hang never errors and so never triggers the retry
/// below. The per-attempt timeout turns that stall into a retryable error. It's
/// scoped to this helper (read-only API calls), so file downloads — which use the
/// client directly, not this path — keep their unbounded body-transfer time.
pub async fn send_with_retry<F>(build: F) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    const ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 400;
    /// Per-attempt ceiling for an API read. Normal Modrinth/CurseForge calls
    /// finish in well under a second; 15s only trips on a genuine stall.
    const ATTEMPT_TIMEOUT_SECS: u64 = 15;

    let mut last_err = String::new();
    for attempt in 0..ATTEMPTS {
        match build()
            .timeout(std::time::Duration::from_secs(ATTEMPT_TIMEOUT_SECS))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() || !(status.as_u16() == 429 || status.is_server_error()) {
                    return Ok(resp);
                }
                last_err = format!("HTTP {}", status);
            }
            Err(e) => last_err = e.to_string(),
        }
        if attempt + 1 < ATTEMPTS {
            // Linear backoff: 400ms, 800ms.
            tokio::time::sleep(std::time::Duration::from_millis(
                BASE_BACKOFF_MS * (attempt as u64 + 1),
            ))
            .await;
        }
    }
    Err(last_err)
}
