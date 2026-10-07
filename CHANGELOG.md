## 0.1.0 (Alpha Build 8)

### Added

- Support for equipped custom and official Mojang capes on the Home screen 3D player model, including full multi-frame animation playback for animated custom capes
- Expanded Quick Play server deck capacity to 6 server entries with bidirectional synchronization to instance `servers.dat`
- Smart badge overflow pill with popover inspector and version tooltips on download history cards

### Changed

- Streamlined download history cards by omitting redundant loader tags on loader-agnostic content (resource packs, data packs, shaders, and Java runtimes)
- Preserved custom mod tags losslessly when writing server entries to instance `servers.dat`

### Fixed

- Sanitized server icon base64 payloads in `servers.dat` to prevent Netty decoding crashes on legacy Minecraft 1.8.9
- Prevented download history badge rows from overflowing or clipping relative timestamps on narrow views
- Removed redundant cancel launch tooltip from the instance header play button
