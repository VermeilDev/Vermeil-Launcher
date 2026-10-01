// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared loader-identity helpers. One source of truth for the per-loader
 * badge color modifier and the human label, used by every surface that shows
 * a loader badge (Home, Library, Settings, InstanceMods) so the vocabulary
 * stays consistent.
 */

/** Per-loader color modifier class for the canonical `.badge--loader`. */
export function loaderBadgeClass(loader: string): string {
  switch (loader) {
    case "fabric": return "badge--fabric";
    case "forge": return "badge--forge";
    case "neoforge": return "badge--neoforge";
    case "quilt": return "badge--quilt";
    default: return "badge--vanilla";
  }
}

/** Human label for a loader id ("fabric" -> "Fabric", "vanilla" -> "Vanilla"). */
export function loaderLabel(loader: string): string {
  return loader === "vanilla" ? "Vanilla" : loader.charAt(0).toUpperCase() + loader.slice(1);
}

/** Loader-tinted icon-tile background class (green, fabric, purple, orange, quilt). */
export function loaderBannerColor(loader: string): string {
  switch (loader) {
    case "fabric": return "fabric";
    case "quilt": return "quilt";
    case "forge": return "orange";
    case "neoforge": return "purple";
    default: return "green";
  }
}

