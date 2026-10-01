// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Resolve an icon URL or disk path for `<img src>`.
 *
 * Handles:
 * - Remote URLs (`http://`, `https://`) -> returned as-is
 * - Data URLs (`data:...`) -> returned as-is
 * - Tauri asset URLs (`asset://`, `https://asset.localhost`) -> returned as-is
 * - Local filesystem paths (`C:\...`, `/home/...`) -> converted via `convertFileSrc`
 * - Sentinel values (`"cube"`, `null`, `undefined`, `""`) -> returns `undefined`
 */
export function resolveAssetUrl(urlOrPath?: string | null): string | undefined {
  if (!urlOrPath) return undefined;
  // Fast path: data URLs can be multi-MB; avoid .trim() allocation on them
  if (urlOrPath.startsWith("data:")) return urlOrPath;
  const trimmed = urlOrPath.trim();
  if (!trimmed || trimmed === "cube") return undefined;

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("asset:") ||
    trimmed.startsWith("https://asset.localhost")
  ) {
    return trimmed;
  }

  // Local filesystem path — convert to Tauri asset protocol URL
  return convertFileSrc(trimmed);
}
