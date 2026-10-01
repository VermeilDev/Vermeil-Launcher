# Vermeil UI

How the SolidJS frontend (`launcher/src/`) is organized and the conventions to follow. Design tokens are the source of truth in `styles/base.css`; this doc points at them rather than duplicating the tables.

## Stack

- **SolidJS 1.9** — signals + JSX, fine-grained reactivity (no virtual DOM).
- **Vite 6** — HMR in dev, single CSS bundle in prod.
- **Plain CSS** — no Tailwind, no CSS-in-JS. Tokens as CSS variables.
- **Icons** — SVG components in `components/Icons.tsx` (Feather, MIT). Never emoji/glyphs in UI.

## Layout

```
launcher/src/
├── App.tsx          # Root + global signals + screen routing
├── index.tsx        # Entry: imports CSS, intercepts external links, renders App or LogsPopout
├── components/      # Reusable building blocks
├── modals/          # Modal dialogs + create/import pseudo-screens
├── screens/         # Top-level views
├── lib/             # Pure helpers (cape, keybinds, contentVersion, versionPick)
├── services/        # Frontend-only logic (updater)
├── ipc/commands.ts  # Typed Tauri invoke() wrappers — single source of truth
└── styles/          # 10 CSS modules (below)
```

## CSS modules

Ten modules, combined by Vite. Import order in `index.tsx` matters — earlier files are the foundation, later ones override:

`base.css` → `layout.css` → `components.css` → `logs.css` → `notifications.css` → `modals.css` → `screens.css` → `dock.css` → `splash.css` → `themes.css`

| File | Owns |
|------|------|
| `base.css` | Reset, **all tokens** (`:root`), `body`, `.app` shell, resize handles, offline banner, scrollbars |
| `layout.css` | `.main`, `.titlebar`, `.content`, `.page-title`, `.section-label`, tooltips |
| `components.css` | Canonical vocabulary: `.btn`, `.card`, `.card-grid`, `.badge`, `.field-control`, `.tab`, `.panel`, `.toggle`, modal base, search/filter, settings rows |
| `logs.css` | Log viewer, Home continue/news grids, article reader |
| `notifications.css` | Toasts, install-progress popup, dependency-issues modal, mod-card tags, update banner |
| `modals.css` | Crash modal, onboarding wizard, Java chooser |
| `screens.css` | Skins + 3D canvas, account cards, download-history cards, modpack pagination |
| `dock.css` | Floating dock: pills, center action, pin row |
| `splash.css` | Boot splash (cube + wordmark + progress bar) |
| `themes.css` | 6-Theme Engine token overrides, dynamic colorway swaps, GPU theme transitions |

## Design language

Defined entirely as tokens in `base.css :root` — reference `var(--token)`, never literals. Summary:

- **Sharp edges.** All `--radius-*` are `0`. Keep referencing the tokens so radius can return cohesively later.
- **Flat surfaces, hairline borders.** Depth from contrast + one shadow scale. Legacy Dungeons bevel tokens resolve to `none`.
- **Dark gray + 6 Color Themes.** Surface ramp paired with dynamic `--accent` palettes: **Neon Aurora** (Default `#8b5cf6`), **Emerald** (`#00C878`), **Inferno** (`#ff6500`), **Stealth** (`#e5e7eb`), **Deep Ocean** (`#0066ff`), and **Void** (`#c026ff`). Foreground icons and text on accent surfaces strictly use `--accent-contrast` (`#ffffff` for vibrant themes, `#0b0a10` for Stealth), ensuring high-contrast legibility across all themes.
- **Tactile Bento Design System:** Vermeil uses its own custom **Tactile Bento** design system. Features modular Bento grid panels (`.bento-card`, `.card-gamemode-section`), distinct category tag badge tints (`.tag-settings-*`), sunken recessed wells (`.card-section-body`, `#0f0e13`), interactive setting plates (`.setting-row` with 3px left border), and square checkboxes (`.check.check--lg`).
- **3D Buttons & Press-Down Styling:** Buttons (`.btn`, `.inst-card-play-btn`, `.inst-header-play-btn`) feature raised 3D bottom depth at rest (`box-shadow: var(--btn-depth)`). On hover (`:hover`), the bottom depth collapses (`box-shadow: none` or glow outline `0 0 12px var(--accent-glow)`) paired with `transform: translateY(1px)`, depressing the button under the cursor. On click-down (`:active`), it bottoms out with `transform: translateY(2px) scale(0.98)`—delivering a crisp, physical tactile press.
- **No ornament.** `.panel--bracketed` is a no-op (`display:none`).
- **Fonts:** Native system font stacks (`--font-display`, `--font`, `--font-mono`) for zero network dependency and zero layout shift.

Token groups (see `base.css` for values): surfaces (`--surface-*`, `--surface-raised-hover`), borders (`--border*`), text (`--text*`, `--text-bright`), accent (`--accent*`, `--accent-contrast`, `--accent-glow`), semantic state (`--danger/warn/success/info` + `*-soft`), type scale (`--fs-*`, `--fw-*`), spacing (`--space-0..8`, 4px scale), control heights (`--control-height-*`), card tracks (`--card-track`, `--card-track-compact`), button depth (`--btn-depth`, `--btn-depth-strong`), shadows (`--shadow-depth`, `--accent-shadow`, `--danger-shadow`), loader/source brand hues, plus compatibility aliases (`--warning`, `--text-main`, `--text-subtle`, `--text-dim`, `--border-subtle`, `--surface-active`).

## Canonical component vocabulary

`components.css` defines one class per role. Compose these; don't invent bespoke styles. **Modifiers use BEM-style `--`** (`.btn--primary`, `.card--inst`, `.badge--version`). State modifiers are unprefixed (`.active`, `.selected`, `.on`).

| Role | Class | Key variants |
|------|-------|--------------|
| Button | `.btn` | `--sm/--md/--lg`, `--primary/--neutral/--ghost/--danger`, `--block` (tactile 3D button) |
| Card | `.card` | `--inst`, `--mod`, `--media`, `--compact`, `--expanded` |
| Card grid | `.card-grid` | `--compact`. `auto-fit minmax(track,1fr)` — reflows, fills rows evenly |
| Badge | `.badge` | `--loader` (+ per-loader), `--version`, `--vnum` (content version), `--source` |
| Field | `.field-control` | `--text`, `--select`, `--search` |
| Tab | `.tab` (in `.tab-strip`) | `.active`, `:disabled` |
| Panel | `.panel` | `--sunken`. (`--bracketed` is a no-op) |
| Toggle | `.toggle` (+ `.on`) | two-half plate + thumb |

> Mod and instance cards are now `.card .card--mod` / `.card .card--inst`. Their `.mod-card-*` and `.inst-card-*` sub-elements are **not** legacy — they're layout helpers that compose inside the canonical card, the same way `.card-body`/`.card-title` do. Keep using them.
>
> Legacy containers still in markup: `.dl-item` (Downloads), `.account-card` (Account), `.add-card` (Library), plus `.install-btn`, `.choice-btn`, `.page-nav-btn`, `.field-input`. **New code uses the canonical classes above**; migrate legacy markup when you touch it.
>
> Already removed: `.inst-card`, `.mod-card`, `.mp-card`, `.inst-name`, `.inst-meta`, `.ctx-badge`, `.src-tab`/`.ctx-tab`/`.content-cat`/`.content-mode`, `.btn-accent`, `.btn-ghost`, `.control-select`, `.search-input`.
>
> Known duplicate: `.account-card` is defined in both `components.css` and `screens.css`; the `screens.css` copy wins on import order. Consolidate when Account is next touched.

## UI Restraint & Affordance Rules: The Necessity Test

Before adding, restyling, or modifying any interactive element (button, badge, tag, checkbox, or border), evaluate the **Necessity Test**:

### 1. The Single Affordance Rule (No Redundant Cues)
- **Never stack redundant affordances.** If an interactive card or plate already communicates its active/selected state through a colored outline, a 3px left border, and a tinted background plate, **do NOT add a floating checkmark icon or checkbox to it**.
- Multiple simultaneous selection cues (e.g. colored border + colored background + corner checkmark square + active badge) look noisy, cluttered, and amateur. One clear, tactile affordance is superior.

### 2. Semantic Alignment: Radio Tabs vs. Checkboxes
- **Mutually Exclusive Choices (1-of-N)**: e.g., choosing Modrinth vs CurseForge archive import format, or choosing a loader in Create Custom.
  - **Pattern**: Card or tab highlight (`.selected`, 3px colored left border, tinted background plate).
  - **Rule**: **NEVER put a square checkbox (`.check`, `<IconCheck>`) on a single-select card.** Checkboxes universally signify multi-select (toggling independent options on/off). Using a checkbox on mutually exclusive options is a semantic violation that confuses users.
- **Multi-Selection (0-to-N)**: e.g., bulk selecting mods in `InstanceMods.tsx`, selecting up to 6 pinned instances in `PinInstancesModal.tsx`.
  - **Pattern**: Dedicated square checkbox (`.check.check--lg`), placed cleanly in an aligned column with dedicated gutter spacing away from text and badges.

### 3. Buttons: The Action Test
- **Does this button need to exist?** If clicking the card, plate, or row itself performs the selection or opens the detail, do not clutter the card with a redundant "Select" or "Choose" button.
- Reserve buttons for explicit, divergent actions (`+ Install`, `Delete`, `Cancel`, `Open Folder`, `Save`).

### 4. Badges: The Information Test
- **Does this badge convey essential, non-redundant metadata?**
  - Use badges for file formats (`.mrpack`, `.zip`), loaders (`Fabric`, `NeoForge`), release tags / versions (`1.20.1`), or section categories (`.tag-settings-*`).
  - Do not add badges that repeat what is already stated in the title or subtitle.
  - Keep badge text concise (uppercase mono, 1-2 words).

### 5. Spatial Flow & Absolute Positioning Ban
- **Never absolute-position affordances over dynamic content.** Never use `position: absolute; top: 8px; right: 8px;` inside cards whose headers use `justify-content: space-between` or dynamic text/badges. This guarantees collisions on different screen sizes or badge lengths.
- All headers, titles, tags, and controls must participate in the natural flexbox or grid flow with explicit `gap`.
- **Labeled Dividers (`display: flex` + `flex: 1` Lines):** When styling labeled dividers (e.g. `// OR OFFLINE PROFILE`), never use fragile pixel-offset math (`width: calc(50% - 30px); position: absolute;`). Pixel offsets cut through text longer than ~60px. Always style the container as a flex row (`display: flex; align-items: center; gap: 12px; white-space: nowrap`) with `flex: 1` hairline pseudo-elements (`::before`, `::after`) that stretch to fill available horizontal space without clipping.

### 6. Dynamic Version Resolution (Zero Hardcoded Versions)
- **Never hardcode application version strings** (e.g. `v1.0.0`, `1.1.1`) in JSX markup, modal headers, or badges.
- Always resolve the runtime version dynamically from Tauri using `getVersion` from `@tauri-apps/api/app` wrapped in SolidJS `createResource` (`const [appVersion] = createResource(getVersion);`).
- This guarantees all onboarding wizard headers, status pills, and about dialogs stay perfectly synchronized with releases without manual edits to `.tsx` components.

### 7. Stay Within the Theme Without Overdoing It (Boring over Clever)
- Stay strictly within the Tactile Bento palette: sharp corners (`border-radius: 0`), chunky 3D buttons (`--btn-depth`, `--btn-depth-strong`), 3px left border on active plates, and recessed `#0f0e13` wells.
- Do not invent novel decorative doodads, corner ribbons, or extra container wrappers. Clean, tactile, and restrained beats busy and cluttered every time.

### 8. Tactile Tooltips (`data-tip`) & The Prohibition of Native `title`
- **NEVER use the native HTML `title="..."` attribute anywhere.** Native `title` triggers the browser/OS default tooltip popup (e.g. Windows white-bordered black boxes with sluggish hover delay) that completely clashes with Vermeil's tactile design.
- **ALWAYS use Vermeil's tactile tooltip system with `data-tip="..."`.**
  - **Styles & Mechanics**: Defined in `src/styles/layout.css` on `[data-tip]`. Features sharp corners (`border-radius: 0`), dark surface (`var(--surface-panel)`), 1px border (`var(--border-strong)`), 2.5px purple accent left edge (`border-left: 2.5px solid var(--accent)`), and deep drop shadow (`box-shadow: 0 4px 16px rgba(0,0,0,0.65)`).
  - **Positioning Classes**:
    - Default (centered above element): `data-tip="..."`
    - Below element: `class="... tip-below" data-tip="..."`
    - Left-anchored: `class="... tip-left" data-tip="..."`
    - Right-anchored: `class="... tip-right" data-tip="..."` (prevents right-edge viewport clipping)
    - Bottom-right: `class="... tip-below tip-right" data-tip="..."`
    - Bottom-left: `class="... tip-below tip-left" data-tip="..."`
  - **Restraint Rule**: Only add `data-tip` to discrete interactive affordances (icon buttons, status badges, chips). Never place `data-tip` on large containers (e.g. full cards, panels, or telemetry plates) or buttons that already have clear visible text.

### 9. Modal Dialog Restraint & Ban on Redundant Top-Right [X] Buttons
- **In overlay dialogs (`.modal-overlay`), NEVER add a top-right `modal-close` `[X]` button when explicit footer dismiss actions already exist** (`Cancel`, `Close`, `Got it`, `Dismiss`, `Skip setup`), along with backdrop click and `Escape` key handling.
- **Rationale**: Top-right `[X]` buttons create redundant affordances, clutter headers where category tags and titles belong, and cause tooltip clipping bugs (`data-tip` clipping past viewport or window boundaries). Modal dismissal must be clean, single-point, and restrained.

### 10. Dropdown & Popover Anchoring Invariant
- **When placing dropdown menus, version selectors, or custom select panels inside setting rows (`.setting-row`) or cards:**
  - The row container MUST enforce flex row alignment: `display: flex; align-items: center; justify-content: space-between; gap: 12px;`
  - The trigger button MUST be wrapped in a relative positioning container: `position: relative; display: inline-flex; flex-shrink: 0;`
  - The dropdown panel (`.custom-select-panel`) MUST be anchored directly to that wrapper: `position: absolute; right: 0; top: calc(100% + 4px); z-index: 100; min-width: 100%;`
  - **Never** allow a setting row with a dropdown to collapse into block display (e.g. by placing `.setting-row` outside `.card-section-body` without explicit flex rules), which forces the control to full width on a new line and displaces `right: 0` to the far right edge of the dialog away from the trigger button.

## Responsive contract

`--content-min` (480px) is the minimum fully-supported content width. Card grids reflow via `.card-grid` (track narrower than 480px, so columns drop without clipping). Below 480px, `.content > *` carries `max-width:100%` + `min-width:0` and media is capped, so nothing overflows. **Don't override the grid template inline** — let `.card-grid` do the reflow.

## Global state (`App.tsx`)

Module-level signals, exported with their setters and imported where needed. Resources: `instances`, `account`. Signals: `activeScreen`, `activeInstanceId`, `initialInstanceTab`, `gameRunning`, `pinnedInstanceIds`, `pinSelectorOpen`, `activeSkinUrl`, `activeOfflineSkin`, `offlineDummyVariant`, `gameLogs`, `downloads`, `activeDownloadsCount`, `dockHidden`, `paginationState`, `scrollModeActive`, `offline`, `updateAvailable`.

Helpers: `appendGameLog`/`clearGameLogs`/`gameLogsFor`, `trackDownload`/`completeDownload`/`failDownload`, `startBulkBatch`/`endBulkBatch`, `refreshPinnedInstanceIds`, `refreshActiveSkin`, `ensureAccountOrPrompt`, `setPaginationState`, `clearPaginationState`.

## Screens (`screens/`)

Routing is `<Show when={activeScreen() === "name"}>` in `App.tsx`; switch via `setActiveScreen(name)`.

| Screen | File | Purpose |
|--------|------|---------|
| home | `Home.tsx` | Hero Hub: 3D character stage, local session stats plate, Continue world session station, Mojang Java news + reader |
| library | `Library.tsx` | Dual-shelf instance library (Pinned shelf + All Instances), category filters (`All`, `Modded`, `Vanilla`, `Pinned`), batch selection & parallel deletion |
| mods | `InstanceMods.tsx` | One instance: Content / Browse / Files / Worlds / Logs tabs (large file) |
| settings | `Settings.tsx` | 6 tabs: All / General / Resources / Instance Defaults / Keybinds / About (Stable & Experimental release channel switcher, Java, GC presets, storage cleanup) |
| account | `Account.tsx` | Account vault (Microsoft sign-in & offline profiles) + Google Drive Settings Sync (`drive.appdata` backup/restore, Sign Out vs. Disconnect) |
| skins | `Skins.tsx` | 3D Character Studio unlocked for Microsoft & offline/guest accounts: WebGL model, 2-tone CAD mannequin dummy skins (`Classic` & `Slim`), Wardrobe with Crafty.gg sync, custom cape designer |
| downloads | `Downloads.tsx` | Persistent download history |
| (logs window) | `LogsPopout.tsx` | Standalone log viewer rendered when window label is `logs` |

### Home screen Hero Hub & Local Session Stats
The top section of `Home.tsx` features:
- **3D Character Stage (`CharacterStage.tsx`)**: Interactive WebGL character rendering the active player skin with an ambient idle look-around and walk cycle. Pauses automatically during gameplay (`gameRunning()`).
- **Local Session Stats Plate**: Displays active account status, instance count, total local playtime, and last active timestamp. **Privacy contract**: All metrics are computed strictly locally from on-disk `instance.json` files (`total_play_seconds`, `last_played`). Vermeil transmits zero telemetry or analytics over the network.
- **Continue Session Station**: Featured Hero card for the most recently played world with quick-launch play action, plus secondary quick-launch slots.

**Create/import pseudo-screens** (rendered in content area, Escape closes): `create-choose` (`CreateChoose.tsx`), `create-custom` (`CreateCustom.tsx`), `create-modpack` (`BrowseModpacks.tsx`), `create-import` (`ImportInstance.tsx`).

## Modals (`modals/` + a few in `components/`)

Mounted at App level, controlled by signal. `OnboardingWizard`, `PinInstancesModal`, `JavaChooserModal`, `CustomCapeEditor` (modals/); `NoAccountModal`, `InstallProgress`, `BulkInstallToast`, `DependencyIssuesModal`, `ManualDownloadModal`, `UpdateBanner`, `CrashReportModal`, `Toasts` (components/).

`ManualDownloadModal` is driven by the `manual-download-required` event rather than a signal, because the backend raises it from four different install paths. It queues entries so one modpack import blocking several files produces a single dialog, and offers the project page (`openUrl`) plus the instance's mods folder.

`InstallProgress` has two distinct header controls, and the difference is a behavioral contract: **Cancel** stops the install (`cancelInstall()`; the backend aborts at its next checkpoint and its failure path removes the partial instance), while the **X** only hides the popup and leaves the install running. Don't collapse them into one — the X used to be the only control and read as a cancel while doing nothing of the sort.

## Components (`components/`)

`FloatingDock` (bottom nav: nav pills + state-aware center play/stop/create + pin row — **this is the nav, there is no Sidebar**), `PaginationDock` (multi-position pagination island with page stepping, position modes [bottom, left, right], and global mouse wheel scroll mode), `Titlebar` (window controls, logo, title, account pill), `Dropdown` (styled select), `ModVersionPicker` (version list for one project, Portal-based panel), `Icons` (all SVGs), `PlayerHead`/`SkinAvatar`/`CapeChipThumb` (skin/cape renders), `PageSlider`, `JavaPathInput`, `KeybindCapture`, `ResizeHandles`, `Splash`, plus the modal/toast components listed above.

### Mod detail overlay (Browse)

**Clicking anywhere on a Browse mod card opens its detail overlay** (`modals/ModDetailModal.tsx`) — summary, a stat grid, loader pills, and the version picker. The card's own `+ Install` button and the multi-select checkbox `stopPropagation`, so they act without opening the overlay; while multi-select is active, clicking a card toggles selection instead. Dismiss with the footer Close button, clicking the backdrop, or pressing Escape.

Escape is handled in the overlay on the **capture** phase with `stopImmediatePropagation()`. The global handler in `App.tsx` treats Escape on the instance screen as "back to Library" and listens on `document` in the bubble phase, so without capture the overlay would close *and* navigate away.

It's an overlay rather than an in-place card expansion because expanding meant spanning the grid row (`grid-column: 1 / -1`) and reflowing every result after it, shoving the surrounding cards around the thing being read.

The version list inside it renders **inline**, not in a floating `<Portal>` panel. A portal is only needed to escape a clipping ancestor (`.card` is `overflow: hidden`); the modal body already scrolls, so inline avoids trigger-rect measurement, viewport-edge flipping, and outside-click listeners — each of which was a way for the panel to end up positioned off-screen.

## Conventions

- **IPC:** every backend call goes through a typed wrapper in `ipc/commands.ts`. Never call `invoke()` directly in a component.
- **Events:** `listen()` from `@tauri-apps/api/event`; store the unlisten fn and call it in `onCleanup`. Event names are kebab-case.
- **External links:** `openUrl()` from `@tauri-apps/plugin-opener` — never `window.open()`/`<a href>`. (A global click interceptor in `index.tsx` handles rendered HTML.)
- **Naming:** components/screens/modals `PascalCase`; helpers/services `camelCase`; CSS classes `kebab-case`.
- **Inline `style=`** is fine for true one-offs; promote to a class once reused. Don't hardcode colors/sizes — use tokens.
- **Animations:** reuse `fadeIn 0.15s ease`. Anything longer or more elaborate (e.g. the `mod-detail-pop` expand) needs a `@media (prefers-reduced-motion: reduce)` opt-out. **Empty states:** a helper card explaining the emptiness. **Errors:** toasts (`type:"error"`). **Loading:** `<Show>` with a muted "Loading…" fallback, no skeletons.

## Keybinds

Defined in `lib/keybinds.ts` (`KEYBINDS`); user overrides in `LauncherSettings.keybinds`. Add an entry there, react in the `App.tsx` keydown handler via `matchesKeybind`/`resolveBinding`; the Settings → Keybinds tab renders rows automatically. Settings fires `vermeil-keybinds-changed` to refresh the handler's cache. Escape is hardcoded (universal "back out"). `toggle_pin_selector` (default Ctrl+P) morphs the dock into the pinned-instance carousel. `toggle_scroll_mode` (default Z) toggles global mouse-wheel pagination scrolling across paginated grids.

## Don't

- Call `invoke()` directly from a component.
- Hardcode colors/sizes instead of tokens.
- Use emoji/Unicode glyphs as icons — use `Icons.tsx`.
- Use native HTML `title="..."` attributes for tooltips — use `data-tip="..."` with appropriate `.tip-*` class.
- Override a `.card-grid` template inline.
- Add a CSS module without updating `index.tsx` and this doc.
