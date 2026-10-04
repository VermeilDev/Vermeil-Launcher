// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, createResource, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import {
  setActiveScreen,
  instances,
  showToast,
  setDockPagination,
  setDockHidden,
} from "../App";
import { enqueueModpack, isModpackQueuedOrActive } from "../services/modpackQueue";
import {
  searchModpacks,
  searchCurseforge,
  installModpack,
  installCfModpack,
  getGameVersions,
  getSettings,
  ModHit,
} from "../ipc/commands";
import Dropdown, { DropdownOption } from "../components/Dropdown";
import {
  IconModrinth,
  IconCurseForge,
  IconLayers,
  IconDownload,
  IconHeart,
  IconArrowLeft,
  IconSearch,
  IconX,
  IconCheck,
  IconGrid,
  IconList,
} from "../components/Icons";
import { formatDownloads, formatVersionRange } from "../lib/format";
import ModpackDetailModal from "./ModpackDetailModal";

const PAGE_SIZE = 12;

const LOADER_ORDER = ["fabric", "quilt", "neoforge", "forge"];
function extractLoaders(hit: ModHit): string[] {
  const cats = hit.categories ?? [];
  return LOADER_ORDER.filter((l) => cats.includes(l));
}

const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "downloads", label: "Most Downloaded" },
  { value: "follows", label: "Most Followed" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Recently Updated" },
];

const LOADER_OPTIONS = [
  { value: "", label: "All" },
  { value: "fabric", label: "Fabric" },
  { value: "neoforge", label: "NeoForge" },
  { value: "forge", label: "Forge" },
  { value: "quilt", label: "Quilt" },
];

const BrowseModpacks: Component = () => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ModHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [viewMode, setViewMode] = createSignal<"grid" | "cassette">("grid");
  const [confirmPack, setConfirmPack] = createSignal<{ pack: ModHit; versionId?: string } | null>(null);
  const [detailPack, setDetailPack] = createSignal<ModHit | null>(null);
  const [page, setPage] = createSignal(1);
  const [totalHits, setTotalHits] = createSignal(0);
  const [sortBy, setSortBy] = createSignal("relevance");
  const [loaderFilter, setLoaderFilter] = createSignal("");
  const [versionFilter, setVersionFilter] = createSignal("");
  const [modSource, setModSource] = createSignal<"modrinth" | "curseforge">("modrinth");

  const [gameVersionsList] = createResource(async () => {
    try {
      const s = await getSettings();
      return await getGameVersions(s.show_snapshots);
    } catch {
      return [];
    }
  });

  const versionOptions = createMemo((): DropdownOption[] => {
    const list = gameVersionsList() || [];
    const opts: DropdownOption[] = [{ value: "", label: "All" }];
    for (const v of list) {
      opts.push({ value: v.id, label: v.id });
    }
    return opts;
  });

  let searchTimeout: number | undefined;
  let searchToken = 0;

  const totalPages = () => Math.max(1, Math.ceil(totalHits() / PAGE_SIZE));

  const handleSourceSelect = (source: "modrinth" | "curseforge") => {
    if (modSource() === source) return;
    setModSource(source);
    setResults([]);
    setPage(1);
    doSearch(query(), 1);
  };

  const doSearch = async (q: string, p: number) => {
    const token = ++searchToken;
    setSearching(true);
    try {
      const offset = (p - 1) * PAGE_SIZE;
      const source = modSource();
      const result =
        source === "curseforge"
          ? await searchCurseforge(q, loaderFilter(), versionFilter(), offset, PAGE_SIZE, sortBy(), "modpack")
          : await searchModpacks(q, offset, PAGE_SIZE, sortBy(), loaderFilter(), versionFilter());

      if (token !== searchToken) return;
      setResults(result.hits);
      setTotalHits(result.total_hits);
    } catch (e) {
      if (token !== searchToken) return;
      console.error("Modpack search failed:", e);
      showToast({
        title: `${modSource() === "curseforge" ? "CurseForge" : "Modrinth"} search failed`,
        message: typeof e === "string" ? e : "Couldn't load modpacks — please try again.",
        type: "error",
      });
    } finally {
      if (token === searchToken) setSearching(false);
    }
  };

  const handleSearchInput = (q: string) => {
    setQuery(q);
    setPage(1);
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => doSearch(q, 1), 300);
  };

  const clearSearch = () => {
    setQuery("");
    setPage(1);
    doSearch("", 1);
  };

  let pageTimeout: number | undefined;

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages() || p === page()) return;
    setPage(p);
    clearTimeout(pageTimeout);
    pageTimeout = window.setTimeout(() => {
      doSearch(query(), p);
      const contentEl = document.querySelector(".content");
      if (contentEl) contentEl.scrollTo({ top: 0, behavior: "smooth" });
    }, 150);
  };

  const handleFilterChange = () => {
    setPage(1);
    doSearch(query(), 1);
  };

  // Initial load
  onMount(() => {
    setDockHidden(true);
    doSearch("", 1);
  });

  // Sync dock pagination
  createEffect(() => {
    if (totalPages() > 1) {
      setDockPagination({ current: page(), total: totalPages(), onPageChange: goPage });
    } else {
      setDockPagination(null);
    }
  });
  onCleanup(() => {
    setDockHidden(false);
    setDockPagination(null);
    clearTimeout(searchTimeout);
    clearTimeout(pageTimeout);
  });

  const getInstalledInstances = (projectId: string) =>
    (instances() || []).filter((i) => i.source_project_id === projectId);
  const getInstallCount = (projectId: string): number => getInstalledInstances(projectId).length;

  const handleInstallClick = (pack: ModHit, versionId?: string) => {
    if (getInstallCount(pack.project_id) > 0) {
      setConfirmPack({ pack, versionId });
    } else {
      doInstall(pack, versionId);
    }
  };

  const doInstall = (pack: ModHit, versionId?: string) => {
    setConfirmPack(null);

    enqueueModpack({
      projectId: pack.project_id,
      title: pack.title,
      category: "modpack",
      meta: {
        iconUrl: pack.icon_url,
        loader: extractLoaders(pack)[0] || "",
        gameVersion: formatVersionRange(pack.versions),
        versionNumber: pack.version_name ?? undefined,
        author: pack.author,
      },
      execute: () =>
        modSource() === "curseforge"
          ? installCfModpack(pack.project_id, versionId ?? pack.latest_version ?? undefined)
          : installModpack(pack.project_id, versionId),
    });
  };

  return (
    <div class="screen-enter browse-modpacks-screen">
      {/* Sticky Top Deck: Pinned Header Line + Unified 1-Row Toolbar */}
      <div class="modpack-sticky-deck">
        <div class="modpack-header-bar">
          <div class="modpack-header-left">
            <button
              type="button"
              class="btn modpack-back-btn"
              onClick={() => setActiveScreen("create-choose")}
            >
              <IconArrowLeft /> Back
            </button>
            <div class="modpack-title-line">
              <h1 class="modpack-title">Browse Modpacks</h1>
              <span class="tag-badge tag-badge--modpack">CURATED EXPERIENCES</span>
            </div>
          </div>
          <div class="modpack-header-count">
            <strong class="modpack-count-bold">{totalHits().toLocaleString()}</strong> modpacks found
          </div>
        </div>

        {/* Unified Sleek 1-Row Control Toolbar */}
        <div class="modpack-unified-toolbar">
          <div class="modpack-source-tabs">
            <button
              type="button"
              class={`modpack-source-tab tab-mr ${modSource() === "modrinth" ? "active" : ""}`}
              onClick={() => handleSourceSelect("modrinth")}
            >
              <IconModrinth />
              <span>Modrinth</span>
            </button>
            <button
              type="button"
              class={`modpack-source-tab tab-cf ${modSource() === "curseforge" ? "active" : ""}`}
              onClick={() => handleSourceSelect("curseforge")}
            >
              <IconCurseForge />
              <span>CurseForge</span>
            </button>
          </div>

          <div class="inst-search-input-wrap">
            <span class="inst-search-icon">
              <IconSearch />
            </span>
            <input
              type="text"
              class="field-control inst-search-input"
              placeholder={
                modSource() === "modrinth"
                  ? "Search Modrinth modpacks..."
                  : "Search CurseForge modpacks..."
              }
              value={query()}
              onInput={(e) => handleSearchInput(e.currentTarget.value)}
            />
            <Show when={query().length > 0}>
              <button
                type="button"
                class="inst-search-clear tip-below"
                onClick={clearSearch}
                data-tip="Clear search"
                aria-label="Clear search"
              >
                <IconX />
              </button>
            </Show>
          </div>

          <div class="modpack-toolbar-filters">
            <Dropdown
              prefix="Loader: "
              value={loaderFilter()}
              options={LOADER_OPTIONS}
              onChange={(v) => {
                setLoaderFilter(v);
                handleFilterChange();
              }}
              width="125px"
            />
            <Dropdown
              prefix="Version: "
              value={versionFilter()}
              options={versionOptions()}
              searchable={true}
              searchPlaceholder="Search versions..."
              emptyMessage="No matching versions"
              onChange={(v) => {
                setVersionFilter(v);
                handleFilterChange();
              }}
              width="140px"
            />
            <Dropdown
              prefix="Sort: "
              value={sortBy()}
              options={SORT_OPTIONS}
              onChange={(v) => {
                setSortBy(v);
                handleFilterChange();
              }}
              width="140px"
            />

            <div class="view-mode-tabs">
              <button
                type="button"
                class={`view-mode-btn tip-below ${viewMode() === "grid" ? "active" : ""}`}
                onClick={() => setViewMode("grid")}
                data-tip="Grid view"
                aria-label="Grid view"
              >
                <IconGrid />
              </button>
              <button
                type="button"
                class={`view-mode-btn tip-below ${viewMode() === "cassette" ? "active" : ""}`}
                onClick={() => setViewMode("cassette")}
                data-tip="Compact view"
                aria-label="Compact view"
              >
                <IconList />
              </button>
            </div>

            <Show when={query() || loaderFilter() || versionFilter() || sortBy() !== "relevance"}>
              <button
                type="button"
                class="btn inst-panel-btn inst-action-btn"
                onClick={() => {
                  setQuery("");
                  setLoaderFilter("");
                  setVersionFilter("");
                  setSortBy("relevance");
                  handleFilterChange();
                }}
              >
                Reset
              </button>
            </Show>
          </div>
        </div>
      </div>

      {/* Duplicate Instance Confirmation Dialog */}
      <Show when={confirmPack()}>
        <div class="modpack-confirm-banner panel panel--bracketed">
          <div class="modpack-confirm-content">
            <div class="modpack-confirm-msg">
              You already have <strong>{getInstallCount(confirmPack()!.pack.project_id)}</strong> instance(s)
              of <strong>{confirmPack()!.pack.title}</strong> installed:
            </div>
            <div class="modpack-confirm-instances">
              <For each={getInstalledInstances(confirmPack()!.pack.project_id)}>
                {(inst) => <span class="modpack-confirm-inst-tag">• {inst.name}</span>}
              </For>
            </div>
          </div>
          <div class="modpack-confirm-actions">
            <button
              type="button"
              class="btn btn--primary btn--sm"
              onClick={() => doInstall(confirmPack()!.pack, confirmPack()!.versionId)}
            >
              Install Another Instance
            </button>
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              onClick={() => setConfirmPack(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      {/* Results Container (Bento Grid or Bento Cassette) */}
      <div class="modpack-grid-container">
        <Show when={searching()}>
          <div class={viewMode() === "grid" ? "modpack-bento-grid" : "modpack-bento-cassette"}>
            <For each={Array.from({ length: PAGE_SIZE })}>
              {() => (
                <Show
                  when={viewMode() === "grid"}
                  fallback={
                    <div class="modpack-cassette-skeleton">
                      <div class="skeleton-icon" style="width: 44px; height: 44px;" />
                      <div class="skeleton-title-wrap" style="flex: 1;">
                        <div class="skeleton-line skeleton-title" />
                        <div class="skeleton-line skeleton-desc-1" />
                      </div>
                      <div class="skeleton-btn" style="width: 60px; height: 26px;" />
                    </div>
                  }
                >
                  <div class="modpack-card-skeleton">
                    <div class="skeleton-header">
                      <div class="skeleton-icon" />
                      <div class="skeleton-title-wrap">
                        <div class="skeleton-line skeleton-title" />
                        <div class="skeleton-line skeleton-author" />
                      </div>
                    </div>
                    <div class="skeleton-line skeleton-desc-1" />
                    <div class="skeleton-line skeleton-desc-2" />
                    <div class="skeleton-tags">
                      <div class="skeleton-tag" />
                      <div class="skeleton-tag" />
                    </div>
                    <div class="skeleton-footer">
                      <div class="skeleton-meta" />
                      <div class="skeleton-btn" />
                    </div>
                  </div>
                </Show>
              )}
            </For>
          </div>
        </Show>

        <Show when={!searching() && results().length === 0}>
          <div class="modpack-empty-panel panel panel--bracketed">
            <div class="modpack-empty-icon">
              <IconLayers />
            </div>
            <h3 class="modpack-empty-title">No Modpacks Found</h3>
            <p class="modpack-empty-desc">
              <Show
                when={query()}
                fallback={<>No results found for the selected loader and version filters.</>}
              >
                No modpacks match "<strong>{query()}</strong>". Try checking for spelling errors or
                removing filters.
              </Show>
            </p>
            <Show when={query() || loaderFilter() || versionFilter()}>
              <button
                type="button"
                class="btn btn--neutral btn--sm modpack-empty-reset"
                onClick={() => {
                  setQuery("");
                  setLoaderFilter("");
                  setVersionFilter("");
                  handleFilterChange();
                }}
              >
                Reset Filters
              </button>
            </Show>
          </div>
        </Show>

        <Show when={!searching() && results().length > 0}>
          <div class={viewMode() === "grid" ? "modpack-bento-grid" : "modpack-bento-cassette"}>
            <For each={results()}>
              {(pack) => {
                const count = () => getInstallCount(pack.project_id);
                const loaders = extractLoaders(pack);

                return (
                  <Show
                    when={viewMode() === "grid"}
                    fallback={
                      <div
                        class="modpack-cassette-card"
                        onClick={() => setDetailPack(pack)}
                      >
                        <div class="modpack-cassette-art">
                          <Show when={pack.icon_url} fallback={<IconLayers />}>
                            <img
                              src={pack.icon_url!}
                              alt=""
                              draggable={false}
                            />
                          </Show>
                        </div>
                        <div class="modpack-cassette-content">
                          <div class="modpack-cassette-top">
                            <span class="modpack-cassette-title">{pack.title}</span>
                            <Show when={pack.author}>
                              <span class="modpack-cassette-author">by {pack.author}</span>
                            </Show>
                            <Show when={count() > 0}>
                              <span class="badge badge--installed modpack-card-installed-badge">
                                <IconCheck /> Installed{count() > 1 ? ` (${count()})` : ""}
                              </span>
                            </Show>
                          </div>
                          <div class="modpack-cassette-desc">{pack.description}</div>
                          <div class="modpack-cassette-meta">
                            <For each={loaders}>
                              {(l) => (
                                <span class={`badge badge--loader badge--${l}`}>
                                  {l.charAt(0).toUpperCase() + l.slice(1)}
                                </span>
                              )}
                            </For>
                            <Show when={formatVersionRange(pack.versions)}>
                              <span class="badge badge--version">
                                {formatVersionRange(pack.versions)}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <div class="modpack-cassette-actions">
                          <div class="modpack-cassette-stats tip-left" data-tip="Downloads">
                            <IconDownload /> {formatDownloads(pack.downloads)}
                          </div>
                          <button
                            type="button"
                            class="btn btn--primary btn--sm modpack-card-install-btn"
                            disabled={isModpackQueuedOrActive(pack.project_id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleInstallClick(pack);
                            }}
                          >
                            {isModpackQueuedOrActive(pack.project_id) ? "Queued" : "Install"}
                          </button>
                        </div>
                      </div>
                    }
                  >
                    <div
                      class="modpack-card"
                      onClick={() => setDetailPack(pack)}
                    >
                      {/* Top card header */}
                      <div class="modpack-card-top">
                        <div class="modpack-card-icon">
                          <Show when={pack.icon_url} fallback={<IconLayers />}>
                            <img
                              src={pack.icon_url!}
                              alt=""
                              draggable={false}
                              class="modpack-card-img"
                            />
                          </Show>
                        </div>
                        <div class="modpack-card-info">
                          <div class="modpack-card-title">
                            {pack.title}
                          </div>
                          <Show when={pack.author}>
                            <div class="modpack-card-author">
                              by <span>{pack.author}</span>
                            </div>
                          </Show>
                        </div>
                        <Show when={count() > 0}>
                          <span class="badge badge--installed modpack-card-installed-badge">
                            <IconCheck /> Installed{count() > 1 ? ` (${count()})` : ""}
                          </span>
                        </Show>
                      </div>

                      {/* Description */}
                      <div class="modpack-card-desc">{pack.description}</div>

                      {/* Loader & version tags */}
                      <div class="modpack-card-tags">
                        <For each={loaders}>
                          {(l) => (
                            <span class={`badge badge--loader badge--${l}`}>
                              {l.charAt(0).toUpperCase() + l.slice(1)}
                            </span>
                          )}
                        </For>
                        <Show when={formatVersionRange(pack.versions)}>
                          <span class="badge badge--version">{formatVersionRange(pack.versions)}</span>
                        </Show>
                        <Show when={pack.version_name}>
                          <span class="badge badge--vnum">
                            {pack.version_name}
                          </span>
                        </Show>
                      </div>

                      {/* Footer */}
                      <div class="modpack-card-footer">
                        <div class="modpack-card-meta">
                          <span class="modpack-stat-item tip-below" data-tip="Downloads">
                            <IconDownload /> {formatDownloads(pack.downloads)}
                          </span>
                          <span class="modpack-stat-item tip-below" data-tip="Followers">
                            <IconHeart /> {formatDownloads(pack.follows)}
                          </span>
                        </div>
                        <div class="modpack-card-actions">
                          <button
                            type="button"
                            class="btn btn--primary btn--sm modpack-card-install-btn"
                            disabled={isModpackQueuedOrActive(pack.project_id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleInstallClick(pack);
                            }}
                          >
                            {isModpackQueuedOrActive(pack.project_id) ? "Queued" : "Install"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Expanded Modpack Detail Modal */}
      <ModpackDetailModal
        pack={detailPack()}
        source={modSource()}
        installedCount={getInstallCount(detailPack()?.project_id || "")}
        installedInstances={getInstalledInstances(detailPack()?.project_id || "")}
        installing={Boolean(detailPack() && isModpackQueuedOrActive(detailPack()!.project_id))}
        onClose={() => setDetailPack(null)}
        onInstall={(p, vId) => {
          setDetailPack(null);
          handleInstallClick(p, vId);
        }}
      />
    </div>
  );
};

export default BrowseModpacks;
