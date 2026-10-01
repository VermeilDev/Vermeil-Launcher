// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onCleanup, Show, For } from "solid-js";
import { parseHex, toHex, normalizeHex, Rgb } from "../lib/color";

/**
 * In-app colour picker: a swatch button that opens a popover with a preset
 * palette, one range input per RGB channel, and a hex field.
 *
 * Used in place of `<input type="color">`. That element's popup works, but it
 * contains an eyedropper button that WebView2 doesn't drive — it's host browser
 * UI, so clicking it does nothing and there's no way to remove it from a native
 * control's popup. Rendering our own means no dead affordance, and the same
 * picker on WebView2 and WebKitGTK instead of whatever each host supplies.
 *
 * Two things make it quick for the common case of "give me a decent solid
 * colour": the presets, which are one click; and the channel gradients, which
 * show what moving each slider will do to the current colour rather than being
 * abstract 0–255 bars. Fine-tuning falls back to the sliders, exact values to
 * the hex field.
 */

interface Props {
  /** Current colour, `#rrggbb`. Anything invalid falls back to black. */
  value: string;
  /** Fired on every change with a canonical `#rrggbb` — drives live preview. */
  onInput: (hex: string) => void;
  /** Accessible name for the trigger button. */
  label: string;
}

const CHANNELS: Array<{ key: keyof Rgb; name: string }> = [
  { key: "r", name: "Red" },
  { key: "g", name: "Green" },
  { key: "b", name: "Blue" },
];

/**
 * Preset palette. Two rows of eight: a neutral ramp, then a hue wheel at a
 * shared mid saturation so no swatch fights the others.
 *
 * Deliberately muted rather than pure primaries — these fill an entire cape, and
 * saturated `#ff0000` reads as a solid error state rather than a garment. The
 * first colour is the app accent, so the default suggestion is on-brand.
 */
const PRESETS = [
  "#8b5cf6", "#2b2740", "#15141a", "#3d3a47", "#6b6577", "#a8a3b5", "#d9d5e0", "#f2f0f5",
  "#c0453f", "#c97b3c", "#c9a63c", "#5f9e4a", "#3f9e8c", "#3f7ac9", "#7b4fc9", "#b8478f",
];

const ColorPicker: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  // What the hex field currently shows. Kept separate from `props.value` so a
  // half-typed value ("#2b2") isn't rewritten under the caret on each keystroke.
  const [draft, setDraft] = createSignal<string | null>(null);

  let triggerEl: HTMLButtonElement | undefined;
  let panelEl: HTMLDivElement | undefined;

  const hex = () => normalizeHex(props.value, "#000000");
  const rgb = (): Rgb => parseHex(hex()) ?? { r: 0, g: 0, b: 0 };

  const setChannel = (key: keyof Rgb, v: number) => {
    props.onInput(toHex({ ...rgb(), [key]: v }));
  };

  /** Gradient across a channel's full range, holding the other two steady, so
   *  the track previews the outcome instead of being an abstract 0–255 bar. */
  const trackGradient = (key: keyof Rgb) => {
    const from = toHex({ ...rgb(), [key]: 0 });
    const to = toHex({ ...rgb(), [key]: 255 });
    return `linear-gradient(to right, ${from}, ${to})`;
  };

  const commitHex = (raw: string) => {
    setDraft(raw);
    const parsed = parseHex(raw);
    if (parsed) props.onInput(toHex(parsed));
  };

  const choosePreset = (p: string) => {
    props.onInput(p);
    setDraft(null); // resync the hex field to the chosen preset
  };

  // Close on outside mousedown / Escape — same convention as the app's other
  // popovers. Escape also returns focus to the trigger so keyboard users aren't
  // dropped at the top of the document.
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelEl?.contains(t) || triggerEl?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerEl?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="color-picker">
      <button
        ref={triggerEl}
        type="button"
        class="color-swatch"
        style={`background:${hex()}`}
        aria-label={`${props.label} — ${hex()}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => {
          setDraft(null); // re-sync the field to the live colour on each open
          setOpen(!open());
        }}
      />

      <Show when={open()}>
        <div ref={panelEl} class="color-pop" role="dialog" aria-label={props.label}>
          <div class="color-presets">
            <For each={PRESETS}>
              {(p) => (
                <button
                  type="button"
                  class="color-preset tip-below"
                  classList={{ selected: p === hex() }}
                  style={`background:${p}`}
                  data-tip={p}
                  aria-label={p}
                  aria-pressed={p === hex()}
                  onClick={() => choosePreset(p)}
                />
              )}
            </For>
          </div>

          <For each={CHANNELS}>
            {(ch) => (
              <label class="color-chan">
                <span class="color-chan-name">{ch.name}</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  step="1"
                  value={rgb()[ch.key]}
                  style={`background:${trackGradient(ch.key)}`}
                  aria-label={ch.name}
                  onInput={(e) => setChannel(ch.key, parseInt(e.currentTarget.value, 10))}
                />
                <span class="color-chan-value">{rgb()[ch.key]}</span>
              </label>
            )}
          </For>

          <label class="color-hex">
            <span class="color-chan-name">Hex</span>
            <input
              class="field-control field-control--text"
              value={draft() ?? hex()}
              spellcheck={false}
              maxLength={7}
              aria-label="Hex colour"
              onInput={(e) => commitHex(e.currentTarget.value)}
              onBlur={() => setDraft(null)}
            />
          </label>
        </div>
      </Show>
    </div>
  );
};

export default ColorPicker;
