// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use std::path::PathBuf;

/// Returns the root data directory for the launcher.
///
/// This is **local** (non-roaming) app data: the launcher's data is large
/// (instances, Java runtimes, libraries, the Minecraft asset cache) and
/// machine-specific, so it must not roam across machines in a domain profile.
///
/// - Windows: `%LOCALAPPDATA%/Vermeil`
/// - macOS: `~/Library/Application Support/Vermeil`
/// - Linux: `~/.local/share/Vermeil`
pub fn data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Vermeil")
}

/// Returns the root cache directory for temporary, purgeable, and re-downloadable files.
///
/// - Windows: `%LOCALAPPDATA%/Vermeil/cache`
/// - macOS: `~/Library/Application Support/Vermeil/cache`
/// - Linux: `~/.local/share/Vermeil/cache`
pub fn cache_dir() -> PathBuf {
    data_dir().join("cache")
}

/// Returns the instances directory.
pub fn instances_dir() -> PathBuf {
    data_dir().join("instances")
}

/// Returns the shared assets directory.
pub fn assets_dir() -> PathBuf {
    data_dir().join("assets")
}

/// Returns the shared libraries directory.
pub fn libraries_dir() -> PathBuf {
    data_dir().join("libraries")
}

/// Returns the Java runtimes directory.
pub fn java_dir() -> PathBuf {
    data_dir().join("java")
}

/// Returns the metadata cache directory (`<cache>/meta`).
pub fn meta_dir() -> PathBuf {
    cache_dir().join("meta")
}

/// Returns the cached vanilla client JARs directory (`<cache>/versions`).
pub fn versions_cache_dir() -> PathBuf {
    cache_dir().join("versions")
}

/// Returns the cached loader installers directory (`<cache>/installers`).
pub fn installers_cache_dir() -> PathBuf {
    cache_dir().join("installers")
}

/// Returns the loader installer scratch working directory (`<cache>/scratch`).
pub fn scratch_dir() -> PathBuf {
    cache_dir().join("scratch")
}

/// Returns the project icon cache directory (`<cache>/icons`).
pub fn icons_cache_dir() -> PathBuf {
    cache_dir().join("icons")
}

/// Returns the permanent directory where theme icon files (.ico) are stored.
///
/// Under `%LOCALAPPDATA%/Vermeil/theme_icons/` (Windows) or `~/.local/share/Vermeil/theme_icons/` (Linux).
/// Kept strictly separate from any cache or legacy `icons` directories so it is NEVER purged or moved.
pub fn theme_icons_dir() -> PathBuf {
    data_dir().join("theme_icons")
}

/// Migrate legacy root-level cache folders (`icons`, `meta`, `versions`, `loader-scratch`,
/// `companion/jars`) to `<data_dir>/cache/`.
///
/// Runs once at startup. Fast and best-effort: moves folders across the same filesystem.
pub fn migrate_legacy_cache_dirs() {
    let data = data_dir();
    let cache = cache_dir();

    if let Err(e) = std::fs::create_dir_all(&cache) {
        tracing::warn!("Failed to create cache directory {:?}: {}", cache, e);
        return;
    }

    // 1. Migrate icons: <data>/icons -> <cache>/icons
    let legacy_icons = data.join("icons");
    let target_icons = icons_cache_dir();
    migrate_dir(&legacy_icons, &target_icons);

    // 2. Migrate meta: <data>/meta -> <cache>/meta
    let legacy_meta = data.join("meta");
    let target_meta = meta_dir();
    migrate_dir(&legacy_meta, &target_meta);

    // 3. Migrate versions: <data>/versions -> <cache>/versions
    let legacy_versions = data.join("versions");
    let target_versions = versions_cache_dir();
    migrate_dir(&legacy_versions, &target_versions);

    // 4. Migrate loader-scratch: <data>/loader-scratch -> <cache>/scratch
    let legacy_scratch = data.join("loader-scratch");
    let target_scratch = scratch_dir();
    migrate_dir(&legacy_scratch, &target_scratch);

    // 5. Migrate companion jars & manifest: <data>/companion/jars -> <cache>/companion/jars
    let legacy_companion_jars = data.join("companion").join("jars");
    let target_companion_jars = cache.join("companion").join("jars");
    if legacy_companion_jars.exists() {
        if let Some(parent) = target_companion_jars.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        migrate_dir(&legacy_companion_jars, &target_companion_jars);
    }
    let legacy_companion_manifest = data.join("companion").join("manifest.json");
    let target_companion_manifest = cache.join("companion").join("manifest.json");
    if legacy_companion_manifest.exists() && !target_companion_manifest.exists() {
        if let Some(parent) = target_companion_manifest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&legacy_companion_manifest, &target_companion_manifest);
    }
}

/// Helper to move `from` directory to `to`. If `to` already exists, merges contents
/// then removes `from`.
fn migrate_dir(from: &std::path::Path, to: &std::path::Path) {
    if !from.exists() {
        return;
    }
    if !to.exists() {
        if let Err(e) = std::fs::rename(from, to) {
            tracing::debug!("Could not rename {:?} to {:?}: {}", from, to, e);
        } else {
            tracing::info!("Migrated cache {:?} -> {:?}", from, to);
            return;
        }
    }
    // Target already exists — move individual children
    if let Ok(entries) = std::fs::read_dir(from) {
        let _ = std::fs::create_dir_all(to);
        for entry in entries.flatten() {
            let dest = to.join(entry.file_name());
            if !dest.exists() {
                let _ = std::fs::rename(entry.path(), dest);
            }
        }
        let _ = std::fs::remove_dir_all(from);
    }
}

/// Atomically write `contents` to `path`.
///
/// Writes to a sibling `<path>.tmp` first, then renames into place. On POSIX
/// and modern Windows, `rename` is atomic — readers either see the old file
/// or the new one, never a half-written state.
///
/// This matters for files that are written from multiple async paths (e.g.
/// `instance.json` updated by the UI on every slider drag). `std::fs::write`
/// truncates first then writes, so a concurrent reader can hit the empty
/// window and fail with `EOF while parsing`.
pub fn atomic_write<P: AsRef<std::path::Path>>(path: P, contents: &[u8]) -> std::io::Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "atomic_write: path has no parent directory",
    ))?;
    std::fs::create_dir_all(parent)?;

    // Use a unique temp name to avoid collisions when multiple writes race.
    // The OS's rename is atomic, but we still don't want two writers fighting
    // over the same `.tmp` file mid-flight.
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp.{}.{}", pid, nanos));

    std::fs::write(&tmp, contents)?;

    // On Windows, `rename` fails if the target exists. Use a remove-then-rename
    // dance — there's a brief window where the file is missing, but readers
    // that fail can retry, which is far better than getting a truncated file.
    #[cfg(windows)]
    {
        if path.exists() {
            // Best-effort: if remove fails (e.g. another writer already replaced
            // it), the rename below will fail and we'll surface that error.
            let _ = std::fs::remove_file(path);
        }
    }

    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Recursively calculates the total size in bytes of all files within a directory.
/// Uses `DirEntry::metadata()` directly so Windows reads cached `WIN32_FIND_DATAW`
/// attributes/sizes with zero extra stat syscalls or `PathBuf` allocations for leaf files.
pub fn dir_size(path: &std::path::Path) -> u64 {
    let mut size: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    size += dir_size(&entry.path());
                } else {
                    size += meta.len();
                }
            }
        }
    }
    size
}

/// Recursively copy a directory tree.
pub fn copy_dir_all(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_hierarchy_structure() {
        let cache = cache_dir();
        assert_eq!(meta_dir(), cache.join("meta"));
        assert_eq!(versions_cache_dir(), cache.join("versions"));
        assert_eq!(installers_cache_dir(), cache.join("installers"));
        assert_eq!(scratch_dir(), cache.join("scratch"));
        assert_eq!(icons_cache_dir(), cache.join("icons"));
    }

    #[test]
    fn test_migrate_dir_rename_and_merge() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_migrate_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let from = temp.join("from");
        let to = temp.join("to");

        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.txt"), "hello").unwrap();

        // 1. Initial migration (rename)
        migrate_dir(&from, &to);
        assert!(!from.exists());
        assert!(to.join("a.txt").exists());

        // 2. Secondary migration (merge when target exists)
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("b.txt"), "world").unwrap();
        migrate_dir(&from, &to);
        assert!(!from.exists());
        assert!(to.join("a.txt").exists());
        assert!(to.join("b.txt").exists());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_dir_size() {
        let temp = std::env::temp_dir().join(format!("vermeil_test_dir_size_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("nested")).unwrap();
        std::fs::write(temp.join("a.txt"), b"12345").unwrap(); // 5 bytes
        std::fs::write(temp.join("nested").join("b.txt"), b"1234567").unwrap(); // 7 bytes
        assert_eq!(dir_size(&temp), 12);
        let _ = std::fs::remove_dir_all(&temp);
    }
}
