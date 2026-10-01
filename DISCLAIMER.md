# Disclaimer

This software is provided **as-is**, without warranty of any kind.

## Active Development & Version Baseline

Vermeil is under **active development**. Starting with `0.1.0-alpha.1`, the project underwent an architectural reboot from earlier prototypes to establish a clean, production-grade foundation with automated testing, privacy guarantees, and core launcher capabilities. Ongoing improvements and enhancements continue to be introduced. Treat your data with care and backup important worlds as with any custom software.

## AI-Generated Codebase

The entire Vermeil codebase was generated with the assistance of AI tools under the direction of its creator and project lead across two development phases:

- **Prototype Phase (Pre-Alpha builds through v0.8.5)**: Explored in **Kiro IDE** using Claude (Opus & Sonnet) and GPT models.
- **Alpha Baseline (0.1.0-alpha.1 & Ongoing)**: Engineered in **Google Antigravity 2.0** using integrated **Gemini** models for core architecture, performance calibration, and active maintenance.

This means:

- Code may contain bugs, logic errors, or incomplete implementations
- Features may behave unexpectedly or break without warning
- Security-sensitive code (authentication, credential storage) has not been independently audited
- Edge cases may not be handled correctly
- Performance characteristics are not guaranteed

The creator and project lead directed all architectural decisions and reviewed the output, but AI-generated code carries inherent risks that differ from traditionally hand-written software.

## No Guarantees

- Builds may fail on your system due to environment differences
- The auto-updater modifies files on your machine — use at your own risk
- Microsoft account tokens are stored locally; while encrypted on Windows (DPAPI), the implementation has not been formally security-audited
- Mod installation modifies your Minecraft game directories
- This software is not affiliated with or endorsed by Mojang, Microsoft, Modrinth, or CurseForge

## Third-Party Content & Community Share Codes

- **Community Mod Lists**: Share codes (`VML-...`) allow players to share mod and modpack combinations. While Vermeil enforces strict security checks (URL host allowlists, zip slip prevention, and path sanitization), the individual mods, shaders, and resource packs fetched from Modrinth or CurseForge are authored by third-party creators. Vermeil does not audit or guarantee the security, stability, or compatibility of community-shared mod selections.
- **Ephemeral Edge Relay**: 3-minute ephemeral cloud share codes (`VML-XXXX-XXXX`) are hosted on best-effort serverless edge infrastructure. There is no Service Level Agreement (SLA), guarantee of availability, or permanent storage for shared codes.

## Use at Your Own Risk

By using Vermeil, you accept that:

1. The software may not work as described
2. Data loss is possible (game saves, mod configurations, account tokens)
3. The creator and project lead is not liable for any damage resulting from use of this software
4. There is no guarantee of continued development, support, or updates

This project is released under the [GNU General Public License v3.0 or later](LICENSE), which includes a complete liability and warranty disclaimer.
