// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hex ↔ RGB helpers for the app's own colour picker.
 *
 * ## Why we render our own picker
 *
 * `<input type="color">` itself works — WebView2 opens Chromium's colour popup
 * fine. The problem is what's *inside* that popup: an eyedropper button which is
 * host browser UI that WebView2 doesn't drive, so it silently does nothing, and
 * a native control gives no way to remove it. A dead button in a shipped UI is
 * worse than a smaller feature set, so {@link ../components/ColorPicker} renders
 * the picker from ordinary DOM — presets, RGB sliders, hex field — which also
 * means Windows and Linux get the same control instead of whatever popup each
 * host happens to supply.
 *
 * (The `EyeDropper` JS API is not a way out: WebView2 defines the constructor,
 * so feature detection passes, but the promise `open()` returns never settles.
 * A native screen pick was built and worked, then dropped as more code than the
 * feature was worth — history is in the research note.)
 *
 * Both directions treat their input as untrusted: a hex string arrives from the
 * user typing into the field, from a preset, or from a stored cape transform,
 * which the backend keeps as an opaque JSON blob it never validates.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Clamp to a valid 0–255 channel. Non-finite input collapses to 0 rather than
 *  producing "NaN" in a hex string. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(255, Math.max(0, Math.round(n)));
}

/**
 * Parse `#rgb` or `#rrggbb` (leading `#` optional, any case) into channels.
 *
 * Returns null for anything else — including the partial strings a user types
 * mid-entry — so callers can hold the last good colour instead of painting
 * something unintended.
 */
export function parseHex(input: string): Rgb | null {
  const s = input.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (s.length === 6) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

/** Channels → `#rrggbb`, lower-case. Out-of-range channels are clamped. */
export function toHex(rgb: Rgb): string {
  return (
    "#" +
    [rgb.r, rgb.g, rgb.b]
      .map((c) => clampByte(c).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Normalize an untrusted colour string to a canonical `#rrggbb`, falling back
 *  to `fallback` when it isn't a usable hex colour. Use this on anything that
 *  came from disk before it reaches a canvas `fillStyle` (which silently keeps
 *  the previous colour when handed something invalid). */
export function normalizeHex(input: string | undefined | null, fallback: string): string {
  const rgb = input === undefined || input === null ? null : parseHex(input);
  return rgb ? toHex(rgb) : fallback;
}
