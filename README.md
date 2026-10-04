<p align="center">
  <img src="launcher/src-tauri/icons/128x128.png" alt="Vermeil" width="80" />
</p>

<h1 align="center">Vermeil</h1>

<p align="center">
  <strong>A tactile, privacy-focused Minecraft: Java Edition launcher for Windows and Linux.</strong><br/>
  Microsoft authentication, major mod loaders, content browsing, 3D Character Studio, and zero telemetry.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0--alpha.1-8b5cf6?style=flat-square&labelColor=181622" alt="Version" />
  <img src="https://img.shields.io/badge/Windows-0078d4?style=flat-square&logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/Linux-fcc624?style=flat-square&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/stack-Tauri%20%7C%20SolidJS-24c8db?style=flat-square&logo=tauri&logoColor=white&labelColor=181622" alt="Stack" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-10b981?style=flat-square&logo=gnu&logoColor=white&labelColor=181622" alt="License" />
  <img src="https://img.shields.io/badge/lines%20of%20code-~70k-f59e0b?style=flat-square&labelColor=181622" alt="Lines of Code" />
</p>

<p align="center">
  <a href="https://vermeillauncher.app/">Website</a> · <a href="https://github.com/VermeilDev/Vermeil-Launcher/releases">Download</a> · <a href="PRIVACY.md">Privacy</a> · <a href="TERMS.md">Terms</a> · <a href="https://github.com/VermeilDev/Vermeil-Launcher/issues">Issues</a>
</p>

---

> **Vermeil 0.1.0-alpha.1 (Alpha Baseline).** Initial public alpha release of Vermeil Launcher. The codebase and versioning were rebooted from earlier prototypes into a streamlined, production-grade foundation. Curious about the launcher's evolution? Check out the [Visual Evolution & UI History](https://github.com/VermeilDev/VermeilDev/blob/main/HISTORY.md) across all seven developmental eras.
>
> **Developed with Google Antigravity 2.0.** Built with AI pair-programming assistance using integrated Gemini models. See [DISCLAIMER.md](DISCLAIMER.md).
## Highlights

- **All Major Mod Loaders**: Full support for Fabric, Quilt, NeoForge, and Forge with automatic version detection, Adoptium Java auto-provisioning (Java 8–25), and offline manifest caching.
- **Unified Content Browser**: Search, filter, and batch-install mods, resource packs, shaders, and complete modpacks directly from Modrinth and CurseForge.
- **3D Character Studio & Custom Capes**: Interactive WebGL skin stage, dummy mannequins, historical skin sync via Crafty.gg, and in-game animated capes via the Vermeil Companion mod.
- **Tactile Bento UI & 6 Themes**: Mechanical tactile interface featuring chunky 3D buttons, modular Bento panels, smooth navigation dock, and 6 visual colorways (Neon Aurora, Emerald, Inferno, Stealth, Deep Ocean, Void) with live Windows taskbar icon synchronization.
- **Zero Telemetry & Private Cloud Sync**: No tracking, no launcher accounts, and no data harvesting. Optional preferences sync connects directly to your private Google Drive app sandbox without intermediate servers.

## Installation

### Windows

Download the latest `.exe` installer from [Releases](https://github.com/VermeilDev/Vermeil-Launcher/releases). Per-user install with no administrator privileges required.

### Linux

Install via the one-line setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/VermeilDev/Vermeil-Launcher/main/install.sh | bash
```

Installs the AppImage to `~/.local/bin` and creates a desktop menu entry. Uninstall anytime with `vermeil-uninstall`.

## Development

Built with [Tauri 2](https://tauri.app/) (Rust) and [SolidJS](https://www.solidjs.com/) (TypeScript).

### AI Toolchain Audit (Quickstart)
If developing with an AI assistant (**Google Antigravity**, **Cursor**, **Claude Code**), copy the [AI Environment Setup Prompt](docs/DEVELOPMENT.md#step-1-environment-audit-and-provisioning-prompt) to automatically inspect your toolchains, install prerequisites, and launch your local build.

### Manual Setup
```bash
# Clone and setup
git clone https://github.com/VermeilDev/Vermeil-Launcher.git
cd Vermeil-Launcher/launcher

# Install dependencies and start development server
pnpm install
pnpm tauri dev
```

For complete build instructions, toolchain prerequisites, and mod development guides, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Privacy & Terms

- **Privacy Policy**: 100% local-first. We do not operate tracking servers or analytics endpoints. See [PRIVACY.md](PRIVACY.md).
- **Terms of Service**: Open-source usage terms and third-party API integration policies. See [TERMS.md](TERMS.md).
- **Security Policy**: Vulnerability disclosure policy and reporting guidelines. See [SECURITY.md](SECURITY.md).

## AI Disclosure

This project was built with AI pair-programming assistance under the direction of its creator and project lead across two development phases:

- **Prototype Phase (Pre-Alpha builds through v0.8.5)**: Explored in **Kiro IDE** using Claude (Opus & Sonnet) and GPT models.
- **Alpha Baseline (0.1.0-alpha.1 & Ongoing)**: Engineered in **Google Antigravity 2.0** using integrated **Gemini** models for core architecture, performance calibration, and active maintenance.

See [DISCLAIMER.md](DISCLAIMER.md) for full project disclaimers and [docs/DEVELOPMENT.md#1-ai-first-setup-and-developer-journey-recommended](docs/DEVELOPMENT.md#1-ai-first-setup-and-developer-journey-recommended) for ready-made prompts and AI development workflows.

## Acknowledgements

- **[Ponytail](https://github.com/DietrichGebert/ponytail)** by **Dietrich Gebert** — The "Lazy Senior Dev" efficiency philosophy and restraint decision ladder guiding our architecture and engineering workflows.
- **[Feather Icons](https://github.com/feathericons/feather)** by **Cole Bemis** — System iconography and UI glyphs.
- **[skinview3d](https://github.com/bs-community/skinview3d)** — 3D Minecraft character and cape rendering canvas.

## Author & Maintainer

Created and maintained by **VermeilDev** ([@Davekb1976](https://github.com/Davekb1976)).

## License

Vermeil is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

> **Note on Brand Assets:** Pursuant to Section 7 of the GPLv3, the name **Vermeil**, the official logo, application icons, and custom 3D theme emblems are **All Rights Reserved**. Downstream forks and redistributions must rebrand and replace all official visual assets. See [LICENSES.md](LICENSES.md) for complete details.

