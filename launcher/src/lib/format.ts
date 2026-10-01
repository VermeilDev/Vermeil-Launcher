// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/** Compact download/follower counts: 1.2M, 4.5k, 812. */
export function formatDownloads(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

/** File sizes in decimal units. Callers that want "" for an unknown size check first. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + " KB";
  return bytes + " B";
}

/**
 * A project's supported MC versions as a single range, e.g. `1.8.9–1.21.4`.
 *
 * The list arrives unsorted or string-sorted (CurseForge), so it's sorted
 * numerically — lexical order would put "1.10" before "1.9.4" and render the
 * range backwards. Prereleases and snapshots are dropped when any plain release
 * exists, since they'd widen the range without telling the reader anything.
 */
export function formatVersionRange(versions: string[] | undefined): string {
  if (!versions || versions.length === 0) return "";
  const releases = versions.filter((v) => /^\d+(\.\d+)*$/.test(v));
  const list = (releases.length > 0 ? releases : versions).slice();
  const cmp = (a: string, b: string): number => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  if (releases.length > 0) list.sort(cmp);
  if (list.length === 1) return list[0];
  return `${list[0]}–${list[list.length - 1]}`;
}
