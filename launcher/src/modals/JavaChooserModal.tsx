// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createSignal } from "solid-js";
import { JavaInstall } from "../ipc/commands";
import { IconCheck } from "../components/Icons";

/**
 * Shown by Settings → Resources → Java and the Onboarding wizard when the
 * "Detect" action returns more than one matching JRE for a given major. The
 * single-match case still auto-selects (no popup), so this modal only ever
 * appears when the user genuinely has a choice to make — e.g. an Adoptium
 * Temurin alongside a Microsoft JDK alongside an Oracle JRE.
 *
 * Selection defaults to the first option, which is the highest-priority
 * source per the backend sort (`source_priority` in services/java.rs:
 * Bundled → AutoInstalled → Manual → Registry → CommonDir → EnvPath).
 */
interface Props {
  major: number;
  options: JavaInstall[];
  onPick: (install: JavaInstall) => void;
  onCancel: () => void;
}

/** Friendly label for the `source` enum — same shape Settings uses inline. */
const labelForSource = (s: JavaInstall["source"]): string => {
  switch (s) {
    case "auto_installed": return "Vermeil";
    case "bundled":        return "Bundled";
    case "env_path":       return "PATH / JAVA_HOME";
    case "common_dir":     return "Common dir";
    case "registry":       return "Registry";
    case "manual":         return "Manual";
  }
};

const JavaChooserModal: Component<Props> = (props) => {
  const [selected, setSelected] = createSignal<string>(props.options[0]?.path ?? "");

  const confirm = () => {
    const pick = props.options.find((i) => i.path === selected());
    if (pick) props.onPick(pick);
  };

  return (
    <Show when={props.options.length > 0}>
      <div class="modal-overlay" onClick={props.onCancel}>
        <div
          class="modal java-chooser-modal panel panel--bracketed"
          style="width: 520px;"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-java">JAVA RUNTIME</span>
              <span class="modal-title">Java {props.major} Installation</span>
            </div>
          </div>
          <div class="modal-body">
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.5;">
              Detected {props.options.length} installations that satisfy Java {props.major}.
              Select which runtime Vermeil should use to launch the game:
            </div>
            <div class="java-chooser-list">
              <For each={props.options}>
                {(install) => (
                  <label
                    class={`java-chooser-row ${selected() === install.path ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name={`java-chooser-${props.major}`}
                      checked={selected() === install.path}
                      onChange={() => setSelected(install.path)}
                    />
                    <div class="java-chooser-info">
                      <div class="java-chooser-version">
                        {install.full_version}
                        <span class="java-chooser-arch"> · {install.arch}</span>
                        <span class="java-chooser-source"> · {labelForSource(install.source)}</span>
                      </div>
                      <div class="java-chooser-path">{install.path}</div>
                    </div>
                  </label>
                )}
              </For>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn--subtle" onClick={props.onCancel}>Cancel</button>
            <button class="btn btn--primary" onClick={confirm}>
              <IconCheck />
              <span>Use this runtime</span>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default JavaChooserModal;
