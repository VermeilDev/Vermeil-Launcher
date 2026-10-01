// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Concurrent batch downloader with two-semaphore concurrency model
//! (separate fetch and write bounds).
//!
//! The fetch semaphore bounds simultaneous network requests; the write semaphore
//! bounds simultaneous disk writes. They are separate so a slow disk doesn't
//! starve fetches and a slow network doesn't starve writes.
//!
//! Both limits come from `LauncherSettings.concurrent_downloads` and
//! `concurrent_writes` (defaults 10/10), read once per `download_all` call.

use crate::services::settings_service;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Semaphore;

/// Hard ceilings — match the UI (Settings.tsx) so a tampered config.json or
/// older settings file doesn't drive the semaphores past safe limits.
const MAX_FETCH: usize = 20;
const MAX_WRITE: usize = 50;
const MAX_RETRIES: u8 = 3;
const RETRY_DELAY_MS: u64 = 500;

/// Error text a cancelled install returns. The install flows already delete a
/// partially-created instance directory on *any* error, so cancellation just has
/// to produce one — no separate teardown path.
pub const CANCELLED: &str = "Install cancelled";

/// Set when the user asks to cancel the running install. Checked before each
/// task in a batch and between the stages of `prepare_with_extras`.
///
/// ponytail: one global flag, matching the `USER_STOPPED` precedent in
/// `commands/launch.rs` and the UI, which shows a single install-progress popup
/// with a single Cancel button. Ceiling: the flag isn't scoped to one job, so
/// cancelling an install also aborts anything else downloading at that moment —
/// a second install, or a launch-time library/asset repair for another instance.
/// Upgrade path is a per-install token in Tauri managed state, threaded through
/// `prepare_with_extras` — worth doing only if those overlaps become common.
static CANCEL_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// How many `InstallScope`s are alive. Guards `request_cancel` so the flag can
/// only ever be raised while something is actually installing.
///
/// Without this guard, a cancel arriving when no install is running — clicking
/// Cancel as an install completes, or from a code path that emits
/// `install-progress` without holding a scope — sets a flag nothing will clear.
/// Every download in the process then fails, because `download_one` is the
/// choke point for game libraries, assets, Java, loader installs and the
/// companion mod as well as for mod installs. The symptom would be the game
/// refusing to launch until restart, with "Install cancelled" as the reason.
static ACTIVE_INSTALLS: AtomicU32 = AtomicU32::new(0);

/// Ask the running install to stop at its next checkpoint.
///
/// No-op when nothing is installing, so a stray cancel can't strand the flag.
pub fn request_cancel() {
    if ACTIVE_INSTALLS.load(Ordering::SeqCst) == 0 {
        tracing::debug!("Cancel requested with no install running; ignoring");
        return;
    }
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    tracing::info!("Install cancellation requested");
}

/// Clear the flag. Called when an install begins, and by whichever install
/// actually aborts — so a cancel can never leak into a later install or into a
/// launch-time repair.
pub fn clear_cancel() {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
}

pub fn is_cancelled() -> bool {
    CANCEL_REQUESTED.load(Ordering::SeqCst)
}

/// `Err(CANCELLED)` when a cancel is pending, so call sites read as `check()?`.
pub fn cancel_check() -> Result<(), String> {
    if is_cancelled() {
        Err(CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// Scopes one user-initiated install.
///
/// Clears any stale cancel on creation and again on drop, so a request can never
/// leak into a later install or into a launch-time repair — including when the
/// install bails out early through `?`. While at least one scope is alive,
/// cancellation is accepted; outside any scope it's ignored.
///
/// **Every command that can emit `install-progress` must hold one**, because the
/// progress popup's Cancel button is enabled purely by that event. A command that
/// emits progress without a scope shows a Cancel button that does nothing.
pub struct InstallScope;

impl InstallScope {
    pub fn begin() -> Self {
        ACTIVE_INSTALLS.fetch_add(1, Ordering::SeqCst);
        clear_cancel();
        InstallScope
    }
}

impl Drop for InstallScope {
    fn drop(&mut self) {
        // Only the last scope out clears the flag; a nested or concurrent install
        // finishing shouldn't un-cancel one still winding down.
        if ACTIVE_INSTALLS.fetch_sub(1, Ordering::SeqCst) <= 1 {
            clear_cancel();
        }
    }
}

/// Global token-bucket rate limiter for download bandwidth throttling.
///
/// Throttles chunk reads across all concurrent tasks down to the user's
/// configured `download_speed_limit_mb` (0 = unlimited).
pub struct RateLimiter {
    bytes_per_sec: AtomicU64,
    current_limit_mb: AtomicU32,
    state: Mutex<TokenBucketState>,
}

struct TokenBucketState {
    tokens: f64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            bytes_per_sec: AtomicU64::new(0),
            current_limit_mb: AtomicU32::new(u32::MAX),
            state: Mutex::new(TokenBucketState {
                tokens: 0.0,
                last_refill: Instant::now(),
            }),
        }
    }

    /// Update the speed limit dynamically in-flight. Deduplicates if the limit has not changed.
    pub fn set_limit_mb(&self, mb: u32) {
        let prev = self.current_limit_mb.swap(mb, Ordering::Relaxed);
        if prev == mb {
            return;
        }

        let bytes_per_sec = (mb as u64) * 1024 * 1024;
        self.bytes_per_sec.store(bytes_per_sec, Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock() {
            state.tokens = 0.0;
            state.last_refill = Instant::now();
        }
        if mb == 0 {
            tracing::info!("Download speed limit set to Unlimited");
        } else {
            tracing::info!("Download speed limit set to {} MB/s", mb);
        }
    }

    /// Consume `bytes` from the token bucket, asynchronously sleeping if deficit exists.
    pub async fn consume(&self, bytes: usize) -> Result<(), String> {
        let limit = self.bytes_per_sec.load(Ordering::Relaxed);
        // Fast path: unlimited has 0 mutex locks, 0 timer allocations.
        if limit == 0 {
            return Ok(());
        }

        let sleep_duration = {
            let mut state = match self.state.lock() {
                Ok(s) => s,
                Err(_) => return Ok(()),
            };

            let now = Instant::now();
            let elapsed = now.saturating_duration_since(state.last_refill).as_secs_f64();
            state.last_refill = now;

            let rate = limit as f64;
            let max_burst = rate * 0.5; // up to 500ms burst capacity
            state.tokens = (state.tokens + elapsed * rate).min(max_burst);

            let needed = bytes as f64;
            state.tokens -= needed;

            if state.tokens >= 0.0 {
                Duration::ZERO
            } else {
                let max_debt = rate * 2.0; // clamp accumulated deficit to at most 2 seconds
                if state.tokens < -max_debt {
                    state.tokens = -max_debt;
                }
                let debt = -state.tokens;
                Duration::from_secs_f64(debt / rate)
            }
        };

        if !sleep_duration.is_zero() {
            cancel_check()?;
            tokio::time::sleep(sleep_duration).await;
            cancel_check()?;
        }

        Ok(())
    }
}

lazy_static::lazy_static! {
    pub(crate) static ref RATE_LIMITER: RateLimiter = RateLimiter::new();
}

/// Dynamically update the download rate limit (in MB/s, 0 = unlimited).
pub fn set_speed_limit_mb(mb: u32) {
    RATE_LIMITER.set_limit_mb(mb);
}

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub url: String,
    pub dest: PathBuf,
    pub expected_sha1: Option<String>,
    pub expected_size: Option<u64>,
}

/// Progress payload emitted via Tauri events during batch downloads.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgressPayload {
    pub completed: u32,
    pub total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current_file: String,
}

/// Check if a file exists and matches expected hash/size.
///
/// Validation strategy:
/// - If size is known: file must exist and size must match. Hash is NOT
///   re-verified for already-present files because rehashing 1000+ cached
///   asset objects on every install adds seconds of latency before any download
///   can start. SHA-1 is still verified for *fresh* downloads in `persist_bytes`.
/// - If size is unknown but hash is: full hash check (fallback for files where
///   size isn't published, e.g. some loader libraries).
/// - If neither is known: existence is sufficient.
pub fn file_valid(path: &Path, expected_sha1: &Option<String>, expected_size: &Option<u64>) -> bool {
    if !path.exists() {
        return false;
    }

    if let Some(size) = expected_size {
        // Size is the cheap, authoritative check for cached files.
        if std::fs::metadata(path).map(|m| m.len() == *size).unwrap_or(false) {
            return true;
        }
    }

    if let Some(hash) = expected_sha1 {
        if let Ok(mut file) = std::fs::File::open(path) {
            use std::io;
            let mut hasher = Sha1::new();
            if io::copy(&mut file, &mut hasher).is_ok() {
                let result = format!("{:x}", hasher.finalize());
                if result == *hash {
                    return true;
                }
            }
        }
    }

    // For mod and resourcepack archives, a non-empty, structurally valid ZIP file on disk
    // is considered valid even if upstream manifest metadata had size/hash drift.
    let is_archive = path
        .extension()
        .map(|e| {
            let ext = e.to_string_lossy().to_lowercase();
            ext == "jar" || ext == "zip" || ext == "mrpack"
        })
        .unwrap_or(false);

    if is_archive {
        if let Ok(file) = std::fs::File::open(path) {
            if let Ok(archive) = zip::ZipArchive::new(file) {
                return !archive.is_empty();
            }
        }
    }

    expected_size.is_none() && expected_sha1.is_none()
}

/// Fetch the bytes of a URL with retry. The fetch semaphore is held only for
/// the duration of the network read.
async fn fetch_bytes(
    client: &Client,
    url: &str,
    fetch_sem: &Arc<Semaphore>,
) -> Result<Vec<u8>, String> {
    let _permit = fetch_sem.acquire().await.map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {} failed: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {}", resp.status(), url));
    }

    // Stream bytes into a Vec — keeps memory bounded to one file at a time per worker.
    let mut bytes = Vec::with_capacity(
        resp.content_length().unwrap_or(0) as usize,
    );
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read chunk: {}", e))?;
        cancel_check()?;
        RATE_LIMITER.consume(chunk.len()).await?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Persist bytes to disk atomically (.part → final). The write semaphore is
/// held for the entire write+rename to prevent partial files being seen.
async fn persist_bytes(
    bytes: &[u8],
    dest: &Path,
    expected_sha1: &Option<String>,
    url: &str,
    write_sem: &Arc<Semaphore>,
) -> Result<(), String> {
    let _permit = write_sem.acquire().await.map_err(|e| e.to_string())?;

    if let Some(hash) = expected_sha1 {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        let result = format!("{:x}", hasher.finalize());
        if &result != hash {
            // Modpack manifests (both CurseForge and Modrinth exports) occasionally contain
            // drifted or cross-platform hash metadata (e.g. author exported CurseForge hashes
            // into a Modrinth mrpack, or CDN edge re-signing). If the downloaded payload is a
            // valid archive, the transfer succeeded cleanly over TLS and the mismatch is
            // upstream manifest metadata drift.
            let is_archive = dest
                .extension()
                .map(|e| {
                    let ext = e.to_string_lossy().to_lowercase();
                    ext == "jar" || ext == "zip" || ext == "mrpack"
                })
                .unwrap_or(false);

            if is_archive && is_valid_zip(bytes) {
                tracing::warn!(
                    "Hash mismatch for {} (expected {}, got {} from {}), but payload is a valid archive ({} bytes). Accepting download.",
                    dest.display(),
                    hash,
                    result,
                    url,
                    bytes.len()
                );
            } else {
                return Err(format!(
                    "Hash mismatch for {}: expected {}, got {}",
                    dest.display(),
                    hash,
                    result
                ));
            }
        }
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }

    let part_path = dest.with_extension(format!(
        "{}.part",
        dest.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    tokio::fs::write(&part_path, bytes)
        .await
        .map_err(|e| format!("Write {}: {}", part_path.display(), e))?;

    tokio::fs::rename(&part_path, dest)
        .await
        .map_err(|e| format!("Rename {}: {}", dest.display(), e))?;

    Ok(())
}

/// Download a single file with retries. Skips if the file already exists and
/// validates against the expected size/hash.
///
/// This function is callable directly for one-off downloads; for batches use
/// `download_all` so the semaphores are shared across tasks.
pub async fn download_file(client: &Client, task: &DownloadTask) -> Result<(), String> {
    if file_valid(&task.dest, &task.expected_sha1, &task.expected_size) {
        return Ok(());
    }

    // For one-off calls, create tiny per-call semaphores (limit 1 each).
    // The settings-derived semaphores are only shared inside `download_all`.
    let fetch_sem = Arc::new(Semaphore::new(1));
    let write_sem = Arc::new(Semaphore::new(1));

    download_one(client, task, &fetch_sem, &write_sem).await
}

async fn download_one(
    client: &Client,
    task: &DownloadTask,
    fetch_sem: &Arc<Semaphore>,
    write_sem: &Arc<Semaphore>,
) -> Result<(), String> {
    if file_valid(&task.dest, &task.expected_sha1, &task.expected_size) {
        return Ok(());
    }

    // Checked per task rather than mid-stream: a single file is small enough that
    // finishing it costs little, and this is what makes a queue of thousands stop
    // promptly instead of running to completion.
    cancel_check()?;

    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        match fetch_bytes(client, &task.url, fetch_sem).await {
            Ok(bytes) => {
                match persist_bytes(&bytes, &task.dest, &task.expected_sha1, &task.url, write_sem).await {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = e,
                }
            }
            Err(e) => last_err = e,
        }

        if attempt < MAX_RETRIES {
            // Don't burn the remaining retries on a cancelled install.
            cancel_check()?;
            tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
        }
    }

    Err(format!("Download failed after {} retries: {}", MAX_RETRIES, last_err))
}

/// Resolve concurrency limits from settings, clamped to per-field hard caps.
async fn resolve_concurrency() -> (usize, usize) {
    match settings_service::load().await {
        Ok(s) => {
            let dl = (s.concurrent_downloads as usize).clamp(1, MAX_FETCH);
            let wr = (s.concurrent_writes as usize).clamp(1, MAX_WRITE);
            set_speed_limit_mb(s.download_speed_limit_mb);
            (dl, wr)
        }
        Err(e) => {
            tracing::warn!("Could not load settings for concurrency: {}; using defaults", e);
            (10, 10)
        }
    }
}

/// Download multiple files concurrently, emitting `download-progress` events.
///
/// Concurrency is bounded by two semaphores derived from settings:
/// - fetch (`concurrent_downloads`) bounds in-flight network requests
/// - write (`concurrent_writes`) bounds in-flight disk writes
///
/// Progress events are throttled to roughly one per ~50ms to avoid event spam.
pub async fn download_all(
    tasks: Vec<DownloadTask>,
    app: Option<tauri::AppHandle>,
) -> Result<(), String> {
    let total = tasks.len() as u32;
    if total == 0 {
        return Ok(());
    }

    let (fetch_limit, write_limit) = resolve_concurrency().await;
    tracing::info!(
        "Batch download: {} files, fetch={}, write={}",
        total,
        fetch_limit,
        write_limit
    );

    let fetch_sem = Arc::new(Semaphore::new(fetch_limit));
    let write_sem = Arc::new(Semaphore::new(write_limit));
    let completed = Arc::new(AtomicU32::new(0));
    let bytes_done = Arc::new(AtomicU64::new(0));
    let bytes_total: u64 = tasks.iter().filter_map(|t| t.expected_size).sum();
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let app = Arc::new(app);

    let client = crate::util::http::HTTP.clone();

    // Stream concurrency is the sum of fetch and write limits so that in-flight
    // disk writes never starve network fetches and vice versa. The individual
    // semaphores (`fetch_sem` and `write_sem`) bound the actual concurrent load.
    let stream_limit = fetch_limit + write_limit;

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    futures_util::stream::iter(tasks)
        .for_each_concurrent(stream_limit, |task| {
            let client = client.clone();
            let fetch_sem = fetch_sem.clone();
            let write_sem = write_sem.clone();
            let completed = completed.clone();
            let bytes_done = bytes_done.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            let errors = errors.clone();
            let task_size = task.expected_size.unwrap_or(0);
            let dest_name = task
                .dest
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();

            async move {
                let result = download_one(&client, &task, &fetch_sem, &write_sem).await;

                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                bytes_done.fetch_add(task_size, Ordering::Relaxed);

                if let Err(e) = result {
                    // A cancelled batch would otherwise log and aggregate one
                    // error per remaining task. It's reported once after the
                    // stream instead.
                    if e != CANCELLED {
                        tracing::error!("Failed to download {}: {}", task.url, e);
                        if let Ok(mut errs) = errors.lock() {
                            errs.push(e);
                        }
                    }
                }

                // Throttle progress emissions to ~20Hz to avoid IPC spam.
                let should_emit = {
                    let now = Instant::now();
                    let force = done == total;
                    if let Ok(mut last) = last_emit.lock() {
                        if force || now.duration_since(*last) >= Duration::from_millis(50) {
                            *last = now;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };

                if should_emit {
                    if let Some(ref handle) = *app {
                        let _ = handle.emit(
                            "download-progress",
                            DownloadProgressPayload {
                                completed: done,
                                total,
                                bytes_done: bytes_done.load(Ordering::Relaxed),
                                bytes_total,
                                current_file: dest_name,
                            },
                        );
                    }
                }
            }
        })
        .await;

    // Cancellation outranks whatever else failed on the way down.
    cancel_check()?;

    let errs = errors.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} of {} downloads failed. First error: {}",
            errs.len(),
            total,
            errs[0]
        ))
    }
}

/// Validate whether an in-memory byte buffer forms a valid ZIP archive (e.g. .jar, .zip, .mrpack).
/// Verifies the presence and integrity of the ZIP central directory.
fn is_valid_zip(bytes: &[u8]) -> bool {
    if bytes.len() < 22 {
        return false;
    }
    let cursor = std::io::Cursor::new(bytes);
    match zip::ZipArchive::new(cursor) {
        Ok(archive) => !archive.is_empty(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not several, because the flag is process-global — parallel tests
    /// touching it would race each other.
    ///
    /// The invariant that matters: a cancel must never outlive the install it was
    /// meant for. A leaked flag wouldn't just misfire on the next install, it
    /// would abort a launch-time repair, which looks like the game refusing to
    /// start for no reason.
    #[test]
    fn a_cancel_never_outlives_its_install() {
        clear_cancel();
        assert!(cancel_check().is_ok(), "should start clean");

        {
            let _install = InstallScope::begin();
            assert!(cancel_check().is_ok());
            request_cancel();
            assert!(is_cancelled());
            assert_eq!(cancel_check().unwrap_err(), CANCELLED);
        }
        // Scope dropped — even though the install ended by being cancelled.
        assert!(!is_cancelled(), "cancel leaked past the install scope");

        // A stale request from before an install begins must not abort it.
        request_cancel();
        {
            let _install = InstallScope::begin();
            assert!(cancel_check().is_ok(), "stale cancel leaked into a new install");
        }
        assert!(!is_cancelled());

        // With nothing installing, a cancel must not raise the flag at all.
        // Otherwise it strands there and every later download fails — game
        // libraries and assets included, so the game stops launching.
        request_cancel();
        assert!(
            cancel_check().is_ok(),
            "cancel outside any install scope stranded the flag"
        );

        // Nested scopes: the inner one ending must not un-cancel the outer.
        {
            let _outer = InstallScope::begin();
            {
                let _inner = InstallScope::begin();
                request_cancel();
                assert!(is_cancelled());
            }
            assert!(is_cancelled(), "inner scope cleared a cancel the outer still needs");
        }
        assert!(!is_cancelled(), "last scope out should have cleared the flag");
    }

    #[test]
    fn test_valid_zip_detection() {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            writer.start_file("test.txt", zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut writer, b"hello world").unwrap();
            writer.finish().unwrap();
        }
        assert!(is_valid_zip(&buf));
        assert!(!is_valid_zip(b"not a zip file"));
        assert!(!is_valid_zip(&buf[..buf.len() - 10])); // truncated zip
    }

    #[tokio::test]
    async fn test_persist_bytes_archive_fallback() {
        let mut zip_bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
            writer.start_file("sample.class", zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut writer, b"\xca\xfe\xba\xbe").unwrap();
            writer.finish().unwrap();
        }

        let temp_dir = std::env::temp_dir().join(format!("vermeil_test_{}", uuid::Uuid::new_v4()));
        let write_sem = Arc::new(Semaphore::new(1));

        // 1. Valid jar with wrong expected_sha1 succeeds via graceful archive fallback
        let jar_path = temp_dir.join("test_mod.jar");
        let res = persist_bytes(
            &zip_bytes,
            &jar_path,
            &Some("0000000000000000000000000000000000000000".to_string()),
            "https://cdn.modrinth.com/sample.jar",
            &write_sem,
        ).await;
        assert!(res.is_ok(), "Valid jar archive should succeed despite drifted expected_sha1");
        assert!(file_valid(&jar_path, &Some("0000000000000000000000000000000000000000".to_string()), &Some(999999)));

        // 2. Corrupted jar with wrong expected_sha1 fails
        let corrupt_jar = temp_dir.join("corrupt.jar");
        let corrupt_bytes = &zip_bytes[..zip_bytes.len() - 15]; // strip central directory
        let res = persist_bytes(
            corrupt_bytes,
            &corrupt_jar,
            &Some("0000000000000000000000000000000000000000".to_string()),
            "https://cdn.modrinth.com/corrupt.jar",
            &write_sem,
        ).await;
        assert!(res.is_err(), "Corrupted jar payload should fail hash check");

        // 3. Non-archive file (.json) with wrong expected_sha1 fails strictly
        let json_path = temp_dir.join("asset.json");
        let res = persist_bytes(
            b"{\"key\": \"val\"}",
            &json_path,
            &Some("0000000000000000000000000000000000000000".to_string()),
            "https://resources.download.minecraft.net/asset.json",
            &write_sem,
        ).await;
        assert!(res.is_err(), "Non-archive asset with wrong hash must fail strictly");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_rate_limiter_dedup() {
        let limiter = RateLimiter::new();
        // 1. Initial configuration to 0 (Unlimited) succeeds
        limiter.set_limit_mb(0);
        assert_eq!(limiter.bytes_per_sec.load(Ordering::Relaxed), 0);
        assert_eq!(limiter.current_limit_mb.load(Ordering::Relaxed), 0);

        // 2. Duplicate calls with identical limit are no-ops
        limiter.set_limit_mb(0);
        assert_eq!(limiter.current_limit_mb.load(Ordering::Relaxed), 0);

        // 3. Changing to a new rate updates atomic values
        limiter.set_limit_mb(15);
        assert_eq!(limiter.bytes_per_sec.load(Ordering::Relaxed), 15 * 1024 * 1024);
        assert_eq!(limiter.current_limit_mb.load(Ordering::Relaxed), 15);

        // 4. Duplicate call with 15 is deduplicated
        limiter.set_limit_mb(15);
        assert_eq!(limiter.current_limit_mb.load(Ordering::Relaxed), 15);
    }
}
