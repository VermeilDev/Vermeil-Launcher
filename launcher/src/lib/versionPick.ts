// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentVersion } from "../ipc/commands";

/**
 * Which versions the picker's list should show.
 *
 * Incompatible entries are hidden by default — the common case is "give me
 * something that works" — but remain reachable via `showAll` because a user may
 * deliberately want an off-version build. The query matches the display name or
 * the file name, since CurseForge's display name is often less recognizable than
 * the jar it produces.
 */
export function filterVersions(
  list: ContentVersion[],
  opts: { showAll: boolean; query: string },
): ContentVersion[] {
  const q = opts.query.trim().toLowerCase();
  return list.filter((v) => {
    if (!opts.showAll && !v.compatible) return false;
    if (!q) return true;
    return v.name.toLowerCase().includes(q) || v.filename.toLowerCase().includes(q);
  });
}

/**
 * The entry to preselect when the picker opens.
 *
 * Prefers the backend's `recommended` flag so the dropdown agrees with what the
 * plain Install button would do — the two disagreeing is exactly the confusion
 * the picker exists to remove. Falls back to the first compatible entry, then to
 * the first entry at all, so a project with nothing compatible still shows
 * something rather than an empty control.
 */
export function defaultSelection(list: ContentVersion[]): ContentVersion | undefined {
  return list.find((v) => v.recommended) ?? list.find((v) => v.compatible) ?? list[0];
}

/**
 * Resolve the effective selection: the user's explicit pick when it's still in
 * the list, otherwise the default. Guarding on presence matters because the list
 * can be refetched for a different loader or game version, at which point a
 * previously chosen id may no longer exist.
 */
export function resolveSelection(
  list: ContentVersion[],
  selectedId: string | null,
): ContentVersion | undefined {
  if (selectedId) {
    const found = list.find((v) => v.id === selectedId);
    if (found) return found;
  }
  return defaultSelection(list);
}
