// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/* Runnable self-check for the version-picker list logic. No framework — run with:
 *   npx tsx src/lib/versionPick.selfcheck.ts
 * Throws (non-zero exit) listing every failed case. */
import type { ContentVersion } from "../ipc/commands";
import { defaultSelection, filterVersions, resolveSelection } from "./versionPick";

const v = (
  id: string,
  opts: Partial<ContentVersion> = {},
): ContentVersion => ({
  id,
  name: id,
  channel: "release",
  game_versions: [],
  loaders: [],
  filename: `${id}.jar`,
  size: 0,
  date_published: null,
  compatible: true,
  downloadable: true,
  recommended: false,
  ...opts,
});

const failures: string[] = [];
const check = (label: string, got: unknown, expected: unknown) => {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) failures.push(`FAIL ${label}: got ${g}, expected ${e}`);
};

// ── filterVersions ────────────────────────────────────────────────────────
{
  const list = [v("a"), v("b", { compatible: false }), v("c")];

  check(
    "incompatible hidden by default",
    filterVersions(list, { showAll: false, query: "" }).map((x) => x.id),
    ["a", "c"],
  );
  check(
    "showAll reveals incompatible",
    filterVersions(list, { showAll: true, query: "" }).map((x) => x.id),
    ["a", "b", "c"],
  );
  // The whole point of showAll is reaching an off-version build deliberately.
  check(
    "query can still only reach an incompatible entry via showAll",
    filterVersions(list, { showAll: false, query: "b" }).map((x) => x.id),
    [],
  );
}
{
  const list = [
    v("1", { name: "Sodium 0.5.8", filename: "sodium-fabric-0.5.8.jar" }),
    v("2", { name: "Sodium 0.6.0", filename: "sodium-fabric-0.6.0.jar" }),
  ];
  check(
    "query matches the display name",
    filterVersions(list, { showAll: true, query: "0.6" }).map((x) => x.id),
    ["2"],
  );
  // CurseForge display names are often less recognizable than the jar name.
  check(
    "query matches the file name",
    filterVersions(list, { showAll: true, query: "fabric-0.5.8" }).map((x) => x.id),
    ["1"],
  );
  check(
    "query is case-insensitive",
    filterVersions(list, { showAll: true, query: "SODIUM" }).map((x) => x.id),
    ["1", "2"],
  );
  check(
    "whitespace-only query is not a filter",
    filterVersions(list, { showAll: true, query: "   " }).map((x) => x.id),
    ["1", "2"],
  );
}

// ── defaultSelection ──────────────────────────────────────────────────────
// Must agree with the plain Install button, which installs `recommended`.
check(
  "recommended wins even when listed after a compatible entry",
  defaultSelection([v("a"), v("b", { recommended: true })])?.id,
  "b",
);
check(
  "falls back to the first compatible entry",
  defaultSelection([v("a", { compatible: false }), v("b")])?.id,
  "b",
);
check(
  "falls back to the first entry when nothing is compatible",
  defaultSelection([v("a", { compatible: false }), v("b", { compatible: false })])?.id,
  "a",
);
check("empty list selects nothing", defaultSelection([])?.id, undefined);

// ── resolveSelection ──────────────────────────────────────────────────────
{
  const list = [v("a"), v("b", { recommended: true })];
  check("explicit pick is honored", resolveSelection(list, "a")?.id, "a");
  check("no pick uses the default", resolveSelection(list, null)?.id, "b");
  // A refetch for a different loader / game version can drop the chosen id.
  check("stale pick falls back to the default", resolveSelection(list, "gone")?.id, "b");
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  throw new Error(`${failures.length} versionPick case(s) failed`);
}
console.log("versionPick: all cases passed");
