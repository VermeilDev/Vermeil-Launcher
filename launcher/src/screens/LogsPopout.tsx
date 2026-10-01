// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { currentLogTarget, readInstanceLog, LogTarget } from "../ipc/commands";
import { IconSearch, IconArrowUp, IconArrowDown, IconX } from "../components/Icons";

/**
 * Standalone log viewer rendered in its own Tauri window ("logs" label).
 * index.tsx routes here when the URL carries `?popout=logs`. The window is
 * opened by the backend on launch when the `popout_logs` setting is on, so a
 * user who hides the launcher to the tray can still watch the game's output.
 *
 * This runs in a fresh webview with no shared app state, so it manages its
 * own line buffer: it seeds from the persisted `latest.log` on open, then
 * tails live `game-log` events filtered to the active instance. The backend's
 * `current_log_target` tells it which instance to show on mount, and a
 * `logs-load-instance` event re-points it when a different instance launches
 * while the window is already open.
 */
const LogsPopout: Component = () => {
  const appWindow = getCurrentWindow();
  // Cap the buffer so a chatty modpack logging tens of thousands of lines
  // can't grow the array and DOM unbounded. We keep the most recent lines,
  // which is what a tail-style viewer wants anyway.
  const MAX_LINES = 5000;
  const [instanceId, setInstanceId] = createSignal<string | null>(null);
  const [instanceName, setInstanceName] = createSignal("");
  const [lines, setLines] = createSignal<string[]>([]);
  const [filters, setFilters] = createSignal<Set<string>>(new Set(["all"]));
  const [search, setSearch] = createSignal("");
  const [autoScroll, setAutoScroll] = createSignal(true);
  let viewerEl: HTMLDivElement | undefined;

  /** Point the viewer at an instance: clear the buffer, seed from the
   *  persisted log file, and update the header. Live event lines append on
   *  top of the seed. */
  const loadInstance = async (target: LogTarget) => {
    setInstanceId(target.instance_id);
    setInstanceName(target.name);
    try {
      const content = await readInstanceLog(target.instance_id);
      // Split into lines, dropping a single trailing empty line from the
      // file's final newline so we don't render a phantom blank row.
      const split = content.length ? content.split(/\r?\n/) : [];
      if (split.length && split[split.length - 1] === "") split.pop();
      setLines(split.length > MAX_LINES ? split.slice(split.length - MAX_LINES) : split);
    } catch {
      setLines([]);
    }
  };

  onMount(async () => {
    try {
      const target = await currentLogTarget();
      if (target) await loadInstance(target);
    } catch { /* no target yet — wait for an event */ }

    // Tail live output for the active instance. The event is broadcast to all
    // windows, so we filter by the instance this popout is showing.
    const unlistenLog = await listen<{ instanceId: string; line: string }>("game-log", (e) => {
      if (e.payload.instanceId && e.payload.instanceId === instanceId()) {
        setLines((prev) => {
          const next = [...prev, e.payload.line];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
    });

    // Re-point at a different instance when one launches while we're open.
    const unlistenSwitch = await listen<LogTarget>("logs-load-instance", (e) => {
      loadInstance(e.payload);
    });

    onCleanup(() => {
      unlistenLog();
      unlistenSwitch();
    });
  });

  const getLineSeverity = (line: string): "error" | "warn" | "none" => {
    if (
      line.includes("/ERROR") ||
      line.includes("/FATAL") ||
      line.includes("[ERROR]") ||
      line.includes("[FATAL]") ||
      line.includes("ERROR:") ||
      line.includes("FATAL:") ||
      line.startsWith("Exception in thread")
    ) {
      return "error";
    }
    if (
      line.includes("/WARN") ||
      line.includes("/WARNING") ||
      line.includes("[WARN]") ||
      line.includes("[WARNING]") ||
      line.includes("WARN:") ||
      line.includes("WARNING:")
    ) {
      return "warn";
    }
    return "none";
  };

  const isContinuationLine = (line: string): boolean => {
    return (
      line.startsWith("\tat ") ||
      line.startsWith("    at ") ||
      line.startsWith("\t...") ||
      line.startsWith("    ...") ||
      line.startsWith("Caused by:") ||
      line.startsWith("\tSuppressed:")
    );
  };

  const getLineClass = (line: string): string => {
    const sev = getLineSeverity(line);
    if (sev === "error") return "log-error";
    if (sev === "warn") return "log-warn";
    if (isContinuationLine(line)) return "log-error log-trace";
    return "";
  };

  const toggleFilter = (filter: string) => {
    const current = new Set(filters());
    if (filter === "all") {
      setFilters(new Set(["all"]));
    } else {
      current.delete("all");
      if (current.has(filter)) {
        current.delete(filter);
        if (current.size === 0) current.add("all");
      } else {
        current.add(filter);
      }
      setFilters(current);
    }
    requestAnimationFrame(() => {
      if (!viewerEl) return;
      if (autoScroll()) {
        viewerEl.scrollTop = viewerEl.scrollHeight;
      } else {
        viewerEl.scrollTop = 0;
      }
    });
  };

  const filteredLines = createMemo(() => {
    const active = filters();
    const q = search().trim().toLowerCase();
    const allLines = lines();

    const filterAll = active.has("all");
    const filterError = active.has("error");
    const filterWarn = active.has("warn");

    if (filterAll && !q) {
      return allLines;
    }

    const result: string[] = [];
    let keepContinuation = false;

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      let matches = false;

      if (filterAll) {
        matches = true;
      } else {
        const sev = getLineSeverity(line);
        if (sev === "error" && filterError) {
          matches = true;
          keepContinuation = true;
        } else if (sev === "warn" && filterWarn) {
          matches = true;
          keepContinuation = true;
        } else if (keepContinuation && isContinuationLine(line)) {
          matches = true;
        } else {
          keepContinuation = false;
        }
      }

      if (matches && (!q || line.toLowerCase().includes(q))) {
        result.push(line);
      }
    }

    return result;
  });

  let isProgrammaticScroll = false;
  let programmaticScrollTimeout: number | undefined;

  const scrollTo = (top: number, autoFollow: boolean) => {
    if (!viewerEl) return;
    setAutoScroll(autoFollow);
    if (programmaticScrollTimeout !== undefined) {
      clearTimeout(programmaticScrollTimeout);
    }
    isProgrammaticScroll = true;
    viewerEl.scrollTo({ top, behavior: "smooth" });
    programmaticScrollTimeout = window.setTimeout(() => {
      isProgrammaticScroll = false;
      if (autoFollow && viewerEl) {
        viewerEl.scrollTop = viewerEl.scrollHeight;
      }
    }, 320);
  };

  const jumpToTop = () => scrollTo(0, false);
  const jumpToBottom = () => {
    if (!viewerEl) return;
    scrollTo(viewerEl.scrollHeight, true);
  };

  const onViewerScroll = () => {
    if (!viewerEl || isProgrammaticScroll) return;
    const distance = viewerEl.scrollHeight - viewerEl.scrollTop - viewerEl.clientHeight;
    setAutoScroll(distance < 40);
  };

  // Follow latest output on new incoming lines
  createEffect(() => {
    const count = filteredLines().length;
    if (count > 0 && autoScroll() && viewerEl && !isProgrammaticScroll) {
      requestAnimationFrame(() => {
        if (viewerEl && autoScroll() && !isProgrammaticScroll) {
          viewerEl.scrollTop = viewerEl.scrollHeight;
        }
      });
    }
  });

  onCleanup(() => {
    if (programmaticScrollTimeout !== undefined) {
      clearTimeout(programmaticScrollTimeout);
    }
  });

  return (
    <div class="logs-popout">
      {/* Custom titlebar to match the launcher chrome (window is undecorated).
          Mirrors components/Titlebar.tsx controls; drag region fills the bar. */}
      <div class="titlebar" onMouseDown={() => appWindow.startDragging()}>
        <div class="win-btns">
          <button class="win-btn win-close" onClick={(e) => { e.stopPropagation(); appWindow.close(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" /><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
          <button class="win-btn win-minimize" onClick={(e) => { e.stopPropagation(); appWindow.minimize(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2.5" y1="6" x2="9.5" y2="6" />
            </svg>
          </button>
          <button class="win-btn win-maximize" onClick={(e) => { e.stopPropagation(); appWindow.toggleMaximize(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            </svg>
          </button>
        </div>
        <div class="titlebar-title">Logs{instanceName() ? ` — ${instanceName()}` : ""}</div>
      </div>

      <div class="logs-popout-body">
        <div class="log-toolbar">
          <div class="log-toolbar-filters">
            <button
              type="button"
              class={`log-filter-btn ${filters().has("all") ? "active" : ""}`}
              onClick={() => toggleFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              class={`log-filter-btn error ${filters().has("error") ? "active" : ""}`}
              onClick={() => toggleFilter("error")}
            >
              Errors
            </button>
            <button
              type="button"
              class={`log-filter-btn warn ${filters().has("warn") ? "active" : ""}`}
              onClick={() => toggleFilter("warn")}
            >
              Warnings
            </button>
          </div>

          <div class="log-toolbar-search">
            <span class="log-toolbar-search-icon"><IconSearch /></span>
            <input
              class="log-toolbar-search-input"
              type="text"
              spellcheck={false}
              placeholder="Search logs..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <Show when={search()}>
              <button
                type="button"
                class="log-toolbar-search-clear tip-below"
                onClick={() => setSearch("")}
                data-tip="Clear search"
                aria-label="Clear search"
              >
                <span class="side-icon"><IconX /></span>
              </button>
            </Show>
          </div>

          <button
            type="button"
            class="log-toolbar-jump tip-below"
            onClick={jumpToTop}
            data-tip="Jump to top"
            aria-label="Jump to top"
          >
            <IconArrowUp />
          </button>
          <button
            type="button"
            class={`log-toolbar-jump tip-below ${autoScroll() ? "active" : ""}`}
            onClick={jumpToBottom}
            data-tip={autoScroll() ? "Auto-scroll active (click to lock)" : "Jump to latest (resume auto-scroll)"}
            aria-label="Jump to latest"
          >
            <IconArrowDown />
          </button>
          <span class="log-toolbar-count">
            <Show when={filteredLines().length !== lines().length} fallback={`${lines().length} lines`}>
              {filteredLines().length} / {lines().length} lines
            </Show>
          </span>
        </div>

        <div class="log-viewer-frame">
          {/* Command line overlay icon backdrop */}
          <Show when={filteredLines().length === 0}>
            <div class="log-ascii-backdrop">
              <svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 24 24" fill="none" stroke="url(#log-grad-popout)" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round">
                <defs>
                  <linearGradient id="log-grad-popout" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="var(--accent-cyan)" />
                    <stop offset="100%" stop-color="var(--accent)" />
                  </linearGradient>
                </defs>
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <polyline points="7 8 10 11 7 14" />
                <line x1="13" y1="14" x2="17" y2="14" />
              </svg>
            </div>
          </Show>

          <div
            class="log-viewer"
            ref={(el) => {
              viewerEl = el;
              el.addEventListener("scroll", onViewerScroll, { passive: true });
              onCleanup(() => {
                el.removeEventListener("scroll", onViewerScroll);
                if (viewerEl === el) viewerEl = undefined;
              });
              requestAnimationFrame(() => {
                if (viewerEl && autoScroll()) {
                  viewerEl.scrollTop = viewerEl.scrollHeight;
                }
              });
            }}
          >
            <Show when={filteredLines().length === 0}>
              <div class="log-empty-hint">
                <Show
                  when={search()}
                  fallback={<span>No logs yet. Output will appear here while the game runs.</span>}
                >
                  <span>No matches for "{search()}".</span>
                </Show>
              </div>
            </Show>
            <For each={filteredLines()}>
              {(line) => (
                <div class={`log-line ${getLineClass(line)}`}>
                  <span class="log-prompt" aria-hidden="true">&gt;</span>
                  <span class="log-text">{line}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LogsPopout;
