// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, Show, createSignal, onMount } from "solid-js";
import { getCrashReport } from "../ipc/commands";

/**
 * Crash-report viewer. Mounted once at App level and surfaced from any code
 * path that wants to display a report via `showCrashReport(path)`.
 *
 * Highlights commonly-relevant lines in the report so the user can find the
 * actual error fast — Minecraft crash reports tend to bury the real cause in
 * 200+ lines of system info.
 */

const [open, setOpen] = createSignal(false);
const [reportPath, setReportPath] = createSignal<string | null>(null);
const [reportText, setReportText] = createSignal<string>("");
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

/** Open the modal for a specific crash report file. */
export function showCrashReport(path: string) {
  setReportPath(path);
  setReportText("");
  setError(null);
  setOpen(true);
}

const HIGHLIGHT_PATTERNS = [
  /^---- Minecraft Crash Report ----/,
  /^Description:/,
  /^Caused by:/,
  /^java\.lang\./,
  /Exception/,
  /Error/,
];

const isHighlighted = (line: string): boolean =>
  HIGHLIGHT_PATTERNS.some((p) => p.test(line));

const CrashReportModal: Component = () => {
  let viewerRef: HTMLDivElement | undefined;

  onMount(() => {
    // Watch the open signal — when it flips true, fetch the report contents.
    // We can't use createEffect here because it fires before the resource
    // settles; explicit fetch on toggle is simpler.
    let lastPath: string | null = null;
    setInterval(() => {
      const p = reportPath();
      if (open() && p && p !== lastPath) {
        lastPath = p;
        setLoading(true);
        getCrashReport(p)
          .then((text) => setReportText(text))
          .catch((e) => setError(typeof e === "string" ? e : (e as Error).message))
          .finally(() => setLoading(false));
      } else if (!open()) {
        lastPath = null;
      }
    }, 100);
  });

  const close = () => {
    setOpen(false);
    setReportText("");
    setReportPath(null);
    setError(null);
  };

  // Find the first highlighted line so we can scroll to it on mount.
  const scrollToError = () => {
    if (!viewerRef) return;
    const el = viewerRef.querySelector(".crash-line.highlight");
    if (el) {
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  return (
    <Show when={open()}>
      <div class="modal-overlay" onClick={close}>
        <div
          class="modal crash-report-modal panel panel--bracketed"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-crash">CRASH REPORT</span>
              <span class="modal-title">Minecraft Error Log</span>
            </div>
          </div>
          <div class="modal-body">
            <Show when={loading()}>
              <div class="crash-empty">Loading crash report...</div>
            </Show>
            <Show when={error()}>
              <div class="crash-empty crash-error-text">
                Couldn't read crash report: {error()}
              </div>
            </Show>
            <Show when={!loading() && !error() && reportText()}>
              <div class="crash-meta">
                <span class="crash-meta-path">{reportPath()}</span>
                <button class="btn btn--subtle btn--sm crash-jump" onClick={scrollToError}>
                  Jump to error
                </button>
              </div>
              <div class="crash-viewer" ref={viewerRef}>
                {reportText()
                  .split("\n")
                  .map((line) => (
                    <div class={`crash-line ${isHighlighted(line) ? "highlight" : ""}`}>
                      {line || "\u00a0"}
                    </div>
                  ))}
              </div>
            </Show>
          </div>
          <div class="modal-footer">
            <button class="btn btn--subtle" onClick={close}>Close</button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CrashReportModal;
