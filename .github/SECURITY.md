# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vermeil, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Use GitHub's [private vulnerability reporting](https://github.com/VermeilDev/Vermeil-Launcher/security/advisories/new) on the repo.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

## Scope

Security issues we care about:
- Token / credential exposure or leakage
- Arbitrary code execution via crafted modpacks or mods
- Path traversal in archive extraction
- Authentication bypass
- Tampering with the auto-update payload or update manifest
- XSS in webview-rendered content (mod descriptions, news articles)

## Response

Acknowledgement within 48 hours, fix within 7 days for critical issues. This is a solo project so timing is best-effort.

## Auto-Update Trust Model

Vermeil ships with an auto-updater that downloads signed installers from GitHub Releases and applies them on next exit.

| Layer | Mechanism |
|-------|-----------|
| Transport | HTTPS to GitHub (`updates/latest.json` branch) |
| Manifest | Plain JSON pointing to the installer + its signature |
| Payload integrity | Minisign Ed25519 signature verified against an embedded pubkey before install runs |
| Privilege scope | NSIS installer in `installMode: currentUser` writes only to `%LOCALAPPDATA%\Programs\Vermeil` |
| Downgrade protection | Tauri's updater only flags `new_version > current_version` per semver |
| File-replace race | Install runs at `RunEvent::Exit` so the running binary's file lock is released first |

A man-in-the-middle attacker cannot serve a malicious update because the embedded pubkey is compiled into every binary and the signature check is enforced before the installer is invoked.

## Operating the Signing Key

The minisign keypair signs every release; the public key is baked into `tauri.conf.json` and verifies update payloads on user machines.

**Do not rotate the public key casually.** When the public key changes, every existing install of Vermeil loses the ability to auto-update — those users must manually download the new installer from the GitHub Release page. Rotation should only happen if the private key is exposed.

The private key lives only as a GitHub Actions encrypted secret (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). It is never committed, never in CI logs, never copied to other machines.

If the private key leaks:

1. **Rotate immediately** — generate a new keypair (`pnpm tauri signer generate`), update the GitHub secret, replace the public key in `tauri.conf.json`.
2. **Ship a new release** with the new public key.
3. **Document in `CHANGELOG.md`** that auto-update from the previous version is broken and link the manual download.

There is no remote revocation — every Vermeil install verifies against whatever pubkey it was built with. A compromised key keeps signing valid updates until every user has migrated to a new public-keyed build.

## CI / Supply Chain

The release workflow runs on `windows-2022` and `ubuntu-24.04` GitHub-hosted runners and signs the build with the minisign secret. Third-party actions are referenced by major version tags (e.g., `@v5`, `@v6`). When updating action versions, review the changelog for the new version. For higher-security environments, consider pinning to specific commit SHAs instead of tags.

## Webview Content

Any HTML pulled from external sources (Modrinth descriptions, Mojang news articles, etc.) and rendered via `innerHTML` is sanitized server-side with `ammonia` before reaching the frontend. This prevents script injection from a compromised source CDN or a mistakenly-fetched URL. The CSP in `tauri.conf.json` is a second layer that blocks inline `<script>` execution even if sanitization is bypassed.
