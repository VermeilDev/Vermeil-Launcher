// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { ContentVersion, getCfModFiles, getModVersions } from "../ipc/commands";
import { formatSize } from "../lib/format";
import { filterVersions, resolveSelection } from "../lib/versionPick";
import { IconChevronDown, IconCheck, IconDownload } from "./Icons";

interface Props {
  source: "modrinth" | "curseforge";
  projectId: string;
  /** Instance loader — decides which entries come back marked compatible. */
  loader: string;
  gameVersion: string;
  /** "mod" | "resourcepack" | "shader" | "datapack" */
  category: string;
  /** Version currently installed, so the list can mark it. */
  installedVersionId?: string;
  /** True while an install for this project is in flight. */
  busy?: boolean;
  /** Install one specific version. `id` is a Modrinth version id or a CF file id. */
  onInstall: (version: ContentVersion) => void;
}

/**
 * Session cache of fetched version lists, so reopening a mod's detail view
 * doesn't re-hit a rate-limited API.
 *
 * Bounded because it would otherwise grow for every project a user ever opens.
 * Insertion-ordered eviction (Map preserves insertion order), which is FIFO
 * rather than LRU — good enough for a cache whose whole job is "the mod I just
 * closed".
 */
const CACHE_LIMIT = 50;
const cache = new Map<string, ContentVersion[]>();

function cacheSet(key: string, value: ContentVersion[]) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const channelLabel = (c: string): string => {
  switch (c) {
    case "release": return "Release";
    case "beta": return "Beta";
    case "alpha": return "Alpha";
    default: return "";
  }
};

/** Blank for an unreported size, so the meta line doesn't show "0 B". */
const sizeLabel = (bytes: number): string => (bytes > 0 ? formatSize(bytes) : "");

/** Date only — the time of day is noise at this size. */
const formatDate = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/**
 * Version list for one project: a trigger showing the current choice, and a list
 * that opens beneath it.
 *
 * The list renders **inline**, not in a floating `<Portal>` panel. A portal was
 * needed when this lived inside a Browse card, because `.card` is
 * `overflow: hidden` and would clip an absolutely-positioned panel. Inside the
 * detail modal there's nothing to escape: the modal body already scrolls. Going
 * inline drops the trigger-rect measurement, the viewport-edge flipping, and the
 * outside-click and scroll listeners — all of which were failure surfaces. It
 * also stops competing with the modal for the Escape key.
 *
 * Compatibility is never computed here: the backend labels each entry using the
 * same functions the installer uses, so this component only renders `compatible`.
 */
const ModVersionPicker: Component<Props> = (props) => {
  const [versions, setVersions] = createSignal<ContentVersion[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  const cacheKey = () =>
    `${props.source}:${props.projectId}:${props.loader}:${props.gameVersion}:${props.category}`;

  // Fetched when the detail view opens — an explicit user action, so this isn't
  // speculative traffic. Never prefetched on hover.
  createEffect(() => {
    const key = cacheKey();
    const cached = cache.get(key);
    if (cached) {
      setVersions(cached);
      setLoading(false);
      return;
    }
    let stale = false;
    onCleanup(() => { stale = true; });
    setLoading(true);
    setError(null);
    const request = props.source === "curseforge"
      ? getCfModFiles(props.projectId, props.loader, props.gameVersion)
      : getModVersions(props.projectId, props.loader, props.gameVersion, props.category);
    request
      .then((list) => {
        if (stale) return;
        cacheSet(key, list);
        setVersions(list);
      })
      .catch((e) => {
        if (stale) return;
        setError(typeof e === "string" ? e : "Couldn't load versions");
      })
      .finally(() => { if (!stale) setLoading(false); });
  });

  /** Defaults to whatever the plain Install button would pick. */
  const effectiveSelected = () => resolveSelection(versions(), selectedId());
  const visible = () => filterVersions(versions(), { showAll: showAll(), query: query() });
  const incompatibleCount = () => versions().filter((v) => !v.compatible).length;
  const alreadyInstalled = () => props.installedVersionId === effectiveSelected()?.id;

  const choose = (v: ContentVersion) => {
    setSelectedId(v.id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div class="version-picker">
      <div class="version-picker-head">
        <span class="mod-detail-stat-label">Version</span>
        <Show when={incompatibleCount() > 0}>
          {/* Fixed width: the two labels differ in length, and a resizing button
              shifts the row it sits in. The count goes in the tooltip rather than
              the label, where it read as a total and was really the fetch cap. */}
          <button
            class={`btn btn--sm btn--subtle btn--fixed tip-below tip-right ${showAll() ? "btn-active" : ""}`}
            style="--btn-fixed-width:112px"
            onClick={() => setShowAll(!showAll())}
            data-tip={`${incompatibleCount()} incompatible versions`}
          >
            {showAll() ? "Compatible only" : "Show all"}
          </button>
        </Show>
      </div>

      <Show when={!loading()} fallback={<div class="version-picker-status">Loading versions...</div>}>
        <Show when={!error()} fallback={<div class="version-picker-status is-error">{error()}</div>}>
          <Show
            when={versions().length > 0}
            /* Not "no versions published": CurseForge filters by game version
               server-side, so an empty list means none for this instance. */
            fallback={
              <div class="version-picker-status">
                No versions available for {props.loader} {props.gameVersion}.
              </div>
            }
          >
            <div class="version-picker-row">
              <button
                class="version-picker-trigger"
                classList={{ open: open() }}
                onClick={() => setOpen(!open())}
              >
                <span class="version-picker-trigger-label">
                  {effectiveSelected()?.name ?? "Select version"}
                </span>
                <Show when={effectiveSelected()?.recommended}>
                  <span class="version-tag version-tag--rec">auto</span>
                </Show>
                <span class="version-picker-caret" classList={{ open: open() }}>
                  <IconChevronDown />
                </span>
              </button>

              <button
                class="btn btn--primary btn--fixed version-picker-install"
                style="--btn-fixed-width:104px"
                disabled={props.busy || !effectiveSelected() || alreadyInstalled()}
                onClick={() => {
                  const v = effectiveSelected();
                  if (v) props.onInstall(v);
                }}
              >
                <Show when={!props.busy} fallback={"..."}>
                  <Show when={alreadyInstalled()} fallback={<><IconDownload /> Install</>}>
                    <IconCheck /> Installed
                  </Show>
                </Show>
              </button>
            </div>

            <Show when={effectiveSelected() && !effectiveSelected()!.compatible}>
              <div class="version-picker-warn">
                This version doesn't list {props.loader} {props.gameVersion}. Installing it anyway
                can stop the instance from launching.
              </div>
            </Show>
            <Show when={effectiveSelected() && !effectiveSelected()!.downloadable}>
              <div class="version-picker-warn">
                This file's author disabled third-party downloads. Install will point you at
                CurseForge to fetch it by hand.
              </div>
            </Show>

            <Show when={open()}>
              <div class="version-list">
                <Show when={versions().length > 8}>
                  <input
                    class="version-list-search"
                    placeholder="Search versions..."
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    ref={(el) => setTimeout(() => el.focus(), 0)}
                  />
                </Show>
                <div class="version-list-scroll">
                  <For each={visible()}>
                    {(v) => (
                      <button
                        class="version-option"
                        classList={{
                          selected: effectiveSelected()?.id === v.id,
                          "is-incompatible": !v.compatible,
                        }}
                        onClick={() => choose(v)}
                      >
                        <span class="version-option-name">{v.name}</span>
                        <span class="version-option-tags">
                          <Show when={channelLabel(v.channel)}>
                            <span class={`version-tag version-tag--${v.channel}`}>
                              {channelLabel(v.channel)}
                            </span>
                          </Show>
                          <Show when={v.recommended}>
                            <span class="version-tag version-tag--rec">auto</span>
                          </Show>
                          <Show when={props.installedVersionId === v.id}>
                            <span class="version-tag version-tag--installed">installed</span>
                          </Show>
                          <Show when={!v.compatible}>
                            <span class="version-tag version-tag--warn">incompatible</span>
                          </Show>
                          {/* The author blocked third-party downloads, so picking
                              this opens the manual-download dialog rather than
                              installing. Better known before the click. */}
                          <Show when={!v.downloadable}>
                            <span class="version-tag version-tag--warn">manual</span>
                          </Show>
                        </span>
                        <span class="version-option-meta">
                          <Show when={formatDate(v.date_published)}>
                            <span>{formatDate(v.date_published)}</span>
                          </Show>
                          <Show when={sizeLabel(v.size)}>
                            <span>{sizeLabel(v.size)}</span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                  <Show when={visible().length === 0}>
                    <div class="version-list-empty">
                      {query() ? `No versions match "${query()}"` : "No compatible versions."}
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default ModVersionPicker;
