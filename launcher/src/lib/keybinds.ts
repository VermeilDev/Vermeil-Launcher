// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Keybind registry + matching utilities.
 *
 * Single source of truth for every customizable keyboard shortcut. Adding
 * a new keybind = adding an entry to `KEYBINDS` here. The Settings →
 * Keybinds tab renders rows from this list, App.tsx looks up the active
 * binding for each action when handling keydown events.
 *
 * Format: `"Ctrl+Shift+P"` — modifiers in fixed order (Ctrl, Alt, Shift,
 * Meta), `+`-separated, key last. Keys use whatever `KeyboardEvent.key`
 * produced (e.g. ",", "p", "F5", "ArrowUp"). Display label is generated
 * from this string.
 */

export interface KeybindAction {
  /** Stable identifier persisted in settings. Never change. */
  id: string;
  /** Human-readable label for the Keybinds settings tab. */
  label: string;
  /** Optional sub-text describing what the shortcut does. */
  description?: string;
  /** Default binding (used when settings.keybinds[id] is missing/empty). */
  default: string;
}

/**
 * Every customizable keybind. Add new entries here; the Settings tab
 * picks them up automatically.
 */
export const KEYBINDS: KeybindAction[] = [
  {
    id: "create_instance",
    label: "New instance",
    description: "Open the create-instance flow",
    default: "Ctrl+N",
  },
  {
    id: "open_settings",
    label: "Open settings",
    description: "Jump to the Settings screen",
    default: "Ctrl+,",
  },
  {
    id: "toggle_pin_selector",
    label: "Toggle pin selector",
    description: "Open the floating pin carousel for quick instance switching",
    default: "Ctrl+P",
  },
  {
    id: "toggle_pagination_scroll",
    label: "Toggle pagination scroll mode",
    description: "Route scroll wheel anywhere on screen to page navigation",
    default: "Z",
  },
];

/** Resolve a keybind: user override (if any) → action default. */
export function resolveBinding(
  actionId: string,
  userBindings: Record<string, string> | undefined,
): string {
  const override = userBindings?.[actionId]?.trim();
  if (override) return override;
  const action = KEYBINDS.find((k) => k.id === actionId);
  return action?.default ?? "";
}

/** Parse a binding string into normalized parts. */
export interface ParsedKeybind {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Lowercase, without modifiers. e.g. "p", ",", "f5", "arrowup", "mouse4". */
  key: string;
}

/**
 * Map mouse button number to a keybind identifier.
 * - button 1 = Middle Click -> "Mouse3"
 * - button 3 = Side button 1 (Browser Back) -> "Mouse4"
 * - button 4 = Side button 2 (Browser Forward) -> "Mouse5"
 * - button >= 5 -> `Mouse${button + 1}`
 * (button 0 [left] and button 2 [right] are excluded from hotkey binding)
 */
export function mouseButtonToKey(button: number): string | null {
  switch (button) {
    case 1:
      return "Mouse3";
    case 3:
      return "Mouse4";
    case 4:
      return "Mouse5";
    default:
      if (button >= 5) return `Mouse${button + 1}`;
      return null;
  }
}

export function parseKeybind(binding: string): ParsedKeybind | null {
  if (!binding) return null;
  const parts = binding.split("+").map((p) => p.trim());
  if (parts.length === 0) return null;
  const out: ParsedKeybind = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") out.ctrl = true;
    else if (lower === "alt" || lower === "option") out.alt = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "meta" || lower === "cmd" || lower === "win") out.meta = true;
    else out.key = lower.replace(/\s+/g, "");
  }
  if (!out.key) return null;
  return out;
}

/** Does the given KeyboardEvent or MouseEvent match the binding string? */
export function matchesKeybind(e: KeyboardEvent | MouseEvent, binding: string): boolean {
  const parsed = parseKeybind(binding);
  if (!parsed) return false;
  // Modifier flags must match exactly so `Ctrl+P` doesn't fire on `Ctrl+Shift+P`.
  if (e.ctrlKey !== parsed.ctrl) return false;
  if (e.altKey !== parsed.alt) return false;
  if (e.shiftKey !== parsed.shift) return false;
  if (e.metaKey !== parsed.meta) return false;

  if ("key" in e) {
    const keyMatch = e.key.toLowerCase() === parsed.key;
    const code = (e as KeyboardEvent).code;
    const codeMatch =
      typeof code === "string" && code.toLowerCase() === `key${parsed.key}`;
    return keyMatch || codeMatch;
  }
  if ("button" in e) {
    const mouseKey = mouseButtonToKey(e.button);
    return mouseKey ? mouseKey.toLowerCase() === parsed.key : false;
  }
  return false;
}

/**
 * Format a KeyboardEvent into a binding string usable for storage.
 * Returns null for "modifier-only" presses (e.g. just Shift) so callers
 * can keep listening until a real key arrives.
 */
export function formatBindingFromEvent(e: KeyboardEvent): string | null {
  // Modifier keys alone don't constitute a complete binding.
  const k = e.key;
  if (
    k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" ||
    k === "OS" || k === "AltGraph"
  ) {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  // Normalize the printable key. KeyboardEvent.key for printable chars is
  // already the produced character ("a", ",", "?"). Function and arrow
  // keys come through as "F1", "ArrowUp", etc. — we keep those as-is.
  let key: string;
  if (k.length === 1) {
    key = k.toUpperCase();
  } else {
    key = k; // "F5", "ArrowUp", "Tab", etc.
  }
  parts.push(key);
  return parts.join("+");
}

/**
 * Format a MouseEvent into a binding string usable for storage.
 * Returns null for left/right buttons.
 */
export function formatBindingFromMouseEvent(e: MouseEvent): string | null {
  const mouseKey = mouseButtonToKey(e.button);
  if (!mouseKey) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(mouseKey);
  return parts.join("+");
}

/** Pretty version for display. e.g. "Ctrl+P" stays the same; "Ctrl+ArrowUp" → "Ctrl+↑", "Mouse4" → "Mouse 4". */
export function formatBindingForDisplay(binding: string): string {
  if (!binding) return "—";
  return binding
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace(" ", "Space")
    .replace("Mouse3", "Mouse 3")
    .replace("Mouse4", "Mouse 4")
    .replace("Mouse5", "Mouse 5")
    .replace(/Mouse(\d+)/g, "Mouse $1");
}
