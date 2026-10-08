// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { getCrashReport, openInstanceFolder } from "../ipc/commands";
import { analyzeCrashReport, CrashDiagnostic } from "../lib/crashDiagnostics";
import {
  setActiveScreen,
  setActiveInstanceId,
  setInitialInstanceTab,
  showToast,
  instances,
} from "../App";
import {
  IconAlertTriangle,
  IconCheck,
  IconClipboard,
  IconFolderOpen,
  IconCoffee,
  IconCpu,
  IconPuzzle,
  IconSearch,
  IconSliders,
  IconHardDrive,
  IconBolt,
  IconFileText,
} from "./Icons";

/**
 * Smart crash-report viewer and diagnosis hub. Mounted once at App level and surfaced
 * from any code path via `showCrashReport(path, fallbackLogs, instanceId)`.
 *
 * Provides 100% local, offline diagnostic pattern matching for common crash causes
 * (out of memory, Java version mismatch, missing dependencies, mod conflicts),
 * selectable text for copy/paste, and copy-to-clipboard affordances.
 */

const [open, setOpen] = createSignal(false);
const [reportPath, setReportPath] = createSignal<string | null>(null);
const [reportText, setReportText] = createSignal<string>("");
const [targetInstanceId, setTargetInstanceId] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [searchFilter, setSearchFilter] = createSignal("");

/** Open the modal for a specific crash report file or recent fallback console logs. */
export function showCrashReport(path?: string | null, fallbackLogs?: string[], instanceId?: string | null) {
  setTargetInstanceId(instanceId ?? null);
  setSearchFilter("");
  setError(null);

  if (path) {
    setReportPath(path);
    setReportText("");
    setLoading(true);
    setOpen(true);
    getCrashReport(path)
      .then((text) => setReportText(text))
      .catch((e) => {
        // If file reading fails, fallback to logs if available
        if (fallbackLogs && fallbackLogs.length > 0) {
          setReportText(fallbackLogs.join("\n"));
        } else {
          setError(typeof e === "string" ? e : (e as Error).message);
        }
      })
      .finally(() => setLoading(false));
  } else if (fallbackLogs && fallbackLogs.length > 0) {
    setReportPath(null);
    setReportText(fallbackLogs.join("\n"));
    setLoading(false);
    setOpen(true);
  } else {
    setReportPath(null);
    setReportText("");
    setError("No crash report file or console logs available for this session.");
    setLoading(false);
    setOpen(true);
  }
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

  const close = () => {
    setOpen(false);
    setReportText("");
    setReportPath(null);
    setTargetInstanceId(null);
    setError(null);
    setSearchFilter("");
  };

  const diagnostic = createMemo<CrashDiagnostic>(() => {
    const text = reportText();
    if (!text) {
      return {
        category: "UNHANDLED CRASH",
        categoryClass: "diag-danger",
        iconName: "alert",
        title: "Crash Report",
        description: "Analyzing crash details...",
        rootCauseSnippet: "No details available",
        actionType: "none",
        rootCauseLineIndex: 0,
      };
    }
    return analyzeCrashReport(text);
  });

  const allLines = createMemo(() => {
    const text = reportText();
    return text ? text.split("\n") : [];
  });

  const filteredLines = createMemo(() => {
    const q = searchFilter().trim().toLowerCase();
    const lines = allLines();
    if (!q) {
      return lines.map((text, index) => ({ text, index }));
    }
    return lines
      .map((text, index) => ({ text, index }))
      .filter((item) => item.text.toLowerCase().includes(q));
  });

  const instanceName = createMemo(() => {
    const id = targetInstanceId();
    if (!id) return undefined;
    const list = instances() ?? [];
    return list.find((i) => i.id === id)?.name;
  });

  const jumpToRootCause = () => {
    if (!viewerRef) return;
    const diag = diagnostic();
    const lineEl = viewerRef.querySelector(`#crash-line-${diag.rootCauseLineIndex}`);
    if (lineEl) {
      (lineEl as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
      (lineEl as HTMLElement).style.outline = "2px solid var(--accent)";
      setTimeout(() => {
        (lineEl as HTMLElement).style.outline = "none";
      }, 1800);
    }
  };

  const handleAction = () => {
    const diag = diagnostic();
    const instId = targetInstanceId();

    if (diag.actionType === "memory") {
      close();
      if (instId) {
        setActiveInstanceId(instId);
        setInitialInstanceTab("settings");
        setActiveScreen("mods");
      } else {
        setActiveScreen("settings");
      }
    } else if (diag.actionType === "java") {
      close();
      setActiveScreen("settings");
    } else if (diag.actionType === "mods") {
      close();
      if (instId) {
        setActiveInstanceId(instId);
        setInitialInstanceTab("content");
        setActiveScreen("mods");
      }
    }
  };

  const copyFullReport = () => {
    const text = reportText();
    if (!text) return;
    navigator.clipboard.writeText(text);
    showToast({
      title: "Report Copied",
      message: `Copied ${allLines().length} lines to clipboard.`,
      type: "success",
    });
  };

  const copySummary = () => {
    const diag = diagnostic();
    const inst = instanceName() ? ` (${instanceName()})` : "";
    const summary = [
      `**Minecraft Crash Diagnostic${inst}**`,
      `• Category: ${diag.category}`,
      `• Issue: ${diag.title}`,
      `• Root Cause: \`${diag.rootCauseSnippet}\``,
      diag.actionLabel ? `• Recommended Fix: ${diag.actionLabel}` : "",
      reportPath() ? `• Log: \`${reportPath()}\`` : "",
    ]
      .filter(Boolean)
      .join("\n");

    navigator.clipboard.writeText(summary);
    showToast({
      title: "Diagnostic Copied",
      message: "Diagnostic summary copied for Discord / GitHub sharing.",
      type: "success",
    });
  };

  const handleOpenFolder = async () => {
    const instId = targetInstanceId();
    if (instId) {
      const sub = reportPath() ? "crash-reports" : "logs";
      await openInstanceFolder(instId, sub);
    } else if (reportPath()) {
      showToast({
        title: "Report Path",
        message: reportPath()!,
        type: "info",
      });
    }
  };

  // Keyboard escape handler
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      close();
    }
  };

  createEffect(() => {
    if (open()) {
      window.addEventListener("keydown", handleKey);
      onCleanup(() => window.removeEventListener("keydown", handleKey));
    }
  });

  return (
    <Show when={open()}>
      <div class="modal-overlay" onClick={close}>
        <div
          class="modal crash-report-modal panel panel--bracketed"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-crash">CRASH REPORT</span>
              <span class="modal-title">Minecraft Error Log</span>
            </div>
            <Show when={instanceName()}>
              <span class="bento-badge">{instanceName()}</span>
            </Show>
          </div>

          {/* Modal Body */}
          <div class="modal-body" style="padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; overflow: hidden;">
            <Show when={loading()}>
              <div class="crash-empty">Loading crash report and running diagnostics...</div>
            </Show>

            <Show when={error()}>
              <div class="crash-empty crash-error-text">
                Couldn't read crash report: {error()}
              </div>
            </Show>

            <Show when={!loading() && !error() && reportText()}>
              {/* Smart Diagnostic Bento Card */}
              <div class={`crash-diag-card ${diagnostic().categoryClass}`}>
                <div class="crash-diag-header">
                  <div class="crash-diag-title-wrap">
                    <div class="crash-diag-icon">
                      <Show when={diagnostic().iconName === "memory"}><IconHardDrive /></Show>
                      <Show when={diagnostic().iconName === "java"}><IconCoffee /></Show>
                      <Show when={diagnostic().iconName === "mod" || diagnostic().iconName === "conflict"}><IconPuzzle /></Show>
                      <Show when={diagnostic().iconName === "gpu"}><IconCpu /></Show>
                      <Show when={diagnostic().iconName === "file"}><IconFileText /></Show>
                      <Show when={diagnostic().iconName === "alert"}><IconAlertTriangle /></Show>
                    </div>
                    <div class="crash-diag-title">{diagnostic().title}</div>
                  </div>
                  <span class="crash-diag-badge">{diagnostic().category}</span>
                </div>

                <div class="crash-diag-desc">{diagnostic().description}</div>

                <div class="crash-diag-root-box">
                  <span>Root Cause: {diagnostic().rootCauseSnippet}</span>
                </div>

                <div class="crash-diag-actions">
                  <div class="crash-diag-actions-left">
                    <Show when={diagnostic().actionLabel}>
                      <button type="button" class="btn btn--primary btn--sm" onClick={handleAction}>
                        <Show when={diagnostic().actionType === "memory"}><IconSliders /></Show>
                        <Show when={diagnostic().actionType === "java"}><IconCoffee /></Show>
                        <Show when={diagnostic().actionType === "mods"}><IconPuzzle /></Show>
                        <span>{diagnostic().actionLabel}</span>
                      </button>
                    </Show>
                    <button type="button" class="btn btn--neutral btn--sm" onClick={copySummary}>
                      <IconClipboard />
                      <span>Copy Summary</span>
                    </button>
                  </div>
                  <div style="font-size: 11px; color: var(--text-faint); display: flex; align-items: center; gap: 6px;">
                    <IconCheck />
                    <span>Diagnostics: Offline</span>
                  </div>
                </div>
              </div>

              {/* Toolbar */}
              <div class="crash-toolbar">
                <div class="crash-toolbar-path" data-tip={reportPath() || "Console Logs Stream"}>
                  {reportPath() || "Console Output (latest.log)"}
                </div>
                <div class="crash-toolbar-tools">
                  <div class="crash-search-box">
                    <IconSearch />
                    <input
                      type="text"
                      placeholder="Search log..."
                      value={searchFilter()}
                      onInput={(e) => setSearchFilter(e.currentTarget.value)}
                    />
                  </div>
                  <button type="button" class="btn btn--neutral btn--sm" onClick={jumpToRootCause}>
                    <IconBolt />
                    <span>Jump to Cause</span>
                  </button>
                  <button type="button" class="btn btn--primary btn--sm" onClick={copyFullReport}>
                    <IconClipboard />
                    <span>Copy All</span>
                  </button>
                </div>
              </div>

              {/* Code Viewer with Full Selectable Text */}
              <div class="crash-viewer" ref={viewerRef}>
                <For each={filteredLines()}>
                  {(item) => {
                    const isRoot = item.index === diagnostic().rootCauseLineIndex;
                    const highlight = isHighlighted(item.text);
                    return (
                      <div
                        id={`crash-line-${item.index}`}
                        class={`crash-line ${isRoot ? "is-root-cause" : highlight ? "highlight" : ""}`}
                      >
                        <span class="crash-line-num">{item.index + 1}</span>
                        <span class="crash-line-text">{item.text || "\u00a0"}</span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="modal-footer" style="display: flex; align-items: center; justify-content: space-between;">
            <div style="font-size: 11px; color: var(--text-faint);">
              Tip: Click and drag with mouse to highlight and copy individual lines.
            </div>
            <div style="display: flex; gap: 8px;">
              <Show when={targetInstanceId()}>
                <button type="button" class="btn btn--neutral btn--sm" onClick={handleOpenFolder}>
                  <IconFolderOpen />
                  <span>Open Folder</span>
                </button>
              </Show>
              <button type="button" class="btn btn--neutral btn--sm" onClick={close}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CrashReportModal;
