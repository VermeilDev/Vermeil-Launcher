## 0.1.0 (Alpha Build 16)

### Changed

- Debounced settings slider disk saves while retaining immediate 60 FPS visual responsiveness during drag
- Isolated logs popout bundle to reduce separate window launch overhead

### Fixed

- Enforced strict path sanitization across modpack file downloads and archive override extractions to prevent directory traversal
- Enforced strict SHA-1 hash verification for mod and archive downloads
- Hardened IPC handlers to restrict file opening to images within the launcher directory and prevent directory traversal on instance deletion
- Restricted article metadata fetching strictly to official Mojang launchercontent endpoints
- Sanitized HTML error responses on local OAuth loopback server
- Capped network ping packets and mod jar zip entry reads to prevent memory exhaustion
- Restricted webview asset protocol scope to application data directories and removed unsafe-eval from content security policy
