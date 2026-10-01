// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/* Runnable self-check for contentVersion(). No framework — run with:
 *   npx tsx src/lib/contentVersion.selfcheck.ts
 * Exits non-zero (throws) on the first failed case. */
import { contentVersion } from "./contentVersion";

const cases: Array<[string | null, string | null, string, string | null]> = [
  // [versionNumber, filename, gameVersion, expected]
  ["0.5.8+mc1.21", "whatever.jar", "1.21", "0.5.8+mc1.21"], // stored wins verbatim
  [null, "ComplementaryShaders_v4.7.2.zip", "1.8.9", "4.7.2"],
  [null, "BSL_v8.2.08.zip", "1.8.9", "8.2.08"],
  [null, "replaymod-1.8.9-2.6.0.jar", "1.8.9", "2.6.0"], // MC version excluded
  [null, "sodium-fabric-0.5.8+mc1.21.jar", "1.21", "0.5.8"], // build tag trimmed, mc1.21 excluded
  [null, "entityculling-fabric-1.6.2.jar", "1.8.9", "1.6.2"],
  [null, "VanillaHUD.jar", "1.8.9", null], // no version token
  [null, "", "1.8.9", null],
  [null, "wavey-capes-fabric-1.4.5.jar.disabled", "1.8.9", "1.4.5"], // .disabled stripped
];

let failed = 0;
for (const [vn, fn, gv, expected] of cases) {
  const got = contentVersion(vn, fn, gv);
  if (got !== expected) {
    failed++;
    console.error(`FAIL: contentVersion(${JSON.stringify(vn)}, ${JSON.stringify(fn)}, "${gv}") = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}
if (failed > 0) {
  throw new Error(`${failed} contentVersion case(s) failed`);
}
console.log(`contentVersion: all ${cases.length} cases passed`);
