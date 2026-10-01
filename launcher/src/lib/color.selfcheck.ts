// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/* Runnable self-check for the colour picker's hex parse/format layer.
 * No framework — run with:
 *   npx tsx src/lib/color.selfcheck.ts
 * Exits non-zero (throws) on the first failed case. */
import { parseHex, toHex, normalizeHex } from "./color";

let failed = 0;
const check = (label: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${label}`);
  }
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(`${label} → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want));

// ─── parseHex: accepted forms ───

eq('parseHex("#2b2740")', parseHex("#2b2740"), { r: 0x2b, g: 0x27, b: 0x40 });
eq('parseHex("2b2740") — no hash', parseHex("2b2740"), { r: 0x2b, g: 0x27, b: 0x40 });
eq('parseHex("#2B2740") — upper case', parseHex("#2B2740"), { r: 0x2b, g: 0x27, b: 0x40 });
eq('parseHex("  #2b2740  ") — padded', parseHex("  #2b2740  "), { r: 0x2b, g: 0x27, b: 0x40 });
eq('parseHex("#abc") — shorthand expands', parseHex("#abc"), { r: 0xaa, g: 0xbb, b: 0xcc });
eq('parseHex("#000")', parseHex("#000"), { r: 0, g: 0, b: 0 });
eq('parseHex("#ffffff")', parseHex("#ffffff"), { r: 255, g: 255, b: 255 });

// ─── parseHex: rejected forms ───
// Partial strings matter: the hex field parses on every keystroke, so anything
// incomplete must return null and leave the live colour alone.
for (const bad of [
  "",
  "#",
  "#1",
  "#12",
  "#1234",
  "#12345",
  "#1234567",
  "#gggggg",
  "#12345g",
  "rgb(1,2,3)",
  "red",
  "0x2b2740",
  "#2b 27 40",
]) {
  check(`parseHex(${JSON.stringify(bad)}) → null`, parseHex(bad) === null);
}

// ─── toHex ───

eq("toHex round-trips a parsed colour", toHex(parseHex("#2b2740")!), "#2b2740");
eq("toHex zero-pads", toHex({ r: 1, g: 2, b: 3 }), "#010203");
eq("toHex lower-cases", toHex({ r: 0xab, g: 0xcd, b: 0xef }), "#abcdef");
eq("toHex clamps above 255", toHex({ r: 999, g: 300, b: 256 }), "#ffffff");
eq("toHex clamps below 0", toHex({ r: -5, g: -1, b: 0 }), "#000000");
eq("toHex rounds fractional channels", toHex({ r: 10.4, g: 10.6, b: 0 }), "#0a0b00");
// Non-finite must not leak "NaN" into a CSS colour string.
eq("toHex(NaN) → 00", toHex({ r: NaN, g: 0, b: 0 }), "#000000");
eq("toHex(Infinity) → 00", toHex({ r: Infinity, g: 0, b: 0 }), "#000000");

// Every shorthand round-trips to its expanded form.
for (const s of ["#000", "#fff", "#abc", "#123"]) {
  const expanded = toHex(parseHex(s)!);
  eq(`shorthand ${s} expands and re-parses`, toHex(parseHex(expanded)!), expanded);
}

// ─── normalizeHex (the untrusted-transform boundary) ───

const FB = "#2b2740";
eq("normalizeHex passes a good value through", normalizeHex("#112233", FB), "#112233");
eq("normalizeHex canonicalizes case + shorthand", normalizeHex("#ABC", FB), "#aabbcc");
eq("normalizeHex adds the missing hash", normalizeHex("112233", FB), "#112233");
eq("normalizeHex(undefined) → fallback", normalizeHex(undefined, FB), FB);
eq("normalizeHex(null) → fallback", normalizeHex(null, FB), FB);
eq("normalizeHex('') → fallback", normalizeHex("", FB), FB);
eq("normalizeHex(garbage) → fallback", normalizeHex("not-a-colour", FB), FB);
// A named CSS colour is valid to canvas but not to our picker; the fallback is
// the safe answer since the sliders can't represent it.
eq("normalizeHex('red') → fallback", normalizeHex("red", FB), FB);
eq("normalizeHex is idempotent", normalizeHex(normalizeHex("#ABC", FB), FB), "#aabbcc");

if (failed > 0) {
  throw new Error(`${failed} colour case(s) failed`);
}
console.log("color: all cases passed");
