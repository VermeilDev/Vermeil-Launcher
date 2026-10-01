// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Platform-detection helpers used across the launcher.
//!
//! Centralizes OS-specific constants so individual services don't need to
//! repeat `cfg!(windows)` / `cfg!(target_os = "linux")` checks inline.

/// The OS name as Mojang uses it in version.json rules (`os.name` field).
/// Returns `"windows"`, `"linux"`, or `"osx"`.
pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// The classpath separator for the current platform.
/// Windows uses `;`, everything else uses `:`.
pub fn classpath_separator() -> &'static str {
    if cfg!(windows) { ";" } else { ":" }
}

/// The Java executable name for the current platform.
/// Windows: `java.exe`. Linux/macOS: `java`.
pub fn java_exe_name() -> &'static str {
    if cfg!(windows) { "java.exe" } else { "java" }
}

/// The OS segment for Adoptium API URLs.
/// Returns `"windows"`, `"linux"`, or `"mac"`.
pub fn adoptium_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

/// The architecture segment for Adoptium API URLs.
/// Returns `"x64"` or `"aarch64"`.
pub fn adoptium_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    }
}

/// The natives map key used in version.json formats.
/// Returns `"windows"`, `"linux"`, or `"osx"`.
pub fn natives_map_key() -> &'static str {
    os_name()
}

/// The file extension for Java runtime archives from Adoptium.
/// Windows: `.zip`. Linux/macOS: `.tar.gz`.
pub fn java_archive_ext() -> &'static str {
    if cfg!(windows) { ".zip" } else { ".tar.gz" }
}

/// Extract a Java runtime archive to the given directory.
/// Handles `.zip` on Windows and `.tar.gz` on Linux/macOS.
pub fn extract_java_archive(archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use std::collections::HashSet;
    use std::fs;
    use std::io;

    fs::create_dir_all(dest_dir).map_err(|e| format!("Create dir: {}", e))?;

    if cfg!(windows) {
        // ZIP extraction
        let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let buf_file = io::BufReader::with_capacity(256 * 1024, file);
        let mut archive = zip::ZipArchive::new(buf_file).map_err(|e| format!("Open zip: {}", e))?;
        let mut created_dirs = HashSet::new();
        created_dirs.insert(dest_dir.to_path_buf());

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry: {}", e))?;
            let enclosed = match entry.enclosed_name() {
                Some(p) => p.to_owned(),
                None => continue,
            };
            let outpath = dest_dir.join(enclosed);

            if entry.is_dir() {
                if created_dirs.insert(outpath.clone()) {
                    let _ = fs::create_dir_all(&outpath);
                }
            } else {
                if let Some(parent) = outpath.parent() {
                    if created_dirs.insert(parent.to_path_buf()) {
                        let _ = fs::create_dir_all(parent);
                    }
                }
                let mut outfile = fs::File::create(&outpath).map_err(|e| format!("Create file {}: {}", outpath.display(), e))?;
                io::copy(&mut entry, &mut outfile).map_err(|e| format!("Extract file {}: {}", outpath.display(), e))?;
            }
        }
    } else {
        // tar.gz extraction
        let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let buf_file = io::BufReader::with_capacity(256 * 1024, file);
        let gz = flate2::read::GzDecoder::new(buf_file);
        let mut archive = tar::Archive::new(gz);
        archive.unpack(dest_dir).map_err(|e| format!("Extract tar.gz: {}", e))?;
    }

    Ok(())
}

#[cfg(windows)]
static IS_UPDATING_ESTIMATED_SIZE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(windows)]
static LAST_ESTIMATED_SIZE_KB: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// On Windows, updates the `EstimatedSize` registry DWORD (in KB) under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Vermeil`
/// to reflect the true size of `%LOCALAPPDATA%\Vermeil` (instances, assets, cache, java).
///
/// Without this, Windows Settings ("Installed Apps") only displays the initial static
/// ~26 MB size of the unpacked `vermeil.exe` from install time rather than the true disk usage.
/// On non-Windows platforms, this is a compile-time no-op.
pub fn update_windows_estimated_size() {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        if IS_UPDATING_ESTIMATED_SIZE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // Another background sizing pass is already running; avoid duplicate I/O
            return;
        }

        std::thread::spawn(|| {
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    IS_UPDATING_ESTIMATED_SIZE.store(false, Ordering::SeqCst);
                }
            }
            let _guard = Guard;

            use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
            use winreg::RegKey;

            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            if let Ok(uninstall_key) = hkcu.open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Vermeil",
                KEY_WRITE,
            ) {
                let data_dir = crate::util::paths::data_dir();
                if data_dir.exists() {
                    let size_bytes = crate::util::paths::dir_size(&data_dir);
                    let size_kb = (size_bytes / 1024).min(u32::MAX as u64) as u32;
                    let prev_kb = LAST_ESTIMATED_SIZE_KB.swap(size_kb, Ordering::SeqCst);
                    if prev_kb == size_kb {
                        tracing::debug!("Windows uninstall EstimatedSize unchanged at {} KB", size_kb);
                        return;
                    }
                    if let Err(e) = uninstall_key.set_value("EstimatedSize", &size_kb) {
                        tracing::warn!("Failed to set Windows uninstall EstimatedSize: {}", e);
                    } else {
                        tracing::info!("Updated Windows uninstall EstimatedSize to {} KB", size_kb);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn test_estimated_size_deduplication() {
        use std::sync::atomic::Ordering;
        LAST_ESTIMATED_SIZE_KB.store(1500, Ordering::SeqCst);
        let prev = LAST_ESTIMATED_SIZE_KB.swap(1500, Ordering::SeqCst);
        assert_eq!(prev, 1500, "Unchanged size matches previous and detects duplicate");

        let prev2 = LAST_ESTIMATED_SIZE_KB.swap(1800, Ordering::SeqCst);
        assert_eq!(prev2, 1500, "Changed size detects delta");
        assert_eq!(LAST_ESTIMATED_SIZE_KB.load(Ordering::SeqCst), 1800);
    }
}

