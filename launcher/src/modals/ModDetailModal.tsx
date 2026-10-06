// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { ContentVersion, ModHit, getCfModFiles, getModVersions } from "../ipc/commands";
import { formatDownloads, formatSize, formatVersionRange } from "../lib/format";
import {
  IconBolt,
  IconDownload,
  IconHeart,
  IconCheck,
  IconModrinth,
  IconCurseForge,
  IconSearch,
  IconRefresh,
} from "../components/Icons";

interface Props {
  /** The mod to describe. `null` closes the modal. */
  mod: ModHit | null;
  source: "modrinth" | "curseforge";
  loader: string;
  gameVersion: string;
  category: string;
  /** Loader names to show as pills — the screen already knows how to derive these. */
  loaders: string[];
  installedVersionId?: string;
  busy?: boolean;
  onClose: () => void;
  onInstall: (version: ContentVersion) => void;
}

const CACHE_LIMIT = 50;
const versionCache = new Map<string, ContentVersion[]>();

function setCache(key: string, val: ContentVersion[]) {
  versionCache.set(key, val);
  while (versionCache.size > CACHE_LIMIT) {
    const oldest = versionCache.keys().next();
    if (oldest.done) break;
    versionCache.delete(oldest.value);
  }
}

function channelLabel(channel: string): string {
  switch (channel.toLowerCase()) {
    case "release":
      return "Release";
    case "beta":
      return "Beta";
    case "alpha":
      return "Alpha";
    default:
      return channel || "Unknown";
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Detail view for one Browse result: identity header with source pill, recessed summary,
 * 4-column metrics grid, installed instance status, full version browser with channel filtering,
 * and a tactile footer.
 */
const ModDetailModal: Component<Props> = (props) => {
  const [versions, setVersions] = createSignal<ContentVersion[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [versionSearch, setVersionSearch] = createSignal("");
  const [channelFilter, setChannelFilter] = createSignal<string>("all");
  const [showAll, setShowAll] = createSignal(false);
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);

  const effectiveSource = (): "modrinth" | "curseforge" =>
    props.source === "curseforge" || /^\d+$/.test(props.mod?.project_id || "")
      ? "curseforge"
      : "modrinth";

  // Capture phase + stopImmediatePropagation: closes the modal on Escape
  // without triggering parent navigation away from the instance screen.
  createEffect(() => {
    if (!props.mod) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const initSelection = (list: ContentVersion[]) => {
    if (props.installedVersionId) {
      const inst = list.find((v) => v.id === props.installedVersionId);
      if (inst) {
        setSelectedVersionId(inst.id);
        return;
      }
    }
    const rec =
      list.find((v) => v.recommended && v.compatible) ||
      list.find((v) => v.recommended) ||
      list.find((v) => v.compatible) ||
      list[0];
    setSelectedVersionId(rec ? rec.id : null);
  };

  // Fetch versions whenever the mod, source, loader, or game version changes
  createEffect(() => {
    const m = props.mod;
    if (!m) {
      setVersions([]);
      setSelectedVersionId(null);
      return;
    }

    const src = effectiveSource();
    const cacheKey = `${src}:${m.project_id}:${props.loader}:${props.gameVersion}:${props.category}`;
    const cached = versionCache.get(cacheKey);
    if (cached) {
      setVersions(cached);
      setLoading(false);
      setError(null);
      initSelection(cached);
      return;
    }

    setLoading(true);
    setError(null);

    const fetchPromise =
      src === "curseforge"
        ? getCfModFiles(m.project_id, props.loader, props.gameVersion)
        : getModVersions(m.project_id, props.loader, props.gameVersion, props.category);

    fetchPromise
      .then((res) => {
        setCache(cacheKey, res);
        setVersions(res);
        initSelection(res);
      })
      .catch((e) => {
        setError(typeof e === "string" ? e : "Could not load versions.");
      })
      .finally(() => {
        setLoading(false);
      });
  });

  const incompatibleCount = () => versions().filter((v) => !v.compatible).length;

  const filteredVersions = () => {
    let list = versions();
    if (!showAll()) {
      const hasCompatible = list.some((v) => v.compatible);
      if (hasCompatible) {
        list = list.filter((v) => v.compatible);
      }
    }
    const chan = channelFilter();
    if (chan !== "all") {
      list = list.filter((v) => v.channel.toLowerCase() === chan);
    }
    const q = versionSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (v) =>
          v.name.toLowerCase().includes(q) ||
          (v.filename && v.filename.toLowerCase().includes(q)) ||
          v.game_versions.some((gv) => gv.toLowerCase().includes(q)) ||
          v.loaders.some((l) => l.toLowerCase().includes(q))
      );
    }
    return list;
  };

  const selectedVersionObj = () => versions().find((v) => v.id === selectedVersionId());
  const isSelectedInstalled = () =>
    Boolean(props.installedVersionId && props.installedVersionId === selectedVersionId());
  const installedVersionObj = () =>
    versions().find((v) => v.id === props.installedVersionId);

  const versionCount = () => props.mod?.versions?.length ?? 0;
  const environment = () => {
    const m = props.mod;
    if (!m) return "";
    const parts: string[] = [];
    if (m.client_side) parts.push(`client ${m.client_side}`);
    if (m.server_side) parts.push(`server ${m.server_side}`);
    return parts.join(" · ");
  };

  return (
    <Show when={props.mod}>
      {(mod) => (
        <div class="modal-overlay mod-detail-overlay" onClick={props.onClose}>
          <div
            class="modal mod-detail-modal panel panel--bracketed"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="modal-header mod-detail-header">
              <div class="mod-detail-identity">
                <div class="mod-detail-icon">
                  <Show when={mod().icon_url} fallback={<IconBolt />}>
                    <img
                      src={mod().icon_url!}
                      alt=""
                      draggable={false}
                      class="mod-detail-icon-img"
                    />
                  </Show>
                </div>
                <div class="mod-detail-names">
                  <div class="mod-detail-title-row">
                    <span class="modal-title mod-detail-title">{mod().title}</span>
                    <span
                      class={`mod-source-badge ${
                        effectiveSource() === "modrinth" ? "source-mr" : "source-cf"
                      }`}
                    >
                      <Show
                        when={effectiveSource() === "modrinth"}
                        fallback={<><IconCurseForge /> CurseForge</>}
                      >
                        <><IconModrinth /> Modrinth</>
                      </Show>
                    </span>
                  </div>
                  <Show when={mod().author}>
                    <span class="mod-detail-author">
                      Created by <strong>{mod().author}</strong>
                    </span>
                  </Show>
                </div>
              </div>
            </div>

            {/* Body */}
            <div class="modal-body mod-detail-body">
              {/* Recessed description plate */}
              <p class="mod-detail-summary">{mod().description}</p>

              {/* 4-column metric stats */}
              <div class="mod-detail-stats">
                <div class="mod-detail-stat">
                  <span class="mod-detail-stat-label">
                    <IconDownload /> Downloads
                  </span>
                  <span class="mod-detail-stat-value">
                    {formatDownloads(mod().downloads)}
                  </span>
                </div>
                <div class="mod-detail-stat">
                  <span class="mod-detail-stat-label">
                    <IconHeart /> Followers
                  </span>
                  <span class="mod-detail-stat-value">
                    {formatDownloads(mod().follows)}
                  </span>
                </div>
                <div class="mod-detail-stat">
                  <span class="mod-detail-stat-label">Game Versions</span>
                  <span class="mod-detail-stat-value">
                    {formatVersionRange(mod().versions) || "Any"}
                    <Show when={versionCount() > 1}>
                      <span class="mod-detail-stat-sub"> ({versionCount()} builds)</span>
                    </Show>
                  </span>
                </div>
                <div class="mod-detail-stat">
                  <span class="mod-detail-stat-label">Environment / Loaders</span>
                  <div class="mod-detail-loaders-list">
                    <Show
                      when={props.loaders.length > 0}
                      fallback={
                        <span class="mod-detail-stat-value">
                          {environment() || "Universal"}
                        </span>
                      }
                    >
                      <For each={props.loaders}>
                        {(l) => (
                          <span class={`badge badge--loader badge--${l}`}>
                            {l.charAt(0).toUpperCase() + l.slice(1)}
                          </span>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </div>

              {/* Existing installed notice banner */}
              <Show when={props.installedVersionId}>
                <div class="mod-existing-notice">
                  <div class="mod-existing-heading">
                    <IconCheck />
                    <span>
                      Installed in this instance:{" "}
                      <strong>
                        {installedVersionObj()?.name || props.installedVersionId}
                      </strong>
                    </span>
                  </div>
                </div>
              </Show>

              {/* Version selector section */}
              <div class="mod-versions-section">
                <div class="mod-versions-header">
                  <span class="mod-section-title">Available Versions</span>
                  <div class="mod-version-filters">
                    {/* Channel filter pills */}
                    <div class="mod-channel-pills">
                      <button
                        type="button"
                        class={`mod-channel-pill ${channelFilter() === "all" ? "active" : ""}`}
                        onClick={() => setChannelFilter("all")}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        class={`mod-channel-pill ${channelFilter() === "release" ? "active" : ""}`}
                        onClick={() => setChannelFilter("release")}
                      >
                        Release
                      </button>
                      <button
                        type="button"
                        class={`mod-channel-pill ${channelFilter() === "beta" ? "active" : ""}`}
                        onClick={() => setChannelFilter("beta")}
                      >
                        Beta
                      </button>
                      <button
                        type="button"
                        class={`mod-channel-pill ${channelFilter() === "alpha" ? "active" : ""}`}
                        onClick={() => setChannelFilter("alpha")}
                      >
                        Alpha
                      </button>
                    </div>

                    {/* Incompatible filter toggle */}
                    <Show when={incompatibleCount() > 0}>
                      <button
                        type="button"
                        class={`btn btn--sm mod-filter-toggle tip-below tip-right ${showAll() ? "active" : ""}`}
                        onClick={() => setShowAll(!showAll())}
                        data-tip={`${incompatibleCount()} incompatible versions`}
                      >
                        {showAll() ? "Compatible only" : `Show all (${versions().length})`}
                      </button>
                    </Show>

                    {/* Filter input */}
                    <div class="mod-version-search">
                      <IconSearch />
                      <input
                        type="text"
                        placeholder="Filter versions..."
                        value={versionSearch()}
                        onInput={(e) => setVersionSearch(e.currentTarget.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Warnings for currently selected version */}
                <Show when={selectedVersionObj() && !selectedVersionObj()!.compatible}>
                  <div class="mod-version-warning">
                    <span>
                      ⚠️ This version does not target {props.loader} {props.gameVersion}. Installing it anyway may prevent Minecraft from launching.
                    </span>
                  </div>
                </Show>
                <Show when={selectedVersionObj() && !selectedVersionObj()!.downloadable}>
                  <div class="mod-version-warning">
                    <span>
                      ⚠️ Direct download is disabled by the author. You will be prompted with CurseForge download instructions.
                    </span>
                  </div>
                </Show>

                {/* Version list */}
                <div class="mod-versions-list">
                  <Show when={loading()}>
                    <div class="mod-versions-loading">
                      <div class="spinner-sm" />
                      <span>Fetching versions...</span>
                    </div>
                  </Show>

                  <Show when={error()}>
                    <div class="mod-versions-error">
                      <span>{error()}</span>
                    </div>
                  </Show>

                  <Show when={!loading() && !error() && filteredVersions().length === 0}>
                    <div class="mod-versions-empty">
                      {versionSearch()
                        ? `No versions match "${versionSearch()}".`
                        : `No compatible versions available for ${props.loader} ${props.gameVersion}.`}
                    </div>
                  </Show>

                  <Show when={!loading() && !error() && filteredVersions().length > 0}>
                    <For each={filteredVersions()}>
                      {(v) => {
                        const isSelected = () => selectedVersionId() === v.id;
                        const isThisInstalled = () => props.installedVersionId === v.id;
                        const channel = v.channel.toLowerCase();

                        return (
                          <div
                            class={`mod-version-row ${isSelected() ? "selected" : ""}`}
                            onClick={() => setSelectedVersionId(v.id)}
                          >
                            <div class="mod-vrow-left">
                              <div class="mod-vrow-title-row">
                                <span class="mod-vrow-name">{v.name}</span>
                                <span class={`mod-vrow-channel channel-${channel}`}>
                                  {channelLabel(v.channel)}
                                </span>
                                <Show when={v.recommended}>
                                  <span class="mod-vrow-recommended">Recommended</span>
                                </Show>
                                <Show when={isThisInstalled()}>
                                  <span class="mod-vrow-installed">Installed</span>
                                </Show>
                                <Show when={!v.compatible}>
                                  <span class="mod-vrow-warn">Incompatible</span>
                                </Show>
                                <Show when={!v.downloadable}>
                                  <span class="mod-vrow-warn">Manual</span>
                                </Show>
                              </div>
                              <div class="mod-vrow-meta">
                                <span class="mod-vrow-mc">
                                  MC {v.game_versions.join(", ") || "Any"}
                                </span>
                                <Show when={v.loaders.length > 0}>
                                  <span class="mod-vrow-sep">·</span>
                                  <span class="mod-vrow-loaders">
                                    {v.loaders.join(", ")}
                                  </span>
                                </Show>
                                <Show when={v.size > 0}>
                                  <span class="mod-vrow-sep">·</span>
                                  <span class="mod-vrow-size">{formatSize(v.size)}</span>
                                </Show>
                                <Show when={formatDate(v.date_published)}>
                                  <span class="mod-vrow-sep">·</span>
                                  <span class="mod-vrow-date">
                                    {formatDate(v.date_published)}
                                  </span>
                                </Show>
                              </div>
                            </div>
                            <div class="mod-vrow-right">
                              <Show
                                when={!isThisInstalled()}
                                fallback={
                                  <span class="btn btn--installed">
                                    <IconCheck /> Installed
                                  </span>
                                }
                              >
                                <button
                                  type="button"
                                  class="btn btn--sm btn--primary mod-vrow-install"
                                  disabled={props.busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onInstall(v);
                                  }}
                                >
                                  {props.busy && selectedVersionId() === v.id
                                    ? "..."
                                    : "Install"}
                                </button>
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div class="modal-footer mod-detail-footer">
              <div class="mod-footer-left">
                <Show when={selectedVersionObj()}>
                  <span class="mod-selected-indicator">
                    Selected: <strong>{selectedVersionObj()!.name}</strong>
                    <span
                      class={`mod-vrow-channel channel-${selectedVersionObj()!.channel.toLowerCase()}`}
                    >
                      {channelLabel(selectedVersionObj()!.channel)}
                    </span>
                  </span>
                </Show>
              </div>
              <div class="mod-footer-actions">
                <button
                  type="button"
                  class="btn mod-footer-close-btn"
                  onClick={props.onClose}
                >
                  Close
                </button>
                <button
                  type="button"
                  class={`btn ${isSelectedInstalled() ? "btn--secondary" : "btn--primary"}`}
                  disabled={
                    props.busy || !selectedVersionObj()
                  }
                  onClick={() => {
                    const v = selectedVersionObj();
                    if (v) props.onInstall(v);
                  }}
                >
                  <Show when={!props.busy} fallback={"Installing..."}>
                    <Show
                      when={isSelectedInstalled()}
                      fallback={
                        <>
                          <IconDownload />{" "}
                          {selectedVersionObj()
                            ? (props.installedVersionId ? `Switch to ${selectedVersionObj()!.name}` : `Install ${selectedVersionObj()!.name}`)
                            : "Install"}
                        </>
                      }
                    >
                      <><IconRefresh /> Reinstall {selectedVersionObj()?.name}</>
                    </Show>
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ModDetailModal;
