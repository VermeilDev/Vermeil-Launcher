// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createSignal } from "solid-js";

export interface DependencyIssue {
  parent_title: string;
  dep_title: string;
  dep_project_id: string;
  required_game_versions: string[];
  required_loaders: string[];
  instance_game_version: string;
  instance_loader: string;
  /**
   * "missing"          — the source has no versions of this project at all
   * "incompatible"     — versions exist but none match the loader / MC version
   * "failed"           — download or resolution error during install
   * "version_conflict" — a specific version is required but a different one is
   *                      installed, or an installed version is held by another
   *                      mod. `reason` names both versions; the required/
   *                      loaders arrays are empty for this kind.
   * "conflict"         — the mod declares it cannot run alongside an installed
   *                      one (Modrinth `incompatible` dep / CurseForge
   *                      relationType 5)
   */
  kind: string;
  reason: string;
}

/**
 * Module-level signal so any code path (single install, bulk install, etc.)
 * can push issues into a shared queue and have them surfaced together.
 *
 * The modal is mounted once at App level. Calling `reportDependencyIssues`
 * appends to the queue and ensures the modal is visible.
 */
const [issues, setIssues] = createSignal<DependencyIssue[]>([]);
const [open, setOpen] = createSignal(false);
/** Title of the mod whose install just completed (for the modal heading). */
const [installedModTitle, setInstalledModTitle] = createSignal("");

/** Raise the issues modal for a freshly-finished install. */
export function reportDependencyIssues(modTitle: string, batch: DependencyIssue[]) {
  if (!batch || batch.length === 0) return;
  setInstalledModTitle(modTitle);
  setIssues((prev) => [...prev, ...batch]);
  setOpen(true);
}

const kindLabel = (k: string): string => {
  switch (k) {
    case "missing":
      return "Not available";
    case "incompatible":
      return "May not work";
    case "failed":
      return "Install failed";
    case "version_conflict":
      return "Version mismatch";
    case "conflict":
      return "Conflict";
    default:
      return k;
  }
};

const kindClass = (k: string): string => {
  switch (k) {
    // Hard failures: nothing was installed, or two mods can't coexist.
    case "missing":
    case "failed":
    case "conflict":
      return "dep-issue-error";
    // Installed, but the combination may misbehave.
    case "incompatible":
    case "version_conflict":
      return "dep-issue-warn";
    default:
      return "";
  }
};

const DependencyIssuesModal: Component = () => {
  const close = () => {
    setOpen(false);
    setIssues([]);
    setInstalledModTitle("");
  };

  return (
    <Show when={open()}>
      <div class="modal-overlay" onClick={close}>
        <div
          class="modal dep-issues-modal panel panel--bracketed"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-storage">DEPENDENCY CHECK</span>
              <span class="modal-title">Dependency Resolution Notice</span>
            </div>
          </div>
          <div class="modal-body">
            <div class="dep-issue-summary">
              <Show
                when={installedModTitle()}
                fallback={<span>Some dependencies could not be installed.</span>}
              >
                <span>
                  <strong>{installedModTitle()}</strong> installed, but{" "}
                  {issues().length} dependenc{issues().length === 1 ? "y" : "ies"} had problems:
                </span>
              </Show>
            </div>
            <div class="dep-issue-list">
              <For each={issues()}>
                {(issue) => (
                  <div class={`dep-issue-card ${kindClass(issue.kind)}`}>
                    <div class="dep-issue-card-head">
                      <span class="dep-issue-title">{issue.dep_title}</span>
                      <span class={`dep-issue-tag ${kindClass(issue.kind)}`}>
                        {kindLabel(issue.kind)}
                      </span>
                    </div>
                    <div class="dep-issue-meta">
                      Required by <strong>{issue.parent_title}</strong>
                    </div>
                    <div class="dep-issue-reason">{issue.reason}</div>
                    <Show when={issue.required_game_versions.length > 0 || issue.required_loaders.length > 0}>
                      <div class="dep-issue-spec">
                        <Show when={issue.required_loaders.length > 0}>
                          <div>
                            <span class="dep-issue-spec-label">Loaders:</span>{" "}
                            <span>{issue.required_loaders.join(", ")}</span>
                            <span class="dep-issue-spec-instance"> (instance: {issue.instance_loader})</span>
                          </div>
                        </Show>
                        <Show when={issue.required_game_versions.length > 0}>
                          <div>
                            <span class="dep-issue-spec-label">MC versions:</span>{" "}
                            <span>{issue.required_game_versions.slice(0, 8).join(", ")}{issue.required_game_versions.length > 8 ? ", ..." : ""}</span>
                            <span class="dep-issue-spec-instance"> (instance: {issue.instance_game_version})</span>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn--subtle" onClick={close}>Got it</button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default DependencyIssuesModal;
