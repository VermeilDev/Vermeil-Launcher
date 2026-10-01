// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createEffect, createSignal, Show } from "solid-js";
import { validateJavaPath, setJavaPath } from "../ipc/commands";
import { showToast } from "../App";

/**
 * Editable path field for a single Java major slot. Used by both
 * `screens/Settings.tsx` (Resources → Java) and `modals/OnboardingWizard.tsx`
 * (step 3) so the validation flow stays consistent across both surfaces.
 *
 * Behavior:
 *   - Renders the resolved path (user-set > detected) in a monospace input.
 *   - On blur, validates the path via `validateJavaPath`. On success it
 *     persists via `setJavaPath`, then calls `onCommit(path)` so the parent
 *     can update its local cache. On failure (invalid file or wrong major),
 *     it shows a warning toast and reverts the displayed value to whatever
 *     was previously committed.
 *   - Empty input is treated as "clear the override" — falls back to
 *     auto-detection / auto-install at next launch.
 *   - Enter commits, Escape reverts.
 *
 * The component is **uncontrolled** in the sense that it tracks an internal
 * draft signal so the user can type freely. The `value` prop only resets the
 * draft when it changes from the outside (e.g. after Detect / Install /
 * Browse picks a new path).
 */
interface Props {
  /** Major version this slot represents (8, 17, 21, 25). */
  major: number;
  /** Currently committed path. Empty string when nothing's configured. */
  value: string;
  /** Placeholder shown when `value` is empty. */
  placeholder: string;
  /** Called when a new path is successfully validated and persisted. */
  onCommit: (path: string) => void;
  /** Disables the input while one of the slot's other actions is busy. */
  disabled?: boolean;
}

const JavaPathInput: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [validating, setValidating] = createSignal(false);

  // Reset the draft when the parent changes the committed value (e.g. after
  // a Detect / Browse / Install action elsewhere on the slot).
  createEffect(() => setDraft(props.value));

  const commit = async () => {
    const next = draft().trim();

    // Empty input → clear the override. Auto-detection / auto-install will
    // handle this major at launch time.
    if (!next) {
      try {
        await setJavaPath(props.major, null);
        props.onCommit("");
      } catch (e) {
        showToast({ title: "Failed to clear path", message: String(e), type: "error" });
        setDraft(props.value);
      }
      return;
    }

    // Same as the committed value? No-op.
    if (next === props.value) return;

    setValidating(true);
    try {
      const install = await validateJavaPath(next);
      if (install.major !== props.major) {
        showToast({
          title: `That's Java ${install.major}, not ${props.major}`,
          message: "Pick a JRE matching the requested major version.",
          type: "warning",
        });
        setDraft(props.value);
        return;
      }
      await setJavaPath(props.major, install.path);
      props.onCommit(install.path);
    } catch (e) {
      showToast({
        title: `Java ${props.major} path rejected`,
        message: typeof e === "string" ? e : String(e),
        type: "error",
      });
      setDraft(props.value);
    } finally {
      setValidating(false);
    }
  };

  return (
    <div class="java-slot-input-wrap">
      <input
        class="java-slot-input"
        type="text"
        spellcheck={false}
        disabled={props.disabled || validating()}
        value={draft()}
        placeholder={props.placeholder}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(props.value);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <Show when={validating()}>
        <span class="java-slot-input-hint">Validating...</span>
      </Show>
    </div>
  );
};

export default JavaPathInput;
