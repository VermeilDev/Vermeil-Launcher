# Development

> **Warning:** This codebase is AI-generated. Builds may be unstable, features may be incomplete, and runtime behavior may differ from what documentation describes. If a build fails or the app misbehaves, it may be a code issue rather than an environment issue.

## 1. AI-First Setup and Developer Workflows (Recommended)

Vermeil is engineered with AI pair-programming assistance under human architectural direction (developed with **Google Antigravity 2.0** using integrated **Gemini** models).

Choose the workflow that matches your goal:

| Workflow | Goal | What to Follow |
| :--- | :--- | :--- |
| **Track A: Feature Development & Architecture** | Setting up a local build, generating persistent AI skills, creating features, setting up release pipelines, or forking the launcher. | Steps 1 through 5 below |
| **Track B: Bug Hunting & Suggestions** | Diagnosing a bug, analyzing root causes, or drafting a well-structured feature suggestion or architectural proposal for maintainers. | [Track B Prompts](#track-b-bug-hunting-suggestions--issue-reporting) |

---

### Track A: Feature Development & Architecture

Use this track if you want to build features, inspect the full stack, or maintain a fork. Follow these sequential steps:

#### Step 1: Environment Audit and Provisioning Prompt
When you first clone the repository, copy and paste this prompt directly into your assistant. The AI will audit your toolchains, detect missing prerequisites, provide exact official download links and terminal commands, and verify your local build automatically:

```text
Audit my development environment for building Vermeil Launcher on this machine.
Follow this step-by-step checklist:

1. System & Toolchain Audit:
   - Check Node.js (`node -v`). Must be Node 24 LTS.
   - Check pnpm (`pnpm -v`). Must be pnpm 11.
   - Check Rust toolchain (`rustc --version`, `cargo --version`). Must be stable channel.
   - Operating System specific toolchains:
     - Windows: Check for Visual Studio C++ Build Tools (MSVC compiler / WebView2).
     - Linux: Check for `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`, and `patchelf`.
   - Optional (Vermeil Companion mod): Check Java JDK 25 (`java -version`).

2. Report Results:
   - Output a clean Markdown table summarizing:
     | Toolchain | Status (Installed / Missing) | Detected Version | Required Version |

3. Handle Missing Tools (User Choice: Automated vs. Manual):
   - If any tool is missing or outdated, display the summary table and ask me:
     "Would you like me to install the missing tools for you automatically (via winget, npm, rustup, or system package manager), or would you prefer manual download links and instructions?"
   - If I choose Automated (or if your environment can run commands):
     - Run the appropriate install commands sequentially:
       - pnpm: `npm install -g pnpm`
       - Rust: `winget install Rustlang.Rustup` (Windows) or `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (Linux)
       - Node.js 24: `winget install OpenJS.NodeJS.LTS` (Windows) or fnm/nvm (Linux)
       - Linux packages: Run the exact apt/pacman command from docs/DEVELOPMENT.md
     - Note any heavy workloads that require a GUI installer or system restart (e.g. Visual Studio C++ Build Tools).
   - If I choose Manual:
     - Provide official download links and copy-paste commands for each missing prerequisite:
       - Node.js 24 LTS: https://nodejs.org/
       - pnpm 11: https://pnpm.io/ (`npm install -g pnpm`)
       - Rust: https://rustup.rs/
       - Visual Studio C++ Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
       - Linux packages: Provide the distro-specific install command

4. Verify Build:
   - Once all required tools are installed, run `cd launcher && pnpm install && pnpm tauri dev` (or `cargo check`) to confirm the local build passes cleanly.
```

#### Step 2: AI Platform Integration
Use this prompt to have your AI **read the codebase docs and generate persistent configuration files** for your platform — rules and skills that load automatically on every session:

```text
Read the following documentation files in this repository to understand the
architecture, coding standards, and design system:

1. docs/DEVELOPMENT.md — Project architecture, build system, verification gates
2. docs/UI.md — Tactile Bento design system, CSS tokens, theme engine

Then generate AI configuration files for this platform so these standards are
enforced automatically on every session. Adapt file formats and locations to
match this platform's conventions:

- Antigravity / Gemini: AGENTS.md at root + .agents/skills/<name>/SKILL.md
- Cursor: .cursor/rules/*.mdc
- Claude Code: CLAUDE.md at root
- Windsurf: .windsurfrules at root
- Other: The equivalent rules file at the standard location

Generate a root rules file covering:

1. Efficiency Philosophy ("Ponytail" Lazy Senior Dev Mode) — Lazy means efficient.
   Decision ladder (stop at the first rung that holds): Does this need to be built?
   Does it already exist? Does the stdlib cover it? Does a platform feature cover it?
   Does an installed dependency solve it? Can it be one line? Only then: write minimum code.
   No unrequested abstractions. Deletion over addition. Shortest working diff.

2. Architecture — Tauri 2 (Rust) + SolidJS (TypeScript). Zero telemetry.
   Rust: commands/ (thin) → services/ (heavy logic) → models/ → util/.
   Frontend: ipc/commands.ts (ALL invoke wrappers), screens/, modals/, components/Icons.tsx.
   All invoke() calls routed through src/ipc/commands.ts. Never invoke() directly.

3. Coding Standards — Rust: tracing macros (never println!), crate::util::paths (never hardcode),
   shared reqwest::Client, strip \\?\ before IPC, zero warnings, no unwrap().
   TypeScript: SolidJS signals, Icons.tsx SVGs (never emoji), openUrl() (never window.open),
   data-tip tooltips (never title=""), kebab-case events with onCleanup unlisten.
   CSS: Tactile Bento. 3D buttons for actions only, flat badges. Radio cards for 1-of-N.

4. Cross-Platform Parity — Windows (WebView2) ↔ Linux (WebKitGTK).
   Enforce constraints in app code. Account for WebKitGTK rendering differences.

5. Parallel Implementation Rule — Update all parallel surfaces: Modrinth ↔ CurseForge,
   Fabric ↔ Quilt ↔ NeoForge, Rust commands ↔ commands.ts, emit() ↔ listen(),
   #[cfg(windows)] ↔ #[cfg(unix)].

6. Verification — node scripts/check-privacy.mjs (0 violations), cargo check + cargo test
   (0 warnings), pnpm exec tsc --noEmit + pnpm run build (0 errors).

7. Multi-Repository Ecosystem & Sibling Workspace Navigation — Strict separation between
   desktop launcher (`Vermeil-Launcher`) and client companion mod (`Vermeil-Companion`).
   Sibling directory topology (`../Vermeil-Launcher` ↔ `../Vermeil-Companion`). Launcher is
   strictly Rust/Tauri 2 + SolidJS; mod is strictly Java / Stonecraft / Forge 1.8.9. Never copy
   mod files into launcher or vice versa. Both repositories share the Ponytail philosophy,
   zero telemetry, closed contribution policy, and Conventional Commits stealth git workflow.
   When instructed to work on the companion mod, switch to `Vermeil-Companion` workspace and
   use its dedicated skills (`stonecraft`, `minecraft-mod`).

And generate separate skill files for these development workflows:
- "Adding a Tauri IPC Command" — service → command → lib.rs → commands.ts → UI
- "Adding a Screen" — screens/<Name>.tsx → Screen union → Show → screenTitles → dock
- "Content Source Parity" — Modrinth ↔ CurseForge ↔ local archives
- "Dependency Management" — check existing deps first, run verification after changes
```

#### Step 3: Cloud Services & Infrastructure Setup
After your AI platform is configured, use this prompt to configure external cloud services, security scanning, updater signing, and secrets:

```text
Generate additional skill files for the infrastructure and security workflows
of this project. Use the same platform conventions as the previous step.

1. "Security & Privacy Audit":
   - node scripts/check-privacy.mjs (0 violations) — detects leaked keys (PEM, OpenSSH),
     tokens (ghp_, GOCSPX-, AIza, Discord, AWS), absolute user paths.
   - Dependency auditing: pnpm audit + cargo audit. Dependabot alert-only mode.
   - Token hygiene: encrypted on disk (DPAPI / POSIX 0600). Never log credentials.

2. "Google Cloud Settings Sync Setup":
   a. GCP Console: Create project → enable Google Drive API.
   b. OAuth consent screen: External → scope drive.appdata → add test users.
   c. Credentials: OAuth client ID → Desktop app (auto-permits loopback URIs).
   d. Build env vars: VERMEIL_GOOGLE_CLIENT_ID and VERMEIL_GOOGLE_CLIENT_SECRET
      (injected at compile time via option_env!).
   e. Architecture: RFC 8252 PKCE loopback flow, tokens encrypted at
      %LOCALAPPDATA%\Vermeil\google_cloud.enc, Drive appDataFolder sandbox.

3. "Companion Mod Lifecycle":
   a. Update REPO constant in services/companion_mod.rs to your org/repo.
   b. Jar naming: vermeil-<loader>-<modVersion>+<mcVersion>.jar.
   c. Tag GitHub releases v* or mod-v*. Attach companion-manifest.json asset:
      { "entries": [{ "minecraftVersions", "loaders", "file", "url", "sha1", "size" }] }
   d. Lifecycle: active jar = no-op, .disabled = rename, missing = fetch + SHA-1 verify.

4. "Auto-Updater & Minisign Signing":
   a. Generate Minisign keypair: pnpm tauri signer generate -w ~/.tauri/vermeil.key
   b. Set pubkey in tauri.conf.json → plugins.updater.pubkey.
   c. Set endpoint: plugins.updater.endpoints → raw.githubusercontent.com/<org>/<repo>/updates/latest.json
   d. CI secrets: TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
   e. release.yml auto-signs via tauri-action, publishes latest.json to orphan updates branch.
   f. Pre-release tags → experimental-latest.json; stable tags → latest.json.

5. "Cloudflare Worker & KV Setup (Instance Share Codes)":
   a. Architecture: Instance sharing uses a Cloudflare Worker backed by a Cloudflare KV
      namespace. Short codes (`VML-XXXX-XXXX`) expire in 3 minutes (180s TTL) for zero
      data retention. Fallback: If unreachable, launcher generates offline Base62 codes (`VML...`).
   b. Cloudflare Dashboard setup:
      - Workers & Pages → KV: Create namespace `VML_CODES`.
      - Create Worker: Bind KV namespace as `VML_CODES`.
      - Set environment variable / secret `CLIENT_KEY` to authenticate incoming requests.
   c. Worker endpoints:
      - `POST /v1/share`: Checks `X-Vermeil-Client` header, generates 13-char `VML-XXXX-XXXX`,
        stores JSON payload in KV with `expirationTtl: 180`, returns `{ "code": "VML-XXXX-XXXX" }`.
      - `GET /v1/share/:code`: Checks header, looks up code in KV, returns payload (or 404 if expired).
   d. Launcher config: Optionally set `VERMEIL_CLIENT_KEY` environment variable and
      update `CLOUDFLARE_SHARE_API` in `launcher/src-tauri/src/services/share_code.rs`
      to point to your worker endpoint.
   e. Optional (Website): Static landing page lives in `website/` and can be deployed to
      Cloudflare Pages via `wrangler.toml` (`directory = "."`).

6. "CI Secrets Reference":
   Release (release.yml): GITHUB_TOKEN (auto), TAURI_SIGNING_PRIVATE_KEY,
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD, VERMEIL_GOOGLE_CLIENT_ID, VERMEIL_GOOGLE_CLIENT_SECRET.
   CI (ci.yml): PRIVACY_DENYLIST (optional custom patterns).
   Configure at: GitHub → Settings → Secrets and variables → Actions.
```

#### Step 4: Forking and Rebranding (GPLv3 Compliance)
If you are creating an independent downstream launcher fork under the GNU General Public License v3.0, use this prompt to have your AI handle the mandatory rebranding requirements (per Section 7 and LICENSES.md) cleanly:

```text
You are an expert full-stack developer helping me create an independent fork of Vermeil Launcher under the GNU General Public License v3.0 (or later).

Pursuant to Section 7 of the GPLv3, LICENSES.md, and standard open-source fork maintenance, downstream forks must adhere to this checklist:

1. Replace All Proprietary Brand Assets:
   - launcher/public/logo.png and launcher/src/assets/logo.svg
   - launcher/src-tauri/icons/* (all app icon sizes)
   - launcher/public/themes/* (custom 3D emblems)

2. Rename Application Identifiers & Binary Names:
   - launcher/package.json ("name", "description")
   - launcher/src-tauri/Cargo.toml ("name", "description")
   - launcher/src-tauri/tauri.conf.json ("productName", "identifier")
   - launcher/src-tauri/src/util/http.rs (LAUNCHER_NAME)

3. Update In-App Hyperlinks, UI Buttons & External Endpoints:
   - Git & GitHub CLI: Point remote to your fork (`git remote set-url origin https://github.com/<org>/<repo>.git`) and set default repo (`gh repo set-default <org>/<repo>`).
   - Settings Screen (launcher/src/screens/Settings.tsx): Update GitHub repository URL, Privacy Policy URL, and License links in About section.
   - Update Banner (launcher/src/components/UpdateBanner.tsx): Update RELEASES_URL to your release tags URL.
   - Auto-Updater Manifest (launcher/src-tauri/tauri.conf.json): Update plugins.updater.endpoints to your orphan updates branch.
   - Companion Mod Discovery (launcher/src-tauri/src/services/companion_mod.rs): Update REPO constant to your companion repository.
   - Share Codes (launcher/src-tauri/src/services/share_code.rs): Update CLOUDFLARE_SHARE_API to your worker endpoint.
   - Website (website/): Update repository and canonical URLs in index.html, terms.html, and privacy.html.

4. Source Code Licensing & Headers:
   - Maintain copyleft: All modifications must remain licensed under GPL-3.0-or-later.
   - Place standard REUSE specification headers (`SPDX-FileCopyrightText` and `SPDX-License-Identifier: GPL-3.0-or-later`) at the top of each new or modified source file.

5. Preserve cross-platform compatibility and zero-telemetry foundations.
```

#### Step 5: Multi-Repository Ecosystem, Git Workflow & Release Protocol

> **When to use this step:**
> - Developing companion mod features alongside the launcher? Or managing commits, private-to-public promotion, version bumps, and tag-driven releases across the ecosystem? Run this prompt in your AI assistant to configure multi-repository navigation and generate the unified `git-workflow` skill across both projects.
>
> **What this prompt does:** Running this prompt instructs your AI assistant to read the platform rules generated in Step 2 (`AGENTS.md`, `.cursor/rules`, `CLAUDE.md`, or `.windsurfrules`) and augment them with cross-repository ecosystem rules, sibling workspace navigation (`Vermeil-Launcher` ↔ `Vermeil-Companion`), companion mod skills (`stonecraft`, `minecraft-mod`), and generate the **`git-workflow`** skill governing Conventional Commits, autonomous local checkpoints, dual-repo staging (`Vermeil-Private` ➔ `Vermeil-Launcher`), version synchronization, changelog generation, and tag-driven release publishing.

```text
You are an expert systems engineer and Minecraft client developer assisting me across the entire Vermeil Ecosystem.

Our ecosystem is structured across two dedicated sibling repositories:
1. `Vermeil-Launcher` (Desktop launcher built with Tauri 2 in Rust, and SolidJS in TypeScript).
2. `Vermeil-Companion` (In-game Minecraft client companion mod built in Java with Stonecraft/Stonecutter and ForgeGradle 2 in `../Vermeil-Companion`).

I am developing features that interface between the desktop launcher and the companion mod. Please update and configure our AI environment for this multi-repository ecosystem:

1. Update Platform Rules & Configuration:
   - Read the existing root rules file for this platform generated in Step 2 (e.g. `AGENTS.md`, `.cursor/rules/*.mdc`, `CLAUDE.md`, or `.windsurfrules`).
   - Augment it with the Multi-Repository Ecosystem & Sibling Workspace Navigation Invariant:
     - Sibling Topology: `../Vermeil-Launcher` and `../Vermeil-Companion` live side-by-side on disk. Reference sibling paths rather than copying files across repositories.
     - Strict Boundary Invariant:
       - All Rust backend logic, Tauri IPC commands, SolidJS UI screens, and Tactile Bento CSS live exclusively in `Vermeil-Launcher`.
       - All Java mod source code, Mixins, ASM transformers, and Gradle build scripts live exclusively in `Vermeil-Companion`.
       - NEVER duplicate or copy Java sources into the launcher repo. NEVER duplicate Rust or SolidJS code into the companion mod repo.
     - Context Switching: Stay in `Vermeil-Launcher` when working on launcher UI/IPC/services; navigate to sibling `../Vermeil-Companion` when working on in-game mod features.

2. Configure Companion Mod Skills & Invariants:
   - In the companion repository (`../Vermeil-Companion`), ensure AI configuration files and skills are active:
     - `stonecraft`: Working with the Stonecraft + Stonecutter multi-loader pipeline across Fabric and NeoForge.
     - `minecraft-mod`: Java, Fabric Loom, ForgeGradle 2, Mixins, ASM coremods, dynamic textures, and game hooks.
   - Enforce companion invariants: Stonecutter preprocessor comments (`//? if ...`) must NEVER be deleted as dead code; Forge 1.8.9 remains isolated in `forge/1.8.9/`; zero game-loop latency or tick overhead.

3. Context Switching & Verification Protocol:
   - If the task asks to edit, build, or debug the desktop launcher (UI screens, Tauri commands, settings, download queue, instance management, or launch pipeline):
     - Operate in the `Vermeil-Launcher` workspace.
     - Leverage launcher skills: `add-mod-loader`, `add-screen`, `add-tauri-command`, `content-source-parity`, `ui-restraint`, `dependencies`, `refactoring`.
     - Run launcher verification gates: `pnpm exec tsc --noEmit`, `pnpm run build`, `cargo check`, `cargo test`.
   - If the task asks to edit, build, or debug the in-game companion mod (Mixins, capes, dynamic textures, client options, Stonecraft targets, or legacy Forge 1.8.9 coremods):
     - Switch and operate in the `Vermeil-Companion` workspace.
     - Leverage companion skills: `stonecraft` (modern multi-loader Fabric/NeoForge), `minecraft-mod` (Mixins, Forge 1.8.9 ASM).
     - Run companion verification gates: `.\stonecraft\gradlew.bat -p stonecraft chiseledBuildAndCollect` (or Forge 1.8.9 build with JDK 8).
   - If the task spans BOTH projects (End-to-End Ecosystem Feature):
     - Follow the full pipeline:
       a. Shared IPC / File Contract: Define JVM parameters (`-Dvermeil.dataDir=<path>`) and local JSON structures (`vermeil-settings.json`, `cape/meta.json`).
       b. Desktop Launcher Phase: Implement SolidJS UI toggle/screen, backend state persistence, and launch argument injection in `services/launch.rs` / `services/prepare.rs`.
       c. Companion Mod Phase: Switch to `Vermeil-Companion`, hydrate settings on startup, hook client render-states via Stonecraft preprocessed Mixins, and compile test jars.
       d. Local Integration Test: Place built jar into `<instance>/.minecraft/mods/` or `%LOCALAPPDATA%\Vermeil\cache\companion\jars\` to smoke-test end-to-end.

4. Unified Engineering Standards Across Both Projects:
   - "Ponytail" Lazy Senior Dev Mode: Stop at the first rung that holds (YAGNI, reuse existing helpers, standard library first, shortest working diff, fix root causes). Never delete Stonecutter preprocessor comments (`//? if ...`).
   - Zero Telemetry & Privacy-First: All communication and data persistence remain 100% local. Zero external analytics or phone-home tracking.
   - Closed Contribution Policy: Maintainer-driven development. External PRs are not accepted; downstream forks are guided under GPLv3.
   - Privacy Hygiene: Run `node scripts/check-privacy.mjs` before committing in either repository.

5. Generate the Git Workflow & Release Skill (`git-workflow`):
   - Conventional Commits: `type(scope): imperative summary under 70 chars`.
     Types: `feat`, `fix`, `refactor`, `perf`, `style`, `docs`, `chore`, `test`, `release`.
   - Autonomous Local Checkpoints: Auto-commit locally once verification gates pass (`check-privacy.mjs`, `cargo test`, `pnpm build`) to keep working tree clean.
   - Strict Manual Push Protocol: NEVER run `git push` autonomously. Remote pushes strictly require an explicit user prompt.
   - Pending Push Footer: If local commits are ahead of remote, include an unpushed commits banner on every turn.
   - Dual-Repository Staging & Promotion:
     - Launcher: `origin` (`Vermeil-Private` for active private development) ➔ `release` (`Vermeil-Launcher` for clean public releases).
     - Companion: `origin` (`companion-private`) ➔ `release` (`vermeil-companion`).
     - Staging Flow: Work and verify in private first. When cutting a release or publishing, sync/cherry-pick verified commits onto `release/main`. Original commit timestamps and author details are 100% preserved.
   - Standing Data Branches: `updates` (updater manifests) and `badges` (status badges) — never PR into `main`.
   - Release Lifecycle & Version Bumping:
     - Synchronize versions across all three files: `launcher/package.json`, `launcher/src-tauri/tauri.conf.json`, and `launcher/src-tauri/Cargo.toml`.
     - Changelog Generation: Update `CHANGELOG.md` with user-facing Added, Changed, Fixed sections from Conventional Commits.
     - Tagging: Tag `v0.1.0-alpha-N` on a `release: 0.1.0 (alpha build N)` commit. Pushed tags are immutable.
     - Companion Mod Releases: Tag `v*` on `Vermeil-Companion` to trigger GitHub Actions matrix compilation and `companion-manifest.json` generation.
```
```

---

### Track B: Bug Hunting, Suggestions & Issue Reporting

When you encounter a bug, have an idea for an enhancement, or want to propose a feature, you do **not** need to install build toolchains or generate persistent skills. Use one of the two prompts below to have your AI assistant analyze the codebase and draft a clean, professional GitHub submission for the maintainers:

#### Option 1: Bug Diagnosis & Investigation Prompt
Use this prompt when something is broken or misbehaving:

```text
You are an expert bug investigator and software diagnostic engineer assisting me with Vermeil Launcher.
I encountered a bug or unexpected behavior and need your help diagnosing the root cause and compiling an actionable, professional bug report to submit to the project maintainers.

Please follow this diagnostic protocol:

1. Gather Bug Context:
   - Ask me what happened, what I expected to happen, and steps to trigger it.
   - Ask for relevant error messages, screenshots, or log excerpts from:
     - Windows: `%LOCALAPPDATA%\Vermeil\logs\`
     - Linux: `~/.local/share/Vermeil/logs/` or terminal stdout/stderr

2. Codebase Investigation (Read-Only Analysis):
   - Search and inspect relevant codebase areas to trace the bug's execution path:
     - Frontend UI & State: launcher/src/screens/, launcher/src/modals/, launcher/src/App.tsx
     - IPC Boundary: launcher/src/ipc/commands.ts (wrapper) and launcher/src-tauri/src/commands/
     - Backend Services: launcher/src-tauri/src/services/
     - Java / Instance Launch: services/java.rs, services/launch.rs, services/prepare.rs
     - Mod & Content Management: services/modrinth.rs, services/curseforge.rs, services/modpack.rs
     - Cloud Sync & Tokens: services/google_cloud.rs
   - Evaluate cross-platform differences: Does this behavior differ between Windows (WebView2) and Linux (WebKitGTK)?
   - Locate the exact root cause: Pinpoint the specific file(s), function(s), and line numbers responsible.

3. Safety & Preservation Guardrail:
   - Do NOT modify any code or files in the repository. This is strictly a diagnostic and reporting task.
   - Redact any sensitive information (usernames, OAuth tokens, account UUIDs, local file paths) from logs.

4. Generate GitHub Issue Report:
   Format a complete, copy-paste-ready Markdown issue report using this exact template:

   ---
   ### [Bug]: <Concise, descriptive title>

   **Environment:**
   - OS: <Windows 10/11 / Linux distribution & display server>
   - Launcher Version: <Version or commit SHA>
   - Java Version: <If launch-related>
   - Mod Loader & Minecraft Version: <If instance-related>

   **Description:**
   <Clear summary of the bug and its impact on the user.>

   **Steps to Reproduce:**
   1. Go to '...'
   2. Click on '...'
   3. Scroll down to '...'
   4. See error

   **Expected Behavior:**
   <Clear and concise description of what you expected to happen.>

   **Actual Behavior:**
   <Clear and concise description of what actually happened.>

   **Code Investigation & Root Cause:**
   - **Suspected File & Line:** `<path/to/file.ext#L123>`
   - **Technical Explanation:** <Explain why the bug occurs at the code level, e.g. unhandled edge case, race condition, IPC type mismatch, or platform API variance.>

   **Relevant Logs / Stack Trace:**
   ```text
   <Redacted log excerpt showing the error or panic>
   ```

   **Possible Fix or Workaround (Optional):**
   <Brief suggestion for fixing or working around the issue without modifying production state.>
   ---
```

#### Option 2: Feature Suggestion & Enhancement Proposal Prompt
Use this prompt when you have an idea, improvement, or architectural suggestion:

```text
You are an expert product architect and full-stack software designer assisting me with Vermeil Launcher.
I have an idea or feature suggestion for the project and need your help evaluating its architectural feasibility against the existing codebase and formatting a high-quality feature proposal for the maintainers.

Please follow this evaluation protocol:

1. Understand the Suggestion:
   - Ask me what feature or enhancement I want to propose, what problem it solves, and who benefits.

2. Codebase & Architectural Feasibility Check (Read-Only):
   - Review relevant existing codebase patterns:
     - Does something similar already exist that could be reused or extended?
     - Tactile Bento Design System (docs/UI.md): Does the proposed UI fit the modular Bento card grid, recessed wells, flat data badges, and 3D action buttons without adding redundant visual clutter?
     - "Ponytail" Efficiency Ladder: Can this be achieved with minimal abstractions, standard library tools, or native OS capabilities?
     - Zero-Telemetry & Privacy: Does this proposal maintain strict user privacy and local-first execution?
     - IPC & Systems Flow: How would this flow between Rust backend services and the SolidJS frontend?

3. Safety Guardrail:
   - Do NOT edit or modify files in the codebase. This is an architectural proposal drafting task.

4. Generate Feature Proposal:
   Format a complete, copy-paste-ready Markdown proposal for GitHub Issues using this template:

   ---
   ### [Feature / Enhancement]: <Concise title>

   **Motivation & Use Case:**
   <Why is this feature needed? What friction or limitation does it address?>

   **Proposed Solution:**
   <Clear description of how the feature should behave and feel to the user.>

   **Design & UX Alignment:**
   - **Tactile Bento Placement:** <Where in the UI would this live? (e.g., new Bento panel, settings plate, dock navigation, or modal)>
   - **Visual Restraint:** <How does it avoid redundant affordances (e.g., using existing status borders instead of floating badges)?>

   **Technical & Architectural Feasibility:**
   - **Frontend Impact:** <SolidJS screens/components/signals involved>
   - **Backend / IPC Impact:** <New Tauri command or Rust service if needed>
   - **Privacy & Security:** <Confirmation that zero-telemetry and credential isolation are preserved>

   **Alternatives Considered:**
   <Any other ways this problem could be solved, or why existing workflows don't address it.>
   ---
```

---

## 2. Manual Prerequisites and Setup (If Not Using AI)

> [!NOTE]
> **Zero Required Cloud Dependencies:**
> Building and running Vermeil locally requires **zero** external API keys or cloud services. All features provide robust local and serverless fallbacks out of the box:
> - **Instance Sharing**: Generates and imports 100% serverless, offline `VML...` codes by default without needing a Cloudflare Worker.
> - **Settings Persistence**: Saves locally to `%LOCALAPPDATA%\Vermeil\` (Windows) or `~/.local/share/Vermeil/` (Linux) without needing Google Cloud OAuth.
> - **Companion Mod**: Caches locally and works offline without needing a GitHub API token.
> - **Auto-Updater**: Only needed when shipping production auto-updating distribution builds.
>
> You only need to configure Google Cloud, Cloudflare, or Minisign if you are deploying your own production release infrastructure.

The lists below are for building the **launcher**. The companion mod
(maintained in [`VermeilDev/Vermeil-Companion`](https://github.com/VermeilDev/Vermeil-Companion)) needs extra JDKs — see [Companion Mod](#companion-mod).

### Windows

- [Node.js 24 LTS](https://nodejs.org/) (includes npm)
- [pnpm 11](https://pnpm.io/) — `npm install -g pnpm`
- [Rust](https://rustup.rs/) — `rustup default stable`
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload)

### Linux (Arch)

```bash
sudo pacman -S nodejs-lts-krypton npm webkit2gtk-4.1 libayatana-appindicator librsvg patchelf base-devel openssl gtk3
npm install -g pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Linux (Ubuntu/Debian)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential libssl-dev
```

Then install Node 24 and pnpm via [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm), and Rust via [rustup](https://rustup.rs/).

### Companion mod (all platforms)

Only needed if you build the companion mod from [`VermeilDev/vermeil-companion`](https://github.com/VermeilDev/vermeil-companion):

- **JDK 25** — [Temurin/Adoptium](https://adoptium.net/) 25, for the 26.x
  project. The latest Minecraft (26.x) requires Java 25. Confirm with `java -version`.
- **JDK 21** — [Temurin/Adoptium](https://adoptium.net/) 21, for the 1.21.x
  projects (their era's Loom/Gradle doesn't run on 25).
- **JDK 8** — [Temurin/Adoptium](https://adoptium.net/) 8, for the Forge 1.8.9
  project. Classic ForgeGradle 2 and its Gradle 3.1 only run on Java 8. A portable
  (non-system) JDK 8 is fine — pin it via `org.gradle.java.home` in that project's
  `gradle.properties`.

No separate Gradle install is required — each project ships a Gradle wrapper
(`gradlew` / `gradlew.bat`). See [Companion Mod](#companion-mod) below
for build commands.

## Running in Development

### Windows

```powershell
cd launcher
pnpm install
pnpm tauri dev
```

### Linux

```bash
cd launcher
pnpm install
WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev
```

The `WEBKIT_DISABLE_DMABUF_RENDERER=1` env var works around a WebKit2GTK GBM buffer issue on some GPU/Wayland configurations. If the app launches fine without it, you can omit it.

## Building for Release

```bash
cd launcher
pnpm tauri build
```

Outputs:
- **Windows**: `src-tauri/target/release/bundle/nsis/Vermeil_X.Y.Z_x64-setup.exe`
- **Linux**: `src-tauri/target/release/bundle/appimage/Vermeil_X.Y.Z_amd64.AppImage`

## Useful Commands

| Command | Where | What it does |
|---------|-------|--------------|
| `pnpm install` | `launcher/` | Install frontend dependencies |
| `pnpm tauri dev` | `launcher/` | Run app in dev mode (hot-reload) |
| `pnpm tauri build` | `launcher/` | Build release binaries |
| `pnpm build` | `launcher/` | Build frontend only (Vite) |
| `cargo check` | `launcher/src-tauri/` | Type-check Rust backend |
| `cargo build --release` | `launcher/src-tauri/` | Build Rust backend only |
| `cargo test` | `launcher/src-tauri/` | Run Rust unit & integration tests |

## Continuous Integration (CI)

Every push and pull request touching `launcher/**` triggers `.github/workflows/ci.yml`:
- **Matrix validation**: Builds and verifies the codebase across both **Windows** (`windows-2022`) and **Linux** (`ubuntu-24.04` with WebKit2GTK).
- **Checks performed**: Runs `pnpm run build` (Vite frontend compilation & asset bundling), `cargo check` (Rust compiler & clippy check), and `cargo test` (unit and integration tests).
- **Concurrency control**: Configured with `cancel-in-progress: true` keyed by Git ref (`${{ github.workflow }}-${{ github.ref }}`). Rapid successive commits on `main` automatically cancel obsolete in-flight checks to preserve Actions runner minutes.

## Companion Mod

The **Vermeil Companion Minecraft Mod** is maintained in its own dedicated repository:  
👉 **[`VermeilDev/Vermeil-Companion`](https://github.com/VermeilDev/Vermeil-Companion)**

It provides in-game client features (custom capes, Discord Rich Presence, client options synchronization). It is versioned and published independently of the desktop launcher.

### Prerequisites

- **JDK 25** (modern Stonecraft project) and **JDK 8** (legacy Forge 1.8.9 project).
- No system Gradle needed — each project in `Vermeil-Companion` ships its own Gradle wrapper (`gradlew` / `gradlew.bat`).

### Architecture (Modern Multi-Loader vs Legacy Forge)

1. **Modern Multi-Loader (`stonecraft/`)**:
   Powered by **Stonecraft** and **Stonecutter**. Unifies modern Minecraft versions across **Fabric** and **NeoForge** (1.21.11, 26.1, 26.2, 26.3) with a single shared Java codebase, conditional preprocessor comments (`//? if fabric`, `//? if neoforge`), and matrix collection via `chiseledBuildAndCollect`.
2. **Legacy PvP Forge 1.8.9 (`forge/1.8.9/`) — STRICTLY ISOLATED**:
   Forge 1.8.9 requires Java 8, Gradle 3.1, ForgeGradle 2.1, MCP mappings, and an ASM Coremod. It remains completely standalone in `forge/1.8.9/`.

Active Projects:

| Project | Minecraft range | Loader | Java | Cape hook era |
|---------|-----------------|--------|------|---------------|
| `stonecraft/` | 1.21.11, 26.1, 26.2, 26.3 | Fabric & NeoForge | 25 (21 for 1.21.x) | render-state (`AvatarRenderer.extractRenderState`) |
| `forge/1.8.9/` | 1.8.9 | Forge | 8 | coremod redirect (`getLocationCape`) |

### Building & Testing the Mod Locally

Inside your clone of [`Vermeil-Companion`](https://github.com/VermeilDev/Vermeil-Companion):

```powershell
# Modern multi-loader (Stonecraft) on Windows
cd stonecraft
.\gradlew.bat chiseledBuildAndCollect            # build all Fabric & NeoForge jars -> build/libs/
.\gradlew.bat "Set active project to 26.3-fabric" # switch active target
.\gradlew.bat buildActive                         # build only active target
.\gradlew.bat runClient                           # launch dev client for active target
.\gradlew.bat "Reset active project"              # reset to canonical vcsVersion
```

```bash
# On Linux
cd stonecraft
./gradlew chiseledBuildAndCollect
```

The **Forge 1.8.9** project (`forge/1.8.9`) builds with Java 8:
pin it via `JAVA_HOME` pointing to JDK 8. Run `./gradlew setupDecompWorkspace --no-daemon` for MCP sources, then `./gradlew build --no-daemon`.

### Publishing & Launcher Integration (Download-on-Demand)

The companion jars are **not** bundled inside the launcher binary and **not** committed to the repository. The launcher uses a **download-on-demand** model:
1. Releasing a tag (`v*`) in `Vermeil-Companion` builds every target and publishes `vermeil-<modVersion>+<mc_range>.jar` plus a generated `companion-manifest.json` as GitHub release assets.
2. At instance preparation and game launch, `launcher/src-tauri/src/services/companion_mod.rs` queries the release API for `VermeilDev/Vermeil-Companion`, picks the matching jar for the instance's Minecraft version and loader, downloads it, and verifies its SHA-1 hash into `.minecraft/mods/`.
3. If offline, the launcher uses local cached jars from `%LOCALAPPDATA%\Vermeil\cache\companion\jars\`.

## Mermaid Diagrams & Flowcharts Standards

When documenting architectural pipelines, data flows, and security protocols in `docs/`:
- **Explicit `<br/>` Line Breaks (Max 24–28 Characters per Line)**: Proportional fonts and SVG rendering engines underestimate text bounding widths when rendered without fixed metrics. If a line exceeds ~28 characters, the right-hand text clips outside the node border. Split labels into short lines under 28 characters using explicit `<br/>`.
- **Top-Down (`TD`) Layout Standard**: Always prefer `flowchart TD` (top-down) rather than `flowchart LR` for complex pipelines to prevent horizontal viewport clipping (>1200px).
- **No Chained Ampersand Multi-Arrows with Edge Labels**: Never use `A & B & C --> Filter -->|Label| D`. Connect inputs to `Filter` individually (`A --> Filter`), then route `Filter -->|Label| D`.
- **No Raw URLs in Node Boxes**: Never paste raw URLs inside node boxes. Use clean HTTP method and endpoint descriptions: `POST Token Request<br/>(oauth2.googleapis.com)`.
- **Sequence Diagram Message Sanitization**: In `sequenceDiagram`, avoid unescaped double quotes, curly braces `{id}`, square brackets `[tag]`, or nested query strings.
- **Quoted Syntax**: Always quote labels: `nodeId["Label Title<br/>(Brief detail)"]`.
- **Comparative Flowcharts**: When documenting refactors or optimizations, include a comparative flowchart showing legacy flawed vs modern calibrated pipelines with a summary comparison table.

## Project Structure

```
Vermeil-Launcher/             # Desktop Launcher repo root
├── launcher/                 # the desktop launcher (Tauri app)
│   ├── src/                  # SolidJS frontend
│   ├── src-tauri/            # Rust backend (Tauri)
│   │   ├── src/
│   │   │   ├── commands/     # IPC command handlers
│   │   │   ├── services/     # Business logic
│   │   │   ├── models/       # Data types
│   │   │   ├── util/         # Helpers (paths, http)
│   │   │   ├── lib.rs        # Plugin/command registration
│   │   │   └── main.rs       # Entry point
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json   # Tauri config (version, window, plugins)
│   ├── package.json
│   └── vite.config.ts
├── docs/                     # project documentation (DEVELOPMENT.md, UI.md)
├── scripts/                  # local tooling and verification scripts
└── archive/                  # local, .gitignored archive (historical research, legacy mod targets)
```

*(The Minecraft companion mod is maintained in the dedicated repository [VermeilDev/Vermeil-Companion](https://github.com/VermeilDev/Vermeil-Companion)).*
