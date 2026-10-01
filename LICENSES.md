# Licenses

This project separates source code licensing from proprietary visual identity and branding assets, pursuant to **Section 7** of the GNU General Public License v3.0.

## Source Code — GNU General Public License v3.0 (or later)

All source code in this repository (Rust backend, SolidJS frontend, companion mod, CSS, HTML, scripts, configuration files, and documentation) is released under the **GNU General Public License v3.0 or later** ([GPL-3.0-or-later](LICENSE)).

```
Vermeil — A tactile, privacy-focused Minecraft: Java Edition launcher
Copyright (C) 2026 VermeilDev

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
```

Under GPLv3, anyone who distributes modified copies or derivative builds of Vermeil is legally obligated to provide the complete corresponding source code under the same GPLv3 license.

## Brand Identity, 3D Theme Emblems, & App Icons — All Rights Reserved

Pursuant to **Section 7(e)** of the GNU General Public License v3.0 (*declining to grant rights under trademark law for use of some trade names, trademarks, or service marks*), the name **Vermeil**, the official logo, application icons, high-resolution 3D theme emblems, and distinctive visual identity assets are the exclusive intellectual property of the project author and are **NOT** covered by the GPLv3 grant:

```
launcher/public/logo.png
launcher/src/assets/logo.svg
launcher/src-tauri/icons/*        (all sizes, formats, and theme variants)
launcher/public/themes/*          (all high-res 3D theme emblems and artwork)
docs/images/                      (promotional artwork and branding screenshots)
```

These assets are **All Rights Reserved**. They may **not** be:
- Used in downstream forks, independent distributions, or commercial products
- Modified, adapted, or redistributed separately from this official repository
- Used to imply endorsement, sponsorship, or official affiliation

### Mandatory Forking and Rebranding Policy

If you fork this repository or distribute a modified build:
1. **Mandatory Asset Removal**: You **must remove and replace** all proprietary branding assets (the logos, icons, and 3D theme emblems listed above) with your own original graphics before distributing binaries or packages.
2. **Mandatory Name Change**: You **must not use** the name "Vermeil" or any confusingly similar branding for your fork, release, or distribution.
3. **Copyleft Obligation**: All modifications and derivative source code must remain licensed under **GPL-3.0-or-later** with source code made available to your recipients.

## Third-Party Permissive Assets & Libraries

Third-party dependencies and assets included or linked in this repository are distributed under their respective permissive licenses, which are officially recognized as compatible with GNU GPLv3:

- **Feather Icons** (MIT License) — Generic UI system icons in `launcher/src/components/Icons.tsx` are sourced from [Feather Icons](https://github.com/feathericons/feather).
- **skinview3d** (MIT License) — 3D player skin rendering canvas in the Character Studio.
- **gifuct-js** (MIT License) — Animated GIF parsing library for custom animated cape frames.
- **Ponytail** (MIT License) — Developer restraint principles and AI decision ladder adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert.
- **Rust Crates & NPM Packages** — Individual third-party libraries (Tauri, Tokio, Reqwest, SolidJS, Serde) remain licensed under their respective MIT / Apache-2.0 / BSD licenses.

## Summary

| Category | License | Permitted Use / Forking |
|---|---|---|
| **Source Code** (Rust, TypeScript, CSS) | **GPL-3.0-or-later** | Free to use, modify, and redistribute; modifications must remain open source under GPLv3 |
| **Logo, App Icons & 3D Theme Emblems** | **All Rights Reserved** | **Proprietary.** Forks and redistributions **must rebrand** and replace all visual assets |
| **Feather Icons** (UI utility glyphs) | **MIT License** | Free (permissive) |
| **skinview3d** (3D Skin Canvas) | **MIT License** | Free (permissive) |
| **Ponytail** (Efficiency ruleset) | **MIT License** | Free (permissive) |
