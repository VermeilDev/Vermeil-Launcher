// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { ContentVersion, ModHit, getCfModFiles, getModVersions } from "../ipc/commands";
import { formatDownloads, formatSize, formatVersionRange, formatDate } from "../lib/format";
import {
  IconClock,
  IconDownload,
  IconHeart,
  IconLayers,
  IconCheck,
  IconModrinth,
  IconCurseForge,
  IconSearch,
} from "../components/Icons";

export interface ModpackDetailModalProps {
  pack: ModHit | null;
  source: "modrinth" | "curseforge";
  installedCount: number;
  installedInstances: Array<{ id: string; name: string }>;
  installing: boolean;
  onClose: () => void;
  onInstall: (pack: ModHit, versionId?: string) => void;
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

const LOADER_ORDER = ["fabric", "quilt", "neoforge", "forge"];
function extractLoaders(hit: ModHit): string[] {
  const cats = hit.categories ?? [];
  return LOADER_ORDER.filter((l) => cats.includes(l));
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

export const ModpackDetailModal: Component<ModpackDetailModalProps> = (props) => {
  const [versions, setVersions] = createSignal<ContentVersion[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [versionSearch, setVersionSearch] = createSignal("");
  const [channelFilter, setChannelFilter] = createSignal<string>("all");
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);

  // Capture Escape key to close modal before parent navigation handles it
  createEffect(() => {
    if (!props.pack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // Fetch versions whenever the selected pack or source changes
  createEffect(() => {
    const p = props.pack;
    if (!p) {
      setVersions([]);
      setSelectedVersionId(null);
      return;
    }

    const cacheKey = `${props.source}:${p.project_id}`;
    const cached = versionCache.get(cacheKey);
    if (cached) {
      setVersions(cached);
      setLoading(false);
      setError(null);
      const rec = cached.find((v) => v.recommended) || cached[0];
      setSelectedVersionId(rec ? rec.id : null);
      return;
    }

    setLoading(true);
    setError(null);

    const fetchPromise =
      props.source === "curseforge"
        ? getCfModFiles(p.project_id, "", "")
        : getModVersions(p.project_id, "", "", "modpack");

    fetchPromise
      .then((res) => {
        setCache(cacheKey, res);
        setVersions(res);
        const rec = res.find((v) => v.recommended) || res[0];
        setSelectedVersionId(rec ? rec.id : null);
      })
      .catch((e) => {
        console.error("Failed to fetch modpack versions:", e);
        setError(typeof e === "string" ? e : "Could not load version history.");
      })
      .finally(() => {
        setLoading(false);
      });
  });

  const filteredVersions = () => {
    let list = versions();
    const chan = channelFilter();
    if (chan !== "all") {
      list = list.filter((v) => v.channel.toLowerCase() === chan);
    }
    const q = versionSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (v) =>
          v.name.toLowerCase().includes(q) ||
          v.game_versions.some((gv) => gv.toLowerCase().includes(q)) ||
          v.loaders.some((l) => l.toLowerCase().includes(q))
      );
    }
    return list;
  };

  const selectedVersionObj = () => versions().find((v) => v.id === selectedVersionId());

  return (
    <Show when={props.pack}>
      {(pack) => {
        const loaders = extractLoaders(pack());
        const versionCount = () => pack().versions?.length ?? 0;

        return (
          <div class="modal-overlay modpack-detail-overlay" onClick={props.onClose}>
            <div
              class="modal modpack-detail-modal panel panel--bracketed"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div class="modal-header modpack-detail-header">
                <div class="modpack-detail-identity">
                  <div class="modpack-detail-icon">
                    <Show when={pack().icon_url} fallback={<IconLayers />}>
                      <img
                        src={pack().icon_url!}
                        alt=""
                        draggable={false}
                        class="modpack-detail-icon-img"
                      />
                    </Show>
                  </div>
                  <div class="modpack-detail-names">
                    <div class="modpack-detail-title-row">
                      <span class="modal-title modpack-detail-title">{pack().title}</span>
                      <span
                        class={`modpack-source-badge ${
                          props.source === "modrinth" ? "source-mr" : "source-cf"
                        }`}
                      >
                        <Show
                          when={props.source === "modrinth"}
                          fallback={<><IconCurseForge /> CurseForge</>}
                        >
                          <><IconModrinth /> Modrinth</>
                        </Show>
                      </span>
                    </div>
                    <Show when={pack().author}>
                      <span class="modpack-detail-author">
                        Created by <strong>{pack().author}</strong>
                      </span>
                    </Show>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div class="modal-body modpack-detail-body">
                {/* Description summary */}
                <p class="modpack-detail-summary">{pack().description}</p>

                {/* Key stats row */}
                <div class="modpack-detail-stats">
                  <div class="modpack-detail-stat">
                    <span class="modpack-detail-stat-label">
                      <IconDownload /> Downloads
                    </span>
                    <span class="modpack-detail-stat-value">
                      {formatDownloads(pack().downloads)}
                    </span>
                  </div>
                  <div class="modpack-detail-stat">
                    <Show
                      when={props.source === "curseforge"}
                      fallback={
                        <>
                          <span class="modpack-detail-stat-label">
                            <IconHeart /> Followers
                          </span>
                          <span class="modpack-detail-stat-value">
                            {formatDownloads(pack().follows)}
                          </span>
                        </>
                      }
                    >
                      <span class="modpack-detail-stat-label">
                        <IconClock /> Updated
                      </span>
                      <span class="modpack-detail-stat-value">
                        {formatDate(pack().date_modified) || "Recent"}
                      </span>
                    </Show>
                  </div>
                  <div class="modpack-detail-stat">
                    <span class="modpack-detail-stat-label">Game Versions</span>
                    <span class="modpack-detail-stat-value">
                      {formatVersionRange(pack().versions) || "Any"}
                      <Show when={versionCount() > 1}>
                        <span class="modpack-detail-stat-sub"> ({versionCount()} builds)</span>
                      </Show>
                    </span>
                  </div>
                  <div class="modpack-detail-stat">
                    <span class="modpack-detail-stat-label">Loaders</span>
                    <div class="modpack-detail-loaders-list">
                      <Show
                        when={loaders.length > 0}
                        fallback={<span class="modpack-detail-stat-value">Universal</span>}
                      >
                        <For each={loaders}>
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

                {/* Existing Installed Instances Banner */}
                <Show when={props.installedCount > 0}>
                  <div class="modpack-existing-notice">
                    <div class="modpack-existing-heading">
                      <IconCheck />
                      <span>
                        You already have <strong>{props.installedCount}</strong> instance(s) of this
                        modpack installed:
                      </span>
                    </div>
                    <div class="modpack-existing-list">
                      <For each={props.installedInstances}>
                        {(inst) => <span class="modpack-existing-item">• {inst.name}</span>}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Version Selector Section */}
                <div class="modpack-versions-section">
                  <div class="modpack-versions-header">
                    <span class="modpack-section-title">Available Versions</span>
                    <div class="modpack-version-filters">
                      {/* Channel filter pills */}
                      <div class="modpack-channel-pills">
                        <button
                          type="button"
                          class={`modpack-channel-pill ${channelFilter() === "all" ? "active" : ""}`}
                          onClick={() => setChannelFilter("all")}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          class={`modpack-channel-pill ${channelFilter() === "release" ? "active" : ""}`}
                          onClick={() => setChannelFilter("release")}
                        >
                          Release
                        </button>
                        <button
                          type="button"
                          class={`modpack-channel-pill ${channelFilter() === "beta" ? "active" : ""}`}
                          onClick={() => setChannelFilter("beta")}
                        >
                          Beta
                        </button>
                        <button
                          type="button"
                          class={`modpack-channel-pill ${channelFilter() === "alpha" ? "active" : ""}`}
                          onClick={() => setChannelFilter("alpha")}
                        >
                          Alpha
                        </button>
                      </div>

                      {/* Filter input */}
                      <div class="modpack-version-search">
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

                  {/* Version List Container */}
                  <div class="modpack-versions-list">
                    <Show when={loading()}>
                      <div class="modpack-versions-loading">
                        <div class="spinner-sm" />
                        <span>Fetching modpack versions...</span>
                      </div>
                    </Show>

                    <Show when={error()}>
                      <div class="modpack-versions-error">
                        <span>{error()}</span>
                      </div>
                    </Show>

                    <Show when={!loading() && !error() && filteredVersions().length === 0}>
                      <div class="modpack-versions-empty">
                        No versions match the current filters.
                      </div>
                    </Show>

                    <Show when={!loading() && !error() && filteredVersions().length > 0}>
                      <For each={filteredVersions()}>
                        {(v) => {
                          const isSelected = () => selectedVersionId() === v.id;
                          const channel = v.channel.toLowerCase();

                          return (
                            <div
                              class={`modpack-version-row ${isSelected() ? "selected" : ""}`}
                              onClick={() => setSelectedVersionId(v.id)}
                            >
                              <div class="modpack-vrow-left">
                                <div class="modpack-vrow-title-row">
                                  <span class="modpack-vrow-name">{v.name}</span>
                                  <span class={`modpack-vrow-channel channel-${channel}`}>
                                    {channelLabel(v.channel)}
                                  </span>
                                  <Show when={v.recommended}>
                                    <span class="modpack-vrow-recommended">Recommended</span>
                                  </Show>
                                </div>
                                <div class="modpack-vrow-meta">
                                  <span class="modpack-vrow-mc">
                                    MC {v.game_versions.join(", ") || "Any"}
                                  </span>
                                  <Show when={v.loaders.length > 0}>
                                    <span class="modpack-vrow-sep">·</span>
                                    <span class="modpack-vrow-loaders">
                                      {v.loaders.join(", ")}
                                    </span>
                                  </Show>
                                  <Show when={v.size > 0}>
                                    <span class="modpack-vrow-sep">·</span>
                                    <span class="modpack-vrow-size">{formatSize(v.size)}</span>
                                  </Show>
                                  <Show when={formatDate(v.date_published)}>
                                    <span class="modpack-vrow-sep">·</span>
                                    <span class="modpack-vrow-date">
                                      {formatDate(v.date_published)}
                                    </span>
                                  </Show>
                                </div>
                              </div>
                              <div class="modpack-vrow-right">
                                <button
                                  type="button"
                                  class="btn btn--sm btn--primary modpack-vrow-install"
                                  disabled={props.installing}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onInstall(pack(), v.id);
                                  }}
                                >
                                  {props.installing ? "Installing..." : "Install"}
                                </button>
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
              <div class="modal-footer modpack-detail-footer">
                <div class="modpack-footer-left">
                  <Show when={selectedVersionObj()}>
                    <span class="modpack-selected-indicator">
                      Selected: <strong>{selectedVersionObj()!.name}</strong>
                    </span>
                  </Show>
                </div>
                <div class="modpack-footer-actions">
                  <button
                    type="button"
                    class="btn modpack-footer-close-btn"
                    onClick={props.onClose}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    class="btn btn--primary"
                    disabled={props.installing}
                    onClick={() => {
                      props.onInstall(pack(), selectedVersionId() || undefined);
                    }}
                  >
                    {props.installing
                      ? "Installing..."
                      : selectedVersionObj()
                      ? `Install ${selectedVersionObj()!.name}`
                      : "Install Modpack"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default ModpackDetailModal;
