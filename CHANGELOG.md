## 0.1.0 (Alpha Build 6)

### Added

- Compatibility warning confirmation step in the Change Mod Loader flow to inform users of loader API breaking changes and crash risks
- Automatic mod conversion pipeline when switching mod loaders, querying compatible builds across Modrinth and CurseForge

### Changed

- Redesigned Change Mod Loader modal with balanced Bento grid layout, searchable runtime versions, and height stability
- Unified 3D tactile toggle switches across all screens and modal dialogs
- Streamlined loader conversion pipeline and consolidated companion mod loader parity
- Enhanced launcher self-updater with cache-busting, in-flight release detection, and background channel synchronization
- Replaced wand icon with authentic anvil iconography for Forge and shuffle symbol for loader switching

### Fixed

- Prevented enabling incompatible mods and restored authentic loader type badges in instance content views
- Fixed dual Quilt-Fabric API queries and automatic conversion for incompatible mods
- Resolved loader parity and Quilt fallback behavior during CurseForge downloads and imports
- Prevented file rename collisions when enabling compatible mods during loader conversion
