## 0.1.0 (Alpha Build 2)

### Added

- Official Neon Aurora application icon across desktop (ICO, ICNS, PNG 16-512px), web (SVG, WebP), iOS, Android, and Win32 COM theme embeds
- Secret, credential, and private token leak scanner guarding against unintended credential exposure

### Changed

- Tactile Bento design system token alignment across interactive buttons and setting plates (`--btn-depth`)
- Decoupled updater manifest generation from release asset bundles to preserve genuine download metrics

### Fixed

- Fixed Google Cloud Settings Sync OAuth token exchange with updated desktop client credentials
- Render empty slot placeholders in dual-deck servers column when fewer than two servers are configured
- Removed redundant sign-in action button from active identity hero card in Account view
