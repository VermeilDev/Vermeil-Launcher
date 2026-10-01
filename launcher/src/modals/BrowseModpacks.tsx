// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
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
  ModHit,
} from "../ipc/commands";
import Dropdown from "../components/Dropdown";
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
} from "../components/Icons";
import { formatDownloads, formatVersionRange } from "../lib/format";
import ModpackDetailModal from "./ModpackDetailModal";

const PAGE_SIZE = 12; // Strictly 4 columns x 3 rows

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
  const [confirmPack, setConfirmPack] = createSignal<{ pack: ModHit; versionId?: string } | null>(null);
  const [detailPack, setDetailPack] = createSignal<ModHit | null>(null);
  const [page, setPage] = createSignal(1);
  const [totalHits, setTotalHits] = createSignal(0);
  const [sortBy, setSortBy] = createSignal("relevance");
  const [loaderFilter, setLoaderFilter] = createSignal("");
  const [modSource, setModSource] = createSignal<"modrinth" | "curseforge">("modrinth");

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
          ? await searchCurseforge(q, loaderFilter(), "", offset, PAGE_SIZE, sortBy(), "modpack")
          : await searchModpacks(q, offset, PAGE_SIZE, sortBy(), loaderFilter());

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
      {/* Header plate */}
      <div class="modpack-header-bar">
        <div class="modpack-header-left">
          <button
            type="button"
            class="btn modpack-back-btn"
            onClick={() => setActiveScreen("create-choose")}
          >
            <IconArrowLeft /> Back
          </button>
          <div class="modpack-title-wrap">
            <div class="modpack-title-line">
              <h1 class="modpack-title">Browse Modpacks</h1>
              <span class="tag-badge tag-badge--modpack">CURATED EXPERIENCES</span>
            </div>
            <p class="modpack-subtitle">
              Discover and install community-crafted Minecraft modpacks from Modrinth and CurseForge.
            </p>
          </div>
        </div>

        <div class="modpack-header-right">
          <Show when={totalHits() > 0}>
            <div class="modpack-header-badges">
              <span class="modpack-total-pill">
                {totalHits().toLocaleString()} {totalHits() === 1 ? "pack" : "packs"} available
              </span>
              <Show when={totalPages() > 1}>
                <span class="modpack-page-pill">
                  Page {page()} of {totalPages()}
                </span>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Chunky 2-Row Control Panel (Matching Installed Content View) */}
      <div class="inst-search-panel">
        {/* Row 1: Source Toggle Tabs + Full-width Search Input + Optional Reset */}
        <div class="inst-search-row">
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
                  ? "Search Modrinth modpacks by name, category, or author..."
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

          <Show when={query() || loaderFilter() || sortBy() !== "relevance"}>
            <button
              type="button"
              class="btn inst-panel-btn inst-action-btn tip-right"
              onClick={() => {
                setQuery("");
                setLoaderFilter("");
                setSortBy("relevance");
                handleFilterChange();
              }}
              data-tip="Reset search and filters"
            >
              Reset
            </button>
          </Show>
        </div>

        {/* Row 2: Status Metadata on left · Loader & Sort Dropdowns on right */}
        <div class="inst-meta-row">
          <div class="inst-meta-left">
            Showing modpacks for{" "}
            <strong class="inst-meta-highlight">
              {modSource() === "curseforge" ? "CurseForge" : "Modrinth"}
            </strong>
            <span class="inst-meta-sep">·</span>
            <strong class="inst-meta-highlight">
              {loaderFilter()
                ? loaderFilter().charAt(0).toUpperCase() + loaderFilter().slice(1)
                : "All Loaders"}
            </strong>
            <Show when={totalHits() > 0}>
              <span class="inst-meta-sep">—</span>
              <span class="inst-meta-count">{totalHits().toLocaleString()} available</span>
            </Show>
          </div>

          <div class="inst-meta-sort-wrap" style="gap: 8px">
            <Dropdown
              prefix="Loader: "
              value={loaderFilter()}
              options={LOADER_OPTIONS}
              onChange={(v) => {
                setLoaderFilter(v);
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
              width="160px"
            />
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

      {/* 4x3 Results Grid */}
      <div class="modpack-grid-container">
        <Show when={searching()}>
          <div class="modpack-grid-4x3">
            <For each={Array.from({ length: 12 })}>
              {() => (
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
                fallback={<>No results found for the selected loader filter.</>}
              >
                No modpacks match "<strong>{query()}</strong>". Try checking for spelling errors or
                removing filters.
              </Show>
            </p>
            <Show when={query() || loaderFilter()}>
              <button
                type="button"
                class="btn btn--neutral btn--sm modpack-empty-reset"
                onClick={() => {
                  setQuery("");
                  setLoaderFilter("");
                  handleFilterChange();
                }}
              >
                Reset Filters
              </button>
            </Show>
          </div>
        </Show>

        <Show when={!searching() && results().length > 0}>
          <div class="modpack-grid-4x3">
            <For each={results()}>
              {(pack) => {
                const count = () => getInstallCount(pack.project_id);
                const loaders = extractLoaders(pack);

                return (
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
                        <span class="badge badge--vnum tip-below" data-tip={`Latest build: ${pack.version_name!}`}>
                          {pack.version_name}
                        </span>
                      </Show>
                    </div>

                    {/* Footer */}
                    <div class="modpack-card-footer">
                      <div class="modpack-card-meta">
                        <span class="modpack-stat-item tip-below" data-tip="Total Downloads">
                          <IconDownload /> {formatDownloads(pack.downloads)}
                        </span>
                        <span class="modpack-stat-item tip-below" data-tip="Followers / Favorites">
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
