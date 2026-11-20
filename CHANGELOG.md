## 0.1.0 (Alpha Build 15)

### Added

- Added "Updates (N)" category navigation pill in installed content view to instantly isolate out-of-date mods
- Added "Update All" action button in installed toolbar to sequentially enqueue all pending mod updates

### Changed

- Automatically prioritized mods with pending updates to the top of the installed list (Page 1)
- Reset installed pagination to Page 1 when checking updates so available updates are immediately visible

### Fixed

- Handled in-flight background token refresh on launcher startup to prevent false "Account Not Signed In" prompt
- Pre-warmed Mojang texture cache and mirrored skin assets on launch to prevent Quick Play singleplayer fallback to default Steve/Alex
- Added live "Connecting..." indicator to Home header and titlebar while account authentication warms up
