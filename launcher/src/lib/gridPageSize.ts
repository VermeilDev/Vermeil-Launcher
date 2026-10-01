// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { createSignal, onCleanup } from "solid-js";

/**
 * Column-aware page size for a paged `.card-grid`. Measures the grid container
 * and reports `columns × rows`, so each page fills complete rows with no empty
 * trailing cell when the window is resized/maximized.
 *
 * Unlike a layout-overriding approach it does NOT touch the grid's CSS template
 * (the grid still lays out via `auto-fit`) — it only sizes the *page*. It
 * recomputes after a resize settles (`debounceMs`, default 300 — so a
 * server-paged grid doesn't spam its API during a drag), or immediately when
 * `debounceMs` is 0 (client-sliced grids like news, so the fill follows the
 * window with no empty-slot flicker). `cols`
 * uses the same math CSS `auto-fit` uses, so it matches the rendered columns:
 * pass the same `track` (the grid's `minmax` min) and `gap` the CSS uses.
 *
 * Usage:
 *   const page = createGridPageSize({ track: 240, gap: 12, rowHeight: 210, maxRows: 5 });
 *   <div class="card-grid" ref={page.setEl}>…</div>
 *   // page.size() → items to show/fetch per page
 */
export function createGridPageSize(opts: { track: number; gap: number; rowHeight: number; maxRows: number | (() => number); maxCols?: number; fixedRows?: boolean; debounceMs?: number }) {
  const debounceMs = opts.debounceMs ?? 300;
  const getMaxRows = () => (typeof opts.maxRows === "function" ? opts.maxRows() : opts.maxRows);
  const [size, setSize] = createSignal((opts.maxCols ? opts.maxCols * getMaxRows() : getMaxRows() * 4) || 12);
  let el: HTMLElement | undefined;
  let settle: number | undefined;

  const compute = () => {
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const rawCols = Math.max(1, Math.floor((w + opts.gap) / (opts.track + opts.gap)));
    const cols = opts.maxCols ? Math.min(opts.maxCols, rawCols) : rawCols;
    const maxR = getMaxRows();
    let rows = maxR;
    if (!opts.fixedRows) {
      const content = el.closest(".content") as HTMLElement | null;
      let availH = window.innerHeight;
      if (content) {
        const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top;
        availH = content.clientHeight - top;
      }
      rows = Math.min(maxR, Math.max(1, Math.ceil(availH / (opts.rowHeight + opts.gap))));
    }
    setSize(cols * rows); // multiple of cols → trailing row is always full
  };

  // Server-paged grids (Browse) debounce so a drag-resize doesn't spam the
  // rate-limited API; client-sliced grids (news) recompute immediately so the
  // fill follows the window with no visible empty-slot flicker.
  const onResize = () => {
    if (debounceMs <= 0) { compute(); return; }
    if (settle !== undefined) clearTimeout(settle);
    settle = window.setTimeout(compute, debounceMs);
  };

  const setEl = (node: HTMLElement) => {
    el = node;
    compute();
    requestAnimationFrame(compute);
    const ro = new ResizeObserver(onResize);
    ro.observe(node);
    const content = node.closest(".content");
    if (content) ro.observe(content);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      if (settle !== undefined) clearTimeout(settle);
    });
  };

  return { setEl, size };
}
