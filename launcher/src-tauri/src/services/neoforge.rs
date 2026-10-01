// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::download::{DownloadTask, download_all, download_file};
use crate::util::paths;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";

/// Maven coordinate to file path
fn maven_to_path(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];

    // Handle classifier with optional extension (e.g. "name@zip" or "classifier@ext")
    let (last, ext) = if parts.len() >= 4 {
        let p = parts[3];
        if let Some(idx) = p.find('@') {
            (Some(&p[..idx]), &p[idx + 1..])
        } else {
            (Some(p), "jar")
        }
    } else {
        // version may also contain @ext
        let v_parts: Vec<&str> = version.split('@').collect();
        if v_parts.len() == 2 {
            return format!("{}/{}/{}/{}-{}.{}", group, artifact, v_parts[0], artifact, v_parts[0], v_parts[1]);
        }
        (None, "jar")
    };

    let actual_version = version.split('@').next().unwrap_or(version);

    if let Some(classifier) = last {
        format!("{}/{}/{}/{}-{}-{}.{}", group, artifact, actual_version, artifact, actual_version, classifier, ext)
    } else {
        format!("{}/{}/{}/{}-{}.{}", group, artifact, actual_version, artifact, actual_version, ext)
    }
}

/// Emit a progress event with the current installer phase. Used by the
/// streaming-stdout reader so the UI shows the actual processor name
/// instead of sitting frozen at "Running NeoForge installer".
fn emit_phase(app: Option<&tauri::AppHandle>, instance_name: &str, message: &str) {
    if let Some(handle) = app {
        let _ = handle.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: instance_name.to_string(),
                message: message.to_string(),
                fraction: 0.99,
                skipped: false,
            },
        );
    }
}

/// Best-effort phase mapping from a single line of installer stdout.
///
/// The Forge / NeoForge installer logs each step it's about to take. We
/// don't try to parse every variant — just match a few high-signal
/// keywords and translate them to user-friendly progress text. Lines
/// that don't match return `None` and we keep the previous phase up.
fn classify_installer_line(line: &str) -> Option<&'static str> {
    let lower = line.to_lowercase();
    if lower.contains("downloading") && lower.contains("librar") {
        Some("Downloading loader libraries")
    } else if lower.contains("considering library") {
        Some("Resolving loader libraries")
    } else if lower.contains("binarypatcher") {
        Some("Patching client (BinaryPatcher)")
    } else if lower.contains("jarsplitter") {
        Some("Splitting client jar (JarSplitter)")
    } else if lower.contains("specialsource") {
        Some("Remapping client (SpecialSource)")
    } else if lower.contains("mergemappings") || lower.contains("merge mappings") {
        Some("Merging mappings")
    } else if lower.contains("processor")
        && (lower.contains("running") || lower.contains("execute"))
    {
        Some("Running loader processor")
    } else if lower.contains("installing client") {
        Some("Installing client")
    } else if lower.contains("extracting") {
        Some("Extracting installer payload")
    } else {
        None
    }
}

/// Run the Forge/NeoForge installer JAR in headless client-install mode.
/// This makes the installer perform all processor steps itself (BinaryPatcher, JarSplitter, etc).
/// For old Forge (pre-1.13), reads install_profile.json from the jar directly.
///
/// `app` is used to stream phase updates into the UI's install progress
/// popup. `instance_name` is the title shown next to the phase text. Both
/// are optional — if not supplied the install runs silently as before.
async fn run_installer_headless(
    installer_path: &Path,
    instance_dir: &Path,
    java_exe: &Path,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(), String> {
    // The Forge/NeoForge installer expects a launcher_profiles.json to exist in its target dir.
    let stub = instance_dir.join("launcher_profiles.json");
    if !stub.exists() {
        fs::create_dir_all(instance_dir).map_err(|e| format!("Create instance dir: {}", e))?;
        let mut f = fs::File::create(&stub).map_err(|e| format!("Create stub launcher_profiles: {}", e))?;
        f.write_all(b"{\"profiles\":{},\"settings\":{},\"version\":3}")
            .map_err(|e| format!("Write stub: {}", e))?;
    }

    tracing::debug!("Running installer headless: {}", installer_path.display());

    // Try modern mode first (--installClient).
    //
    // We use `tokio::process::Command::spawn` (not `output`) so we can
    // stream the installer's stdout line-by-line into the progress popup
    // in real time. Without this the UI shows a single "Running installer"
    // string for the entire 30-60s install and the user thinks the app
    // hung. Stderr is still buffered for the error path.
    emit_phase(app, instance_name, "Starting loader installer");

    let sys_mb = crate::services::memory::system_memory_mb();
    let max_mb = if sys_mb >= 8192 {
        2048
    } else if sys_mb >= 4096 {
        1536
    } else {
        1024
    };
    let init_mb = (max_mb / 4).max(256);

    let mut cmd = Command::new(java_exe);
    cmd.arg(format!("-Xms{}m", init_mb))
        .arg(format!("-Xmx{}m", max_mb))
        .arg("-XX:+TieredCompilation")
        .arg("-XX:TieredStopAtLevel=1")
        .arg("-Djava.net.preferIPv4Stack=true")
        .arg("-XX:+UseG1GC")
        .arg("-Djava.awt.headless=true")
        .arg("-jar")
        .arg(installer_path)
        .arg("--installClient")
        .arg(instance_dir)
        .current_dir(instance_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Hide the console window the JVM would otherwise spawn on Windows.
    // `tokio::process::Command` provides `creation_flags` directly on
    // Windows targets without needing the `CommandExt` import.
    #[cfg(windows)]
    {
        cmd.creation_flags(crate::services::java::CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Spawn installer: {}", e))?;

    // Capture stdout for phase classification + a buffered tail in case the
    // installer fails. We keep the last ~40 stdout lines around so the error
    // message has context, mirroring the previous `output()` behavior.
    let mut tail: Vec<String> = Vec::with_capacity(40);

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(phase) = classify_installer_line(&line) {
                emit_phase(app, instance_name, phase);
            }
            tracing::trace!("installer stdout: {}", line);
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
    }

    // Now wait for the process to exit and collect the exit status + stderr.
    let stderr_buf = if let Some(mut stderr) = child.stderr.take() {
        let mut buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf).await;
        buf
    } else {
        String::new()
    };

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Wait for installer: {}", e))?;

    if status.success() {
        emit_phase(app, instance_name, "Loader installer finished");
        return Ok(());
    }

    // If the installer doesn't recognize --installClient, it's old Forge.
    // For old Forge, we extract install_profile.json from the jar and write it
    // as a version JSON so the rest of the pipeline can use it.
    if stderr_buf.contains("not a recognized option") || stderr_buf.contains("installClient") {
        tracing::debug!("Old Forge installer detected, extracting profile from jar");
        emit_phase(app, instance_name, "Reading legacy Forge profile");
        extract_old_forge_profile(installer_path, instance_dir)?;
        return Ok(());
    }

    Err(format!(
        "Installer failed (exit {}):\nstdout (tail): {}\nstderr: {}",
        status,
        tail.join("\n"),
        stderr_buf.lines().take(20).collect::<Vec<_>>().join("\n")
    ))
}

/// Extract the install_profile.json from an old Forge installer jar and convert
/// its versionInfo into a version JSON that our pipeline can use.
fn extract_old_forge_profile(installer_path: &Path, instance_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(installer_path).map_err(|e| format!("Open installer: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Open zip: {}", e))?;

    // Read install_profile.json from the jar
    let profile_json = {
        let mut entry = archive.by_name("install_profile.json")
            .map_err(|e| format!("No install_profile.json in installer: {}", e))?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content)
            .map_err(|e| format!("Read install_profile.json: {}", e))?;
        content
    };

    let profile: serde_json::Value = serde_json::from_str(&profile_json)
        .map_err(|e| format!("Parse install_profile.json: {}", e))?;

    // The old format has "versionInfo" which is essentially a version JSON
    let version_info = profile.get("versionInfo")
        .ok_or("No versionInfo in install_profile.json")?;

    // Get the version ID
    let version_id = version_info.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("forge");

    // Write it as a version JSON in the versions directory
    let versions_dir = instance_dir.join("versions").join(version_id);
    fs::create_dir_all(&versions_dir).map_err(|e| format!("Create versions dir: {}", e))?;

    let version_path = versions_dir.join(format!("{}.json", version_id));
    let json_str = serde_json::to_string_pretty(version_info)
        .map_err(|e| format!("Serialize version info: {}", e))?;
    fs::write(&version_path, json_str).map_err(|e| format!("Write version json: {}", e))?;

    // Also extract the universal jar from the installer if present
    // Old installers contain the forge universal jar inside
    let install_info = profile.get("install");
    if let Some(info) = install_info {
        if let Some(file_path) = info.get("filePath").and_then(|v| v.as_str()) {
            // Try to extract the universal jar
            if let Ok(mut jar_entry) = archive.by_name(file_path) {
                let libs_dir = paths::libraries_dir();
                // Determine the library path from the "path" field
                if let Some(maven_path) = info.get("path").and_then(|v| v.as_str()) {
                    let rel_path = maven_to_path(maven_path);
                    let dest = libs_dir.join(&rel_path);
                    if !dest.exists() {
                        if let Some(parent) = dest.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let mut outfile = fs::File::create(&dest)
                            .map_err(|e| format!("Create universal jar: {}", e))?;
                        std::io::copy(&mut jar_entry, &mut outfile)
                            .map_err(|e| format!("Extract universal jar: {}", e))?;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Find the version.json the installer wrote into instance_dir/versions/<id>/<id>.json
/// Prefers the loader-specific version (not vanilla) by checking for inheritsFrom field
fn find_version_json(instance_dir: &Path) -> Result<(String, serde_json::Value), String> {
    let versions_dir = instance_dir.join("versions");
    if !versions_dir.exists() {
        return Err("Installer did not create versions/ directory".to_string());
    }

    let entries = fs::read_dir(&versions_dir)
        .map_err(|e| format!("Read versions/: {}", e))?;

    let mut candidates: Vec<(String, serde_json::Value)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let id = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let json_path = path.join(format!("{}.json", id));
        if json_path.exists() {
            if let Ok(content) = fs::read_to_string(&json_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    candidates.push((id, parsed));
                }
            }
        }
    }

    // Prefer the version that has inheritsFrom (that's the loader version, not vanilla)
    if let Some(loader_ver) = candidates.iter().find(|(_, v)| v.get("inheritsFrom").is_some()) {
        return Ok(loader_ver.clone());
    }

    // Fallback to any version found
    candidates.into_iter().next()
        .ok_or("No version.json found in instance versions/ directory".to_string())
}

/// RAII guard to create and safely unlink `<instance_dir>/libraries` junction/symlink.
struct LibrariesLinkGuard {
    link_path: PathBuf,
    target_path: PathBuf,
    is_linked: bool,
}

impl LibrariesLinkGuard {
    pub fn link(instance_dir: &Path, libs_dir: &Path) -> Self {
        let link_path = instance_dir.join("libraries");
        Self::clean_existing_path(&link_path);

        let is_linked = Self::create_link(libs_dir, &link_path);
        if !is_linked {
            tracing::warn!(
                "Failed to link {} -> {}, falling back to copy",
                link_path.display(),
                libs_dir.display()
            );
        } else {
            tracing::debug!("Linked {} -> {}", link_path.display(), libs_dir.display());
        }

        Self {
            link_path,
            target_path: libs_dir.to_path_buf(),
            is_linked,
        }
    }

    #[cfg(windows)]
    fn create_link(target: &Path, link: &Path) -> bool {
        // cmd /C mklink /J <link> <target> creates an NTFS directory junction.
        // Junctions work without Administrator privileges or Developer Mode on Windows.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(crate::services::java::CREATE_NO_WINDOW)
            .output();
        match status {
            Ok(out) if out.status.success() => true,
            Ok(out) => {
                tracing::warn!("mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
                false
            }
            Err(e) => {
                tracing::warn!("mklink /J spawn error: {}", e);
                false
            }
        }
    }

    #[cfg(not(windows))]
    fn create_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    fn remove_link(link: &Path) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            // Win32 RemoveDirectory on a junction removes the junction link itself,
            // never the target directory or its contents.
            std::fs::remove_dir(link)
        }
        #[cfg(not(windows))]
        {
            std::fs::remove_file(link)
        }
    }

    fn clean_existing_path(path: &Path) {
        if std::fs::symlink_metadata(path).is_ok()
            && Self::remove_link(path).is_err() {
                let _ = std::fs::remove_dir_all(path);
            }
    }

    pub fn finish(mut self) -> Result<(), String> {
        if self.is_linked {
            Self::clean_existing_path(&self.link_path);
            self.is_linked = false;
        } else if self.link_path.exists() {
            copy_dir_merge(&self.link_path, &self.target_path)?;
            let _ = std::fs::remove_dir_all(&self.link_path);
        }
        Ok(())
    }
}

impl Drop for LibrariesLinkGuard {
    fn drop(&mut self) {
        if self.is_linked {
            Self::clean_existing_path(&self.link_path);
        }
    }
}

/// Extract all bundled Maven artifacts stored inside the installer JAR (under `maven/`)
/// directly into the shared libraries directory.
fn extract_bundled_installer_libraries(installer_path: &Path) -> Result<(), String> {
    let file = fs::File::open(installer_path)
        .map_err(|e| format!("Open installer {}: {}", installer_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Open installer zip: {}", e))?;
    let libs_dir = paths::libraries_dir();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Read zip entry: {}", e))?;
        let name = entry.name().to_string();
        if name.starts_with("maven/") && !name.ends_with('/') {
            let rel_path = &name["maven/".len()..];
            let dest = libs_dir.join(rel_path);
            if !dest.exists() {
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(mut outfile) = fs::File::create(&dest) {
                    let _ = std::io::copy(&mut entry, &mut outfile);
                }
            }
        }
    }
    Ok(())
}

/// Read a named text entry from a zip archive into a String.
fn read_zip_entry_to_string(archive: &mut zip::ZipArchive<fs::File>, entry_name: &str) -> Option<String> {
    let mut entry = archive.by_name(entry_name).ok()?;
    let mut content = String::new();
    std::io::Read::read_to_string(&mut entry, &mut content).ok()?;
    Some(content)
}

fn copy_dir_merge(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.is_dir() { return Ok(()); }
    fs::create_dir_all(dest).map_err(|e| format!("Create dir: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Read dir: {}", e))?.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_merge(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to).map_err(|e| format!("Copy file: {}", e))?;
        }
    }
    Ok(())
}

/// Collect download tasks for libraries declared in an install_profile.json or version.json.
/// Deduplicates across sources and skips files already present in `libs_dir`.
fn collect_json_library_tasks(
    json_val: &serde_json::Value,
    libs_dir: &Path,
    tasks: &mut Vec<DownloadTask>,
    paths_out: &mut Vec<PathBuf>,
    seen_dest: &mut HashSet<PathBuf>,
) {
    let libraries = match json_val.get("libraries").and_then(|v| v.as_array()) {
        Some(l) => l,
        None => return,
    };

    for lib in libraries {
        if lib.get("natives").is_some() { continue; }

        if let Some(artifact) = lib.get("downloads").and_then(|d| d.get("artifact")) {
            let path = artifact.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() { continue; }

            let dest = libs_dir.join(path);
            if seen_dest.insert(dest.clone()) && !dest.exists() {
                if let Some(url) = artifact.get("url").and_then(|u| u.as_str()) {
                    if !url.is_empty() {
                        tasks.push(DownloadTask {
                            url: url.to_string(),
                            dest: dest.clone(),
                            expected_sha1: artifact.get("sha1").and_then(|s| s.as_str()).map(|s| s.to_string()),
                            expected_size: artifact.get("size").and_then(|s| s.as_u64()),
                        });
                    }
                }
            }
            paths_out.push(dest);
        } else if let Some(name) = lib.get("name").and_then(|n| n.as_str()) {
            let rel_path = maven_to_path(name);
            let dest = libs_dir.join(&rel_path);

            if seen_dest.insert(dest.clone()) && !dest.exists() {
                let base_url = lib.get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("https://libraries.minecraft.net/");

                let base = if base_url.ends_with('/') {
                    base_url.to_string()
                } else {
                    format!("{}/", base_url)
                };
                let base = base.replace("http://", "https://");
                let url = format!("{}{}", base, rel_path);

                tasks.push(DownloadTask {
                    url,
                    dest: dest.clone(),
                    expected_sha1: None,
                    expected_size: None,
                });
            }
            paths_out.push(dest);
        }
    }
}

/// Resolve all libraries listed in the installer's version.json to actual paths,
/// downloading any that aren't yet in the shared libraries dir.
async fn resolve_libraries(
    version_json: &serde_json::Value,
    app: Option<&tauri::AppHandle>,
) -> Result<Vec<PathBuf>, String> {
    let libs_dir = paths::libraries_dir();
    let mut paths_out = Vec::new();
    let mut tasks = Vec::new();
    let mut seen_dest = HashSet::new();

    collect_json_library_tasks(version_json, &libs_dir, &mut tasks, &mut paths_out, &mut seen_dest);

    if !tasks.is_empty() {
        download_all(tasks, app.cloned()).await?;
    }

    paths_out.retain(|p| p.exists());
    Ok(paths_out)
}

lazy_static::lazy_static! {
    static ref INSTALLER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

/// Run the Forge/NeoForge installer if not already done for this instance.
/// Returns (main_class, classpath libs, extra JVM args, extra game args)
async fn ensure_installer_ran(
    installer_url: &str,
    instance_dir: &Path,
    java_exe: &Path,
    marker_name: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
    game_version: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    let marker = instance_dir.join(format!(".{}-installed", marker_name));

    // Serialize loader installer runs across concurrent instance preparations.
    // Modern Forge and NeoForge run headless installers inside a shared scratch
    // directory with junction links to shared libraries. Serializing execution
    // prevents junction clobbering, race conditions, and corrupted files.
    // Subsequent instances immediately see marker.exists() and return in 0ms.
    let _lock = INSTALLER_LOCK.lock().await;

    if !marker.exists() {
        crate::services::download::cancel_check()?;

        // Download installer to a shared cache so multiple instances using
        // the same loader version don't re-download the 15-40MB JAR.
        let cache_dir = paths::installers_cache_dir();
        fs::create_dir_all(&cache_dir).map_err(|e| format!("Create installer cache dir: {}", e))?;
        let cache_filename = installer_url
            .rsplit('/')
            .next()
            .unwrap_or("loader-installer.jar")
            .to_string();
        let cached_installer = cache_dir.join(&cache_filename);

        if !cached_installer.exists() {
            emit_phase(app, instance_name, "Downloading loader installer");
            let task = DownloadTask {
                url: installer_url.to_string(),
                dest: cached_installer.clone(),
                expected_sha1: None,
                expected_size: None,
            };
            download_file(&crate::util::http::HTTP, &task).await?;
        } else {
            tracing::info!("Using cached installer: {}", cached_installer.display());
        }

        crate::services::download::cancel_check()?;

        // Extract bundled maven libraries from the installer JAR into shared libraries dir
        if let Err(e) = extract_bundled_installer_libraries(&cached_installer) {
            tracing::warn!("Failed extracting bundled libraries from installer: {}", e);
        }

        // Inspect install_profile.json from the installer JAR
        let file = fs::File::open(&cached_installer)
            .map_err(|e| format!("Open installer jar {}: {}", cached_installer.display(), e))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Open installer zip: {}", e))?;

        let profile_content = read_zip_entry_to_string(&mut archive, "install_profile.json")
            .ok_or_else(|| "Installer JAR missing install_profile.json".to_string())?;
        let profile: serde_json::Value = serde_json::from_str(&profile_content)
            .map_err(|e| format!("Parse install_profile.json: {}", e))?;

        // Detect legacy Forge (pre-1.13, e.g. 1.12.2, 1.7.10) which has versionInfo and NO processors.
        // It does not need the headless JVM installer to run at all!
        if profile.get("processors").is_none() && profile.get("versionInfo").is_some() {
            tracing::info!("Legacy Forge detected (no processors), extracting profile directly");
            emit_phase(app, instance_name, "Reading legacy Forge profile");
            fs::create_dir_all(instance_dir).map_err(|e| format!("Create instance dir: {}", e))?;
            extract_old_forge_profile(&cached_installer, instance_dir)?;
            let _ = fs::write(&marker, "");
        } else {
            // Modern Forge / NeoForge:
            // Pre-fetch all installer and loader libraries in parallel using Rust's async download_all.
            // When Java runs, 100% of libraries are already present, avoiding Java's slow sequential HTTP downloader!
            let libs_dir = paths::libraries_dir();
            let mut prefetch_tasks = Vec::new();
            let mut _dummy_paths = Vec::new();
            let mut seen_dest = HashSet::new();

            // 1. Collect libraries from install_profile.json (processor dependencies)
            collect_json_library_tasks(&profile, &libs_dir, &mut prefetch_tasks, &mut _dummy_paths, &mut seen_dest);

            // 2. Collect libraries from version.json (game dependencies)
            if let Some(version_content) = read_zip_entry_to_string(&mut archive, "version.json") {
                if let Ok(version_val) = serde_json::from_str::<serde_json::Value>(&version_content) {
                    collect_json_library_tasks(&version_val, &libs_dir, &mut prefetch_tasks, &mut _dummy_paths, &mut seen_dest);
                }
            }

            // Close archive before downloading so the file handle is released
            drop(archive);

            // 3. Batch-download any missing libraries concurrently in parallel
            if !prefetch_tasks.is_empty() {
                emit_phase(app, instance_name, "Downloading loader libraries");
                download_all(prefetch_tasks, app.cloned()).await?;
            }

            crate::services::download::cancel_check()?;

            // Pre-seed vanilla client jar and json into <instance_dir>/versions/<mc_version>/
            fs::create_dir_all(instance_dir).map_err(|e| format!("Create instance dir: {}", e))?;
            let mc_versions_dir = instance_dir.join("versions").join(game_version);
            fs::create_dir_all(&mc_versions_dir).map_err(|e| format!("Create versions dir: {}", e))?;

            let target_jar = mc_versions_dir.join(format!("{}.jar", game_version));
            if !target_jar.exists() {
                let shared_jar = paths::versions_cache_dir().join(format!("{}.jar", game_version));
                if shared_jar.exists()
                    && fs::hard_link(&shared_jar, &target_jar).is_err() {
                        let _ = fs::copy(&shared_jar, &target_jar);
                    }
            }

            let target_json = mc_versions_dir.join(format!("{}.json", game_version));
            if !target_json.exists() {
                let shared_json = paths::meta_dir().join("versions").join(format!("{}.json", game_version));
                if shared_json.exists()
                    && fs::hard_link(&shared_json, &target_json).is_err() {
                        let _ = fs::copy(&shared_json, &target_json);
                    }
            }

            // Link <instance_dir>/libraries directly to paths::libraries_dir() via NTFS junction or symlink.
            // This lets the installer find all pre-cached libraries with 0 network calls and write its
            // processor outputs directly into the shared libraries directory.
            let link_guard = LibrariesLinkGuard::link(instance_dir, &libs_dir);

            // Run the headless installer
            let install_result = run_installer_headless(&cached_installer, instance_dir, java_exe, app, instance_name).await;

            // Unlink or migrate
            link_guard.finish()?;

            if let Err(e) = install_result {
                // If the installer failed, clean up the scratch dir so subsequent attempts don't inherit a corrupted state
                let _ = fs::remove_dir_all(instance_dir);
                return Err(e);
            }

            // Mark as done
            let _ = fs::write(&marker, "");
        }
    }

    // Read the version.json the installer produced
    let (_id, version_json) = find_version_json(instance_dir)?;

    let main_class = version_json.get("mainClass")
        .and_then(|v| v.as_str())
        .ok_or("No mainClass in installer version.json")?
        .to_string();

    emit_phase(app, instance_name, "Verifying loader libraries");
    let libs = resolve_libraries(&version_json, app).await?;

    // JVM args
    let mut jvm_args = Vec::new();
    if let Some(args) = version_json.get("arguments").and_then(|a| a.get("jvm")).and_then(|j| j.as_array()) {
        for arg in args {
            if let Some(s) = arg.as_str() {
                jvm_args.push(s.to_string());
            }
        }
    }

    // Game args — handle both modern (arguments.game array) and old (minecraftArguments string) formats
    let mut game_args = Vec::new();
    if let Some(args) = version_json.get("arguments").and_then(|a| a.get("game")).and_then(|g| g.as_array()) {
        for arg in args {
            if let Some(s) = arg.as_str() {
                game_args.push(s.to_string());
            }
        }
    } else if let Some(mc_args) = version_json.get("minecraftArguments").and_then(|v| v.as_str()) {
        // Old format: extract only the --tweakClass arguments (the rest are vanilla args
        // that launch.rs already provides via build_game_args)
        let parts: Vec<&str> = mc_args.split_whitespace().collect();
        let mut i = 0;
        while i < parts.len() {
            if parts[i] == "--tweakClass" && i + 1 < parts.len() {
                game_args.push("--tweakClass".to_string());
                game_args.push(parts[i + 1].to_string());
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    Ok((main_class, libs, jvm_args, game_args))
}

/// Resolve the official NeoForge installer URL from Maven for a given loader version.
pub fn resolve_neoforge_installer_url(loader_version: &str) -> String {
    format!(
        "{}/net/neoforged/neoforge/{}/neoforge-{}-installer.jar",
        NEOFORGE_MAVEN, loader_version, loader_version
    )
}

/// Normalize Forge coordinate format into `{game_version}-{forge_version}`.
pub fn canonical_forge_version(game_version: &str, loader_version: &str) -> String {
    if loader_version.starts_with(&format!("{}-", game_version)) {
        let suffix = format!("-{}", game_version);
        if loader_version.ends_with(&suffix) && loader_version.len() > suffix.len() + game_version.len() + 1 {
            loader_version[..loader_version.len() - suffix.len()].to_string()
        } else {
            loader_version.to_string()
        }
    } else {
        format!("{}-{}", game_version, loader_version)
    }
}

/// Resolve the Forge installer URL, probing standard 1.13+ vs legacy pre-1.13 Maven coordinates.
pub async fn resolve_forge_installer_url(game_version: &str, loader_version: &str) -> String {
    let full_version = canonical_forge_version(game_version, loader_version);
    let standard_url = format!(
        "{}/net/minecraftforge/forge/{}/forge-{}-installer.jar",
        FORGE_MAVEN, full_version, full_version
    );

    match crate::util::http::HTTP.head(&standard_url).send().await {
        Ok(resp) if resp.status().is_success() => standard_url,
        _ => {
            let legacy_version = format!("{}-{}", full_version, game_version);
            let legacy_url = format!(
                "{}/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                FORGE_MAVEN, legacy_version, legacy_version
            );
            tracing::info!(
                "Forge standard URL not found, using legacy format: {}",
                legacy_url
            );
            legacy_url
        }
    }
}

/// Get a Java executable suitable for running the installer for the given Minecraft version.
/// Prioritizes the exact version downloaded/required by the game to ensure compatibility.
async fn ensure_java_for_loader(game_version: &str) -> Result<PathBuf, String> {
    let req_ver = crate::services::launch::required_java_version(game_version);

    // 1. Prefer the exact required Java version (already downloaded by prepare.rs)
    if let Some(exe) = crate::services::java::find_managed_java(req_ver) {
        return Ok(exe);
    }

    // 2. Try compatible Java versions
    let candidates: &[u8] = match req_ver {
        8 => &[8, 17, 21, 25],
        17 => &[17, 21, 25],
        21 => &[21, 25, 17],
        _ => &[25, 21, 17, 8],
    };

    for &v in candidates {
        if let Some(exe) = crate::services::java::find_managed_java(v) {
            return Ok(exe);
        }
    }

    // Fallback: trigger download for this exact game version
    crate::services::launch::ensure_java_public(game_version).await
}

/// Public: ensure NeoForge libraries and processor outputs are ready.
pub async fn ensure_neoforge_libraries(
    game_version: &str,
    loader_version: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    let installer_url = resolve_neoforge_installer_url(loader_version);
    let scratch = paths::scratch_dir().join(format!("neoforge-{}", loader_version));
    let java_exe = ensure_java_for_loader(game_version).await?;

    ensure_installer_ran(&installer_url, &scratch, &java_exe, "neoforge", app, instance_name, game_version).await
}

/// Public: ensure Forge libraries and processor outputs are ready.
pub async fn ensure_forge_libraries(
    game_version: &str,
    loader_version: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    let full_version = canonical_forge_version(game_version, loader_version);
    let scratch = paths::scratch_dir().join(format!("forge-{}", full_version));
    let marker = scratch.join(".forge-installed");
    let installer_url = if !marker.exists() {
        resolve_forge_installer_url(game_version, loader_version).await
    } else {
        String::new()
    };
    let java_exe = ensure_java_for_loader(game_version).await?;

    ensure_installer_ran(&installer_url, &scratch, &java_exe, "forge", app, instance_name, game_version).await
}

