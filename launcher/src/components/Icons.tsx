// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";

export const IconHome: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>
    <polyline points="9 21 9 13 15 13 15 21"/>
  </svg>
);

export const IconGrid: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
);

export const IconPuzzle: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19 11V9a2 2 0 0 0-2-2h-2V5a2 2 0 0 0-4 0v2H9a2 2 0 0 0-2 2v2H5a2 2 0 0 0 0 4h2v2a2 2 0 0 0 2 2h2v2a2 2 0 0 0 4 0v-2h2a2 2 0 0 0 2-2v-2h2a2 2 0 0 0 0-4z"/>
  </svg>
);

export const IconDownload: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v13M7 11l5 5 5-5"/><path d="M4 20h16"/>
  </svg>
);

export const IconCloud: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={props?.class}>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
  </svg>
);

export const IconGoogleCloud: Component<{ class?: string }> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="url(#cloud-theme-sway-fill)"
    stroke-width="2.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={`icon-cloud-sync ${props.class || ""}`}
  >
    <defs>
      {/* High-luminance stroke gradient that pops against dark wells AND purple primary buttons */}
      <linearGradient id="cloud-theme-sway" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f5ff">
          <animate attributeName="stop-color" values="#00f5ff;#ffffff;#ff60b0;#38bdf8;#00f5ff" dur="4.2s" repeatCount="indefinite" />
        </stop>
        <stop offset="30%" stop-color="#38bdf8">
          <animate attributeName="stop-color" values="#38bdf8;#00f5ff;#ffffff;#ff60b0;#38bdf8" dur="4.2s" repeatCount="indefinite" />
        </stop>
        <stop offset="65%" stop-color="#ffffff">
          <animate attributeName="stop-color" values="#ffffff;#ff60b0;#38bdf8;#00f5ff;#ffffff" dur="4.2s" repeatCount="indefinite" />
        </stop>
        <stop offset="100%" stop-color="#ff60b0">
          <animate attributeName="stop-color" values="#ff60b0;#38bdf8;#00f5ff;#ffffff;#ff60b0" dur="4.2s" repeatCount="indefinite" />
        </stop>
        <animateTransform
          attributeName="gradientTransform"
          type="rotate"
          from="0 0.5 0.5"
          to="360 0.5 0.5"
          dur="4s"
          repeatCount="indefinite"
        />
      </linearGradient>

      {/* Luminous semi-transparent body fill so the cloud has a visible silhouette instead of just a thin wire */}
      <linearGradient id="cloud-theme-sway-fill" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f5ff" stop-opacity="0.35" />
        <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.22" />
        <stop offset="100%" stop-color="#ff60b0" stop-opacity="0.30" />
      </linearGradient>
    </defs>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="url(#cloud-theme-sway)" />
  </svg>
);

export const IconCloudSync: Component<{ class?: string }> = IconGoogleCloud;

export const IconSettings: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

export const IconUser: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={props?.class}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

export const IconPlay: Component = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);

export const IconPlus: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export const IconArrowLeft: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
  </svg>
);

export const IconArrowRight: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
  </svg>
);

export const IconCube: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">
    <polygon points="12,3 21,8 21,16 12,21 3,16 3,8"/>
    <polyline points="3,8 12,13 21,8"/>
    <line x1="12" y1="13" x2="12" y2="21"/>
  </svg>
);

// Layers — Feather Icons (MIT). https://github.com/feathericons/feather
// Three stacked plates: a clean "bundle of items" symbol used for modpacks.
export const IconLayers: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">
    <polygon points="12,2 22,7 12,12 2,7"/>
    <polyline points="2,12 12,17 22,12"/>
    <polyline points="2,17 12,22 22,17"/>
  </svg>
);

export const IconSword: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/>
    <line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/>
  </svg>
);

export const IconWand: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <line x1="3" y1="21" x2="21" y2="3"/>
    <path d="M18 6h.01M6 6h.01M14 4h.01M4 14h.01M10 2h.01M2 10h.01"/>
  </svg>
);

export const IconBolt: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

export const IconRefresh: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
);

export const IconMonitor: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
  </svg>
);

export const IconGlobe: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
);

export const IconServer: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
);


// Heart — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconHeart: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
  </svg>
);


// Trash icon — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconTrash: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1.5 14a2 2 0 0 1-2 2H8.5a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
);

// Search icon — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconSearch: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="7"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

// Folder-open icon — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconFolderOpen: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);

// Shirt icon — Feather Icons (MIT). https://github.com/feathericons/feather
// Used for the Skins sidebar entry.
export const IconShirt: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>
  </svg>
);

// Trash-2 icon variant for inline removal — Feather Icons (MIT).
export const IconTrash2: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1.5 14a2 2 0 0 1-2 2H8.5a2 2 0 0 1-2-2L5 6"/>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
);

// Refresh / reload — Feather Icons (MIT).
export const IconReload: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/>
    <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>
  </svg>
);

// Upload — Feather Icons (MIT).
export const IconUpload: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

// Arrow up — Feather Icons (MIT). Used for "scroll to top" log control.
export const IconArrowUp: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="19" x2="12" y2="5"/>
    <polyline points="5 12 12 5 19 12"/>
  </svg>
);

// Arrow down — Feather Icons (MIT). Used for "scroll to bottom" log control.
export const IconArrowDown: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <polyline points="19 12 12 19 5 12"/>
  </svg>
);

// Arrow-up-circle — Feather Icons (MIT). https://github.com/feathericons/feather
// Used for software updates and upgrades.
export const IconArrowUpCircle: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="16 12 12 8 8 12"/>
    <line x1="12" y1="16" x2="12" y2="8"/>
  </svg>
);

// Clock — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconClock: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

// External-link — Feather Icons (MIT). https://github.com/feathericons/feather
export const IconExternalLink: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// Minus / dash — Feather Icons (MIT). Used on the sidebar's pin-manage
// button when one or more instances are already pinned, signalling the
// user can deselect them.
export const IconMinus: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

// Modrinth wordmark — official "M" curl glyph from Modrinth's brand assets.
// We keep the original two-path structure but swap the baked `#1bd96a` fill
// for `currentColor` so the surrounding badge can tint it (the badge sets
// `color: #1bd96a` to match Modrinth's brand green).
// Source: https://modrinth.com/legal/branding (used under nominative fair use
// to identify Modrinth as a content source).
export const IconModrinth: Component = () => (
  <svg viewBox="0 0 514 514" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M504.16 323.56c11.39-42.09 12.16-87.65.04-132.8C467.57 54.23 327.04-26.8 190.33 9.78 84.81 38.02 12.39 128.07 1.69 230.47h43.3c10.3-83.14 69.75-155.74 155.76-178.76 106.3-28.45 215.38 28.96 253.42 129.67l-42.14 11.27c-19.39-46.85-58.46-81.2-104.73-95.83l-7.74 43.84c36.53 13.47 66.16 43.84 77 84.25 15.8 58.89-13.62 119.23-67 144.26l11.53 42.99c70.16-28.95 112.31-101.86 102.34-177.02l41.98-11.23a210.2 210.2 0 0 1-3.86 84.16z"
      fill-rule="evenodd"
    />
    <path d="M322.99 504.22C186.27 540.8 45.75 459.77 9.11 323.24A257.6 257.6 0 0 1 1 275.46h43.27c1.09 11.91 3.2 23.89 6.41 35.83 3.36 12.51 7.77 24.46 13.11 35.78l38.59-23.15a169 169 0 0 1-8.17-23.45c-24.04-89.6 29.2-181.7 118.92-205.71 17-4.55 34.1-6.32 50.8-5.61L256.19 133c-10.46.05-21.08 1.42-31.66 4.25-66.22 17.73-105.52 85.7-87.78 151.84 1.1 4.07 2.38 8.04 3.84 11.9l49.35-29.61-14.87-39.43 46.6-47.87 58.9-12.69 17.05 20.99-27.15 27.5-23.68 7.45-16.92 17.39 8.29 23.07s16.79 17.84 16.82 17.85l23.72-6.31 16.88-18.54 36.86-11.67 10.98 24.7-38.03 46.63-63.73 20.18-28.58-31.82-49.82 29.89c25.54 29.08 63.94 45.23 103.75 41.86l11.53 42.99c-59.41 7.86-117.44-16.73-153.49-61.91l-38.41 23.04c50.61 66.49 138.2 99.43 223.97 76.48 61.74-16.52 109.79-58.6 135.81-111.78l42.64 15.5c-30.89 66.28-89.84 118.94-166.07 139.34" />
  </svg>
);

// CurseForge anvil glyph — official mark from Overwolf's CurseForge brand
// kit. Path is preserved verbatim; fill is swapped from `#130700` to
// `currentColor` so the badge's `color: #f16436` (CurseForge orange) tints
// it appropriately on dark backgrounds.
// Source: https://www.curseforge.com (used under nominative fair use to
// identify CurseForge as a content source).
export const IconCurseForge: Component = () => (
  <svg viewBox="0 0 260 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M196.422 98.77S247.874 90.623 256 66.858h-78.819V48H4l21.334 24.862v25.473s53.83-2.811 74.653 13.047c28.502 26.532-32.058 62.397-32.058 62.397l-10.384 34.512c16.239-15.529 47.188-35.618 103.933-34.65-21.594 6.854-43.307 17.56-60.211 34.65h114.71l-10.802-34.512s-83.139-49.235-8.753-75.005v-.004Z" />
  </svg>
);

// Microsoft brand mark — 4-quadrant square emblem.
// Used under nominative fair use to identify Microsoft account authentication.
// Source: https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks
export const IconMicrosoft: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" xmlns="http://www.w3.org/2000/svg" class={props.class}>
    <rect x="1" y="1" width="6.5" height="6.5" fill="#f25022"/>
    <rect x="8.5" y="1" width="6.5" height="6.5" fill="#7fba00"/>
    <rect x="1" y="8.5" width="6.5" height="6.5" fill="#00a4ef"/>
    <rect x="8.5" y="8.5" width="6.5" height="6.5" fill="#ffb900"/>
  </svg>
);

// Info — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `ℹ` status glyph in `.toast-icon` (info toasts).
export const IconInfo: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>
);

// Check — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `✓` status glyph in `.toast-icon` (success toasts).
export const IconCheck: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

// Star — Feather Icons (MIT).
export const IconStar: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={props?.class}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);

// Pin — Feather Icons (MIT).
export const IconPin: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={props?.class}>
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"/>
  </svg>
);

// Alert-triangle — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `⚠` status glyph in `.toast-icon` (warning/error toasts).
export const IconAlertTriangle: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={props?.class}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

// X — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `✕`/`✕` close affordances in `.modal-close`,
// `.account-card-remove`, `.update-banner-dismiss`, and the `✕` toast-icon.
export const IconX: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

// Image — Feather Icons (MIT). https://github.com/feathericons/feather
// Used for the custom-cape upload affordance and the empty workspace hint.
export const IconImage: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);

// Edit (pencil) — Feather Icons (MIT). https://github.com/feathericons/feather
// Used to re-open an existing custom cape in the editor.
export const IconEdit: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>
  </svg>
);

// Chevron-down — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `▾` glyph in `.custom-dropdown-arrow`.
export const IconChevronDown: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

// Chevron-left — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `‹` glyph in `.page-nav-btn` and `.modpack-page-btn`.
export const IconChevronLeft: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);

// Chevron-right — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `›` glyph in `.page-nav-btn` and `.modpack-page-btn`.
export const IconChevronRight: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

// Rotate-ccw — Feather Icons (MIT). https://github.com/feathericons/feather
// Replaces the `↺` glyph in `.keybind-reset` (reset-to-default affordance).
export const IconRotateCcw: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="1 4 1 10 7 10"/>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  </svg>
);

// Rotate-cw — Feather Icons (MIT). https://github.com/feathericons/feather
// The cape editor's quarter-turn button; clockwise to match the direction the
// rotation slider runs.
export const IconRotate: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
);

// Shield-check — based on Feather Icons' shield (MIT). https://github.com/feathericons/feather
// Used for the "Official" badge on the Java Edition News header to signal the
// patch notes come straight from Mojang's official feed.
export const IconShieldCheck: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <polyline points="9 12 11 14 15 10"/>
  </svg>
);

export const IconMaximize2: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15 3 21 3 21 9"/>
    <polyline points="9 21 3 21 3 15"/>
    <line x1="21" y1="3" x2="14" y2="10"/>
    <line x1="3" y1="21" x2="10" y2="14"/>
  </svg>
);

export const IconMinimize2: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4 14 10 14 10 20"/>
    <polyline points="20 10 14 10 14 4"/>
    <line x1="14" y1="10" x2="21" y2="3"/>
    <line x1="3" y1="21" x2="10" y2="14"/>
  </svg>
);

// File-text icon — Feather Icons (MIT).
export const IconFileText: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);

// Package icon — Feather Icons (MIT).
export const IconPackage: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
    <line x1="12" y1="22.08" x2="12" y2="12"/>
  </svg>
);

// Share-2 icon — Feather Icons (MIT). Used for Instance Share Codes (VML).
export const IconShare2: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="5" r="3"/>
    <circle cx="6" cy="12" r="3"/>
    <circle cx="18" cy="19" r="3"/>
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
  </svg>
);

// Clipboard — Feather Icons (MIT).
export const IconClipboard: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
  </svg>
);

// Palette — Feather Icons (MIT). Used for Themes & Accent palette.
export const IconPalette: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
  </svg>
);

// Sliders — Feather Icons (MIT). Used for Accessibility & Motion.
export const IconSliders: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="4" y1="21" x2="4" y2="14"/>
    <line x1="4" y1="10" x2="4" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12" y2="3"/>
    <line x1="20" y1="21" x2="20" y2="16"/>
    <line x1="20" y1="12" x2="20" y2="3"/>
    <line x1="1" y1="14" x2="7" y2="14"/>
    <line x1="9" y1="8" x2="15" y2="8"/>
    <line x1="17" y1="16" x2="23" y2="16"/>
  </svg>
);

// Mouse Pointer — Feather Icons (MIT). Used for Controls & Mouse.
export const IconMousePointer: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
    <path d="M13 13l6 6"/>
  </svg>
);

// Volume-2 — Feather Icons (MIT). Used for Sound Levels.
export const IconVolume2: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
  </svg>
);

// CPU — Feather Icons (MIT). Used for Client Lifecycle & System.
export const IconCpu: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
    <rect x="9" y="9" width="6" height="6"/>
    <line x1="9" y1="1" x2="9" y2="4"/>
    <line x1="15" y1="1" x2="15" y2="4"/>
    <line x1="9" y1="20" x2="9" y2="23"/>
    <line x1="15" y1="20" x2="15" y2="23"/>
    <line x1="20" y1="9" x2="23" y2="9"/>
    <line x1="20" y1="14" x2="23" y2="14"/>
    <line x1="1" y1="9" x2="4" y2="9"/>
    <line x1="1" y1="14" x2="4" y2="14"/>
  </svg>
);

// Hard Drive — Feather Icons (MIT). Used for Storage Management.
export const IconHardDrive: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="12" x2="2" y2="12"/>
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
    <line x1="6" y1="16" x2="6.01" y2="16"/>
    <line x1="10" y1="16" x2="10.01" y2="16"/>
  </svg>
);

// Coffee — Feather Icons (MIT). Used for Java Environment.
export const IconCoffee: Component = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
    <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
    <line x1="6" y1="1" x2="6" y2="4"/>
    <line x1="10" y1="1" x2="10" y2="4"/>
    <line x1="14" y1="1" x2="14" y2="4"/>
  </svg>
);

// Camera — Feather Icons (MIT). Used for In-game Screenshots.
export const IconCamera: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>
);


