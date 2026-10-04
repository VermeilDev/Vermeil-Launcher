// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, onCleanup, onMount } from "solid-js";
import { formatBindingForDisplay, formatBindingFromEvent, formatBindingFromMouseEvent } from "../lib/keybinds";
import { IconRotateCcw } from "./Icons";

/**
 * Inline keybind editor — shows the current binding as a "key cap"
 * pill. Click to enter capture mode; the next non-modifier key combo
 * or mouse side button pressed becomes the new binding. Escape cancels capture.
 *
 * Used by Settings → Keybinds tab. Reset button restores the action's
 * default by passing an empty string to `onChange`.
 */
const KeybindCapture: Component<{
  binding: string;
  defaultBinding: string;
  onChange: (newBinding: string) => void;
}> = (props) => {
  const [capturing, setCapturing] = createSignal(false);
  let captureRef: HTMLButtonElement | undefined;

  const startCapture = () => {
    setCapturing(true);
    // Defer focus so the click handler that opened capture doesn't immediately
    // count as the captured key.
    setTimeout(() => captureRef?.focus(), 0);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!capturing()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    const formatted = formatBindingFromEvent(e);
    if (!formatted) return; // modifier-only, keep listening
    props.onChange(formatted);
    setCapturing(false);
  };

  const handleMouseDown = (e: MouseEvent) => {
    if (!capturing()) return;

    // Check if it's a bindable mouse button (Mouse 4, Mouse 5, Mouse 3, etc.)
    const formatted = formatBindingFromMouseEvent(e);
    if (formatted) {
      e.preventDefault();
      e.stopPropagation();
      props.onChange(formatted);
      setCapturing(false);
      return;
    }

    // Left click outside captureRef cancels capture.
    if (e.button === 0) {
      if (e.target !== captureRef && !captureRef?.contains(e.target as Node)) {
        setCapturing(false);
      }
      return;
    }

    // Right click cancels capture.
    if (e.button === 2) {
      setCapturing(false);
    }
  };

  const handleReset = (e: MouseEvent) => {
    e.stopPropagation();
    // Pass empty string — App.tsx + the resolveBinding helper will fall
    // back to the action's default. Storing the default literal would
    // freeze it if we ever change defaults later.
    props.onChange("");
  };

  // Capture mode has document-level listeners in capture phase so the user can
  // press anything (Ctrl+T overrides browser tab open, Mouse4/5 side buttons, etc.).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => handleKeyDown(e);
    const onMouse = (e: MouseEvent) => handleMouseDown(e);
    const onAux = (e: MouseEvent) => {
      // Prevent browser back/forward navigation when side buttons are clicked while capturing
      if (capturing() && (e.button === 3 || e.button === 4)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onContext = (e: MouseEvent) => {
      if (capturing()) {
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onMouse, true);
    document.addEventListener("auxclick", onAux, true);
    document.addEventListener("contextmenu", onContext, true);

    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onMouse, true);
      document.removeEventListener("auxclick", onAux, true);
      document.removeEventListener("contextmenu", onContext, true);
    });
  });

  const isDefault = () => !props.binding || props.binding === props.defaultBinding;

  return (
    <div class="keybind-capture-row">
      <button
        ref={captureRef}
        type="button"
        class={`keybind-capture tip-below ${capturing() ? "capturing" : ""}`}
        onClick={startCapture}
        data-tip={capturing() ? "Escape to cancel" : "Click to bind"}
        aria-label={capturing() ? "Escape to cancel" : "Click to bind"}
      >
        {capturing() ? (
          <span class="keybind-capturing-text">Press keys or mouse button…</span>
        ) : (
          <span class="keybind-keys">{formatBindingForDisplay(props.binding || props.defaultBinding)}</span>
        )}
      </button>
      <button
        type="button"
        class="keybind-reset tip-right"
        onClick={handleReset}
        disabled={isDefault()}
        data-tip="Reset default"
        aria-label="Reset default"
      >
        <IconRotateCcw />
      </button>
    </div>
  );
};

export default KeybindCapture;
