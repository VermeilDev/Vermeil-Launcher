## 0.1.0 (Alpha Build 14)

### Added

- Added unified Favorites system for bookmarking mods, modpacks, resource packs, shaders, and datapacks across Modrinth and CurseForge
- Added offline icon caching and automatic Google Cloud synchronization for saved favorites

### Changed

- Reordered content and modpack mode tabs to position Favorites first for immediate access
- Positioned content category navigation directly beneath the search and filter toolbar for improved ergonomics
- Equalized button heights across standard (26px) and compact (24px) card views with 3-stage mechanical press physics

### Fixed

- Fixed CurseForge platform detection on installed mod cards when favoriting
- Prevented category filter leakage when installing favorited mods from different content types
- Hardened favorites data persistence with atomic writes, background cloud sync triggers, and self-healing backup mirror
