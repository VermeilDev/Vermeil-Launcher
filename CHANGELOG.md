## 0.1.0 (Alpha Build 1)

### Added

- Aggregated cross-instance in-game screenshot filmstrip in Library with isolated horizontal scroll, full-height widescreen thumbnails, single-slot [F2] ghost slot, and built-in lightbox viewer
- Active instance storage footprint calculation, total installed content tracking, and auto-managed companion mod status telemetry
- Redesigned Account view into tactile bento panels with bifurcated Google Cloud Settings Sync token lifecycle and one-click cloud backup/restore
- Multi-vendor Java runtime auto-provisioning for Adoptium, Corretto, Microsoft OpenJDK, and Zulu with live streaming download progress, cancellation, and download queue integration
- Emerald theme palette with automated Win32 COM shell shortcut and taskbar icon synchronization
- Home screen dual-deck 2-box hero grid in Worlds and Servers tabs with live server status pinging, MOTD sanitization, and online player readouts
- Redesigned Create Custom Instance and Import Instance screen layouts with tactile bento cards and recessed input wells

### Changed

- Symmetrical 56px sub-tile and 76px hero deck height with top badge integration and isolated action triggers
- Floating pagination dock with subtle page indicator and idle state styling
- Streamlined header meta pills with unified borders and tactile hover transitions

### Fixed

- Deduplicated download speed limiter updates with atomic limit tracking, eliminating redundant mutex resets and log spam
- Hardened authentication session persistence and centralized token expiry synchronization in load_accounts with 4s pre-flight probe bounds and encrypted vault fallback
- Elevated modal overlay z-indices to prevent stacking collision and boundary-aware tooltip alignment
- Resolved automated Java detection scanning across nested vendor directories

### Documentation

- [Tactile Design & UI Architecture](docs/UI.md): Design system, modal restraint, layout invariants, and styling architecture
