// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Best-effort content version for an installed item's badge.
 *
 * Prefers the stored `versionNumber` — accurate, written at install time for
 * mods added directly from Browse (Modrinth `version_number` / CurseForge file
 * display name). Falls back to parsing the jar/zip filename for older entries,
 * manually-added jars, and modpack-bundled content that never stored one, so
 * the Installed card can still show a version.
 *
 * ponytail: filename parsing is a heuristic, not a parser. It strips the
 * extension, collects version-like tokens, drops the instance's MC version
 * (that token is the game version, not the content version), and takes the
 * trailing remaining token. Good enough for a badge; the stored value is
 * authoritative whenever present. Ceiling: filenames with no version token, or
 * with an ambiguous extra version-like token, may show nothing or the wrong
 * token — re-installing from Browse stores the exact version and supersedes it.
 */
export function contentVersion(
  versionNumber: string | null | undefined,
  filename: string | null | undefined,
  gameVersion: string,
): string | null {
  if (versionNumber) return String(versionNumber);
  const raw = filename ?? "";
  if (!raw) return null;

  // Drop a trailing ".disabled", then the file extension.
  const base = raw.replace(/\.disabled$/i, "").replace(/\.(jar|zip|litemod)$/i, "");

  // Version-like tokens: an optional leading "v", dotted digits, and an
  // optional "+build" suffix (e.g. "v4.7.2", "0.5.8+mc1.21", "8.2.08"). A
  // hyphen separates tokens, so "name-1.8.9-2.6.0" yields two: "1.8.9" and
  // "2.6.0" — letting the MC-version filter below drop the game version.
  const tokens = base.match(/v?\d+(?:\.\d+)+(?:\+[A-Za-z0-9.+_-]+)?/g) || [];
  if (tokens.length === 0) return null;

  // Normalize: strip a leading "v" and any "+build" tag (e.g. "+mc1.21").
  const norm = tokens.map((t) => t.replace(/^v/i, "").replace(/\+.*$/, ""));

  // Exclude the instance's MC version — that token identifies the game
  // version, not the content's own release.
  const mcCompact = gameVersion.replace(/\./g, "");
  const candidates = norm.filter(
    (t) => t !== gameVersion && t !== `mc${gameVersion}` && t !== mcCompact,
  );

  // The content version typically trails the file name; take the last token.
  const pick = (candidates.length > 0 ? candidates : norm).pop();
  return pick || null;
}
