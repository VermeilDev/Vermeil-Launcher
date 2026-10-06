// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import {
  setActiveScreen,
  setActiveInstanceId,
  activeInstanceId,
  setInitialInstanceTab,
  instances,
  refetchInstances,
  refreshPinnedInstanceIds,
  pinnedInstanceIds,
  downloads,
  currentThemeLogo,
  ensureAccountOrPrompt,
  gameRunning,
  setGameRunning,
  launchingInstanceId,
  setLaunchingInstanceId,
  clearGameLogs,
  showToast,
} from "../App";
import {
  InstanceSummary,
  deleteInstances,
  getSettings,
  launchInstance,
  stopInstance,
  getRecentScreenshots,
  getInstancesStorageFootprint,
  openFilePath,
  openAppDirectory,
  openInstanceFolder,
  ScreenshotEntry,
} from "../ipc/commands";
import {
  IconPlus,
  IconPlay,
  IconModrinth,
  IconCurseForge,
  IconX,
  IconSearch,
  IconTrash2,
  IconFolderOpen,
  IconDownload,
  IconPin,
  IconCamera,
  IconHardDrive,
} from "../components/Icons";
import Dropdown from "../components/Dropdown";
import SelectionDock from "../components/SelectionDock";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";
import { resolveAssetUrl } from "../lib/assets";
import { formatMemoryGb, formatSize } from "../lib/format";
import { openPinInstancesModal } from "../modals/PinInstancesModal";

/** Library sort modes. Persisted in localStorage so the choice sticks between
 *  sessions (a pure view preference — kept out of the launcher settings file to
 *  avoid a full settings round-trip / clobber risk from this screen). */
type LibrarySort = "played" | "mostPlayed" | "created" | "name";
const SORT_STORAGE_KEY = "vermeil.librarySort";
const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "played", label: "Recently played" },
  { value: "mostPlayed", label: "Most played" },
  { value: "created", label: "Recently created" },
  { value: "name", label: "Name (A–Z)" },
];

/** Epoch ms from an ISO date string, or 0 when absent/unparseable (so
 *  never-played / missing dates sort last in a descending order). */
function epoch(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function bannerColor(loader: string): string {
  switch (loader) {
    case "fabric": return "fabric";
    case "quilt": return "quilt";
    case "neoforge": return "blue";
    case "forge": return "orange";
    default: return "green"; // vanilla
  }
}

/**
 * Resolve an instance's banner icon. We treat the literal `"cube"` value as
 * the sentinel "no real icon, fall back to the loader badge" because that's
 * what the backend writes for instances created without an `icon_url`.
 */
function instanceIconUrl(inst: { icon: string }): string | undefined {
  return resolveAssetUrl(inst.icon);
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never played";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function formatPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

const Library: Component = () => {
  const [selectMode, setSelectMode] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [deleteInput, setDeleteInput] = createSignal("");
  const [isDeleting, setIsDeleting] = createSignal(false);

  const [search, setSearch] = createSignal("");
  const [loaderFilter, setLoaderFilter] = createSignal("all");

  // Escape exits multi-select mode or clears search
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (selectMode()) {
        setSelectMode(false);
        setSelected(new Set<string>());
        setShowDeleteConfirm(false);
        setDeleteInput("");
      } else if (search()) {
        setSearch("");
      }
    }
  };
  onMount(() => document.addEventListener("keydown", handleKey));
  onCleanup(() => document.removeEventListener("keydown", handleKey));

  // Sort mode, seeded from localStorage so it persists across sessions.
  const storedSort = (typeof localStorage !== "undefined" && localStorage.getItem(SORT_STORAGE_KEY)) as LibrarySort | null;
  const [sortBy, setSortBy] = createSignal<LibrarySort>(
    SORT_OPTIONS.some(o => o.value === storedSort) ? (storedSort as LibrarySort) : "played"
  );
  const changeSort = (v: string) => {
    setSortBy(v as LibrarySort);
    try { localStorage.setItem(SORT_STORAGE_KEY, v); } catch { /* non-fatal */ }
  };

  // Comparator for active sort mode
  const compare = (a: InstanceSummary, b: InstanceSummary): number => {
    switch (sortBy()) {
      case "mostPlayed": return (b.total_play_seconds || 0) - (a.total_play_seconds || 0);
      case "created": return epoch(b.created_at) - epoch(a.created_at);
      case "name": return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
      case "played":
      default: return epoch(b.last_played) - epoch(a.last_played);
    }
  };

  const allList = () => instances() ?? [];
  const pinnedSet = () => new Set(pinnedInstanceIds());

  const totalPlaySeconds = createMemo(() => {
    return allList().reduce((acc, i) => acc + (i.total_play_seconds || 0), 0);
  });

  const pinnedList = createMemo(() => {
    const pSet = pinnedSet();
    return allList().filter(i => pSet.has(i.id)).sort(compare);
  });

  const unpinnedList = createMemo(() => {
    const pSet = pinnedSet();
    return allList().filter(i => !pSet.has(i.id)).sort(compare);
  });

  const totalModsCount = createMemo(() => {
    return allList().reduce((acc, i) => acc + (i.mod_count || 0), 0);
  });

  const [recentScreenshots, setRecentScreenshots] = createSignal<ScreenshotEntry[]>([]);
  const [storageFootprint, setStorageFootprint] = createSignal<number>(0);
  const [activeScreenshot, setActiveScreenshot] = createSignal<ScreenshotEntry | null>(null);
  const [companionEnabled, setCompanionEnabled] = createSignal<boolean>(true);

  const loadBentoTelemetry = async () => {
    try {
      const [shots, size, s] = await Promise.all([
        getRecentScreenshots(50),
        getInstancesStorageFootprint(),
        getSettings().catch(() => null),
      ]);
      setRecentScreenshots(shots);
      setStorageFootprint(size);
      if (s) {
        setCompanionEnabled(s.enable_companion_mod ?? true);
      }
    } catch (e) {
      console.error("Failed to load library telemetry:", e);
    }
  };

  const setupDeckWheel = (el: HTMLDivElement) => {
    const handleWheel = (e: WheelEvent) => {
      if (el.scrollWidth > el.clientWidth) {
        e.preventDefault();
        e.stopPropagation();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        el.scrollLeft += delta;
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    onCleanup(() => el.removeEventListener("wheel", handleWheel));
  };

  onMount(() => {
    loadBentoTelemetry();

    const onSettingsChanged = async () => {
      try {
        const s = await getSettings();
        setCompanionEnabled(s.enable_companion_mod ?? true);
      } catch { /* non-fatal */ }
    };

    window.addEventListener("vermeil-settings-changed", onSettingsChanged);

    let unlistenCloud: (() => void) | undefined;
    listen("cloud-settings-synced", onSettingsChanged).then((fn) => {
      unlistenCloud = fn;
    });

    onCleanup(() => {
      window.removeEventListener("vermeil-settings-changed", onSettingsChanged);
      unlistenCloud?.();
    });
  });

  // Unique loaders among installed instances for dynamic filter pills
  const availableLoaders = createMemo(() => {
    const set = new Set<string>();
    for (const inst of allList()) {
      set.add((inst.loader?.type || "vanilla").toLowerCase());
    }
    return Array.from(set).sort();
  });

  // Filtered instances
  const filteredInstances = createMemo(() => {
    let list = [...allList()];
    const q = search().trim().toLowerCase();
    const lFilter = loaderFilter().toLowerCase();

    if (q) {
      list = list.filter(inst =>
        (inst.name || "").toLowerCase().includes(q) ||
        (inst.game_version || "").toLowerCase().includes(q) ||
        (inst.loader?.type || "").toLowerCase().includes(q)
      );
    }

    if (lFilter === "pinned") {
      const pSet = pinnedSet();
      list = list.filter(inst => pSet.has(inst.id));
    } else if (lFilter === "played") {
      list = list.filter(inst => (inst.total_play_seconds || 0) > 0 || Boolean(inst.last_played));
    } else if (lFilter === "unplayed") {
      list = list.filter(inst => !inst.last_played && (!inst.total_play_seconds || inst.total_play_seconds === 0));
    } else if (lFilter !== "all") {
      list = list.filter(inst => (inst.loader?.type || "vanilla").toLowerCase() === lFilter);
    }

    list.sort(compare);
    return list;
  });

  // Transient drag-select state
  let dragStartId: string | null = null;
  let dragExtended = false;

  const toggleSelect = (id: string) => {
    const s = new Set(selected());
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  const deleteSelected = async () => {
    const ids = Array.from(selected());
    if (ids.length === 0) return;

    setIsDeleting(true);
    try {
      await deleteInstances(ids);
      if (activeInstanceId() && ids.includes(activeInstanceId()!)) {
        setActiveInstanceId(null);
      }
      setSelected(new Set<string>());
      setSelectMode(false);
      setShowDeleteConfirm(false);
      setDeleteInput("");
      refetchInstances();
      refreshPinnedInstanceIds().catch(() => {});
    } catch (e) {
      console.error("Batch delete failed:", e);
    } finally {
      setIsDeleting(false);
    }
  };

  const openInstance = (inst: InstanceSummary) => {
    if (selectMode()) { toggleSelect(inst.id); return; }
    setActiveInstanceId(inst.id);
    setInitialInstanceTab("content");
    setActiveScreen("mods");
  };

  const isInstanceInstalling = (inst: InstanceSummary) => {
    return downloads().some(
      (d) =>
        d.status === "downloading" &&
        (d.instanceId ? d.instanceId === inst.id : d.category === "instance" && d.name === inst.name)
    );
  };

  const isGameRunningThis = (instId: string) => gameRunning() && activeInstanceId() === instId;
  const isLaunchingThis = (instId: string) => launchingInstanceId() === instId;

  const handleQuickPlay = async (e: MouseEvent, inst: InstanceSummary) => {
    e.stopPropagation();
    if (selectMode()) return;
    if (launchingInstanceId()) {
      showToast({ title: "Launching in progress", message: "Please wait for the current launch to finish.", type: "info" });
      return;
    }
    if (isGameRunningThis(inst.id)) {
      try {
        await stopInstance();
        setGameRunning(false);
      } catch (err) {
        showToast({ title: "Stop failed", message: String(err), type: "error" });
      }
      return;
    }
    if (!ensureAccountOrPrompt()) return;
    if (isInstanceInstalling(inst)) {
      showToast({ title: "Installing", message: "Please wait for installation to finish", type: "info" });
      return;
    }
    if (gameRunning()) {
      showToast({ title: "Game already running", message: "Another game instance is currently active. Please close it first.", type: "info" });
      return;
    }
    setActiveInstanceId(inst.id);
    setLaunchingInstanceId(inst.id);
    setGameRunning(true);
    clearGameLogs(inst.id);
    try {
      await launchInstance(inst.id);
    } catch (err) {
      setGameRunning(false);
      showToast({ title: "Launch failed", message: String(err), type: "error" });
    } finally {
      setLaunchingInstanceId(null);
    }
  };

  const renderInstanceCard = (inst: InstanceSummary) => (
    <div
      class={`card--inst ${selectMode() && selected().has(inst.id) ? "inst-card-selected" : ""}`}
      style={{
        cursor: "pointer",
        opacity: isDeleting() && selected().has(inst.id) ? "0.4" : "1",
      }}
      onClick={() => {
        if (selectMode() && dragExtended) {
          dragExtended = false;
          dragStartId = null;
          return;
        }
        openInstance(inst);
        dragStartId = null;
      }}
      onMouseDown={(e) => {
        if (selectMode() && e.button === 0) {
          dragStartId = inst.id;
          dragExtended = false;
        }
      }}
      onMouseEnter={(e) => {
        if (selectMode() && e.buttons === 1 && dragStartId && dragStartId !== inst.id) {
          const s = new Set(selected());
          if (dragStartId && !s.has(dragStartId)) {
            s.add(dragStartId);
          }
          if (!s.has(inst.id)) {
            s.add(inst.id);
          }
          setSelected(s);
          dragExtended = true;
        }
      }}
    >
      {/* Flush Left Square Thumbnail */}
      <div class={`inst-card-thumb inst-card-icon ${bannerColor(inst.loader?.type || "vanilla")}`}>
        <Show when={instanceIconUrl(inst)} fallback={
          <span class="inst-card-thumb-letter">{(inst.name || "?").trim().charAt(0).toUpperCase() || "?"}</span>
        }>
          <img
            src={instanceIconUrl(inst)!}
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </Show>
        <Show when={!selectMode()}>
          <div
            class={`inst-card-play-overlay ${isGameRunningThis(inst.id) || isLaunchingThis(inst.id) ? "is-running" : ""}`}
            onClick={(e) => handleQuickPlay(e, inst)}
            data-tip={isLaunchingThis(inst.id) ? "Launching..." : isGameRunningThis(inst.id) ? "Stop game" : isInstanceInstalling(inst) ? "Installing..." : `Play ${inst.name}`}
          >
            <div class={`inst-card-play-btn ${isGameRunningThis(inst.id) ? "btn--running" : ""} ${isLaunchingThis(inst.id) ? "btn--disabled" : ""}`}>
              <Show when={isLaunchingThis(inst.id)}>
                <IconDownload />
              </Show>
              <Show when={!isLaunchingThis(inst.id)}>
                <Show when={isGameRunningThis(inst.id)} fallback={
                  <Show when={isInstanceInstalling(inst)} fallback={<IconPlay />}>
                    <IconDownload />
                  </Show>
                }>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={selectMode()}>
          <div class={`inst-card-check ${selected().has(inst.id) ? "is-selected" : ""}`}>
            <Show when={selected().has(inst.id)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </Show>
          </div>
        </Show>
      </div>

      {/* Right Content Area: Title, Subtitle, Badges */}
      <div class="inst-card-body">
        <div class="inst-card-title" data-tip={inst.name}>
          {inst.name}
        </div>
        <div class="inst-card-sub">
          <Show
            when={isInstanceInstalling(inst)}
            fallback={`${inst.mod_count} ${inst.mod_count === 1 ? "mod" : "mods"} · ${timeAgo(inst.last_played)}`}
          >
            Downloading game files...
          </Show>
        </div>
        <div class="inst-card-badges">
          <div class="inst-card-badges-track">
            <Show when={isInstanceInstalling(inst)}>
              <span class="badge badge--installing">
                <IconDownload />
                Installing...
              </span>
            </Show>
            <Show when={pinnedSet().has(inst.id)}>
              <span
                class="badge badge--pinned tip-below"
                data-tip="Pinned to dock"
                style="cursor: pointer;"
                onClick={(e) => {
                  e.stopPropagation();
                  openPinInstancesModal();
                }}
              >
                <IconPin />
              </span>
            </Show>
            <span class="badge badge--version">{inst.game_version}</span>
            <span class={`badge badge--loader ${loaderBadgeClass(inst.loader?.type || "vanilla")}`}>
              {loaderLabel(inst.loader?.type || "vanilla")}
            </span>
            <span class="badge badge--ram">
              {formatMemoryGb(inst.java?.memory_max_mb)}
            </span>

            {(() => {
              const hasUnplayed = !inst.last_played && (!inst.total_play_seconds || inst.total_play_seconds === 0);
              const hasVnum = Boolean(inst.source_project_id && inst.source_version);
              const hasSource = (inst.source_platforms || []).length > 0;
              const isCurseForge = hasSource && inst.source_platforms[0] === "curseforge";
              const hasCompanion = Boolean(inst.ingame_cape_supported);

              const extraCount = (hasUnplayed ? 1 : 0) + (hasVnum ? 1 : 0) + (hasSource ? 1 : 0) + (hasCompanion ? 1 : 0);

              if (extraCount <= 1) {
                return (
                  <>
                    <Show when={hasUnplayed}>
                      <span class="badge badge--unplayed">Unplayed</span>
                    </Show>
                    <Show when={hasVnum}>
                      <span class="badge badge--vnum tip-below" data-tip={`Pack version ${inst.source_version}`}>
                        {inst.source_version}
                      </span>
                    </Show>
                    <Show when={hasSource}>
                      <span
                        class={`badge badge--source ${isCurseForge ? "badge--curseforge" : "badge--modrinth"} tip-below`}
                        data-tip={isCurseForge ? "CurseForge" : "Modrinth"}
                      >
                        {isCurseForge ? <IconCurseForge /> : <IconModrinth />}
                      </span>
                    </Show>
                    <Show when={hasCompanion}>
                      <span class="badge badge--companion tip-below" data-tip="Companion mod">
                        <img src="/logo.png" alt="Vermeil" draggable={false} />
                      </span>
                    </Show>
                  </>
                );
              }

              return (
                <span class="badge badge--overflow-pill" onClick={(e) => e.stopPropagation()}>
                  +{extraCount}
                  <div class="badge-popover" onClick={(e) => e.stopPropagation()}>
                    <Show when={hasUnplayed}>
                      <span class="badge badge--unplayed">Unplayed</span>
                    </Show>
                    <Show when={hasVnum}>
                      <span class="badge badge--vnum" data-tip={`Pack version ${inst.source_version}`}>
                        {inst.source_version}
                      </span>
                    </Show>
                    <Show when={hasSource}>
                      <span class={`badge badge--source ${isCurseForge ? "badge--curseforge" : "badge--modrinth"}`}>
                        {isCurseForge ? <IconCurseForge /> : <IconModrinth />}
                        <span>{isCurseForge ? "CurseForge" : "Modrinth"}</span>
                      </span>
                    </Show>
                    <Show when={hasCompanion}>
                      <span class="badge badge--companion">
                        <img src="/logo.png" alt="Vermeil" draggable={false} />
                        <span>Companion</span>
                      </span>
                    </Show>
                  </div>
                </span>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div class="screen-enter library-screen">
      {/* ═══ EMPTY STATE: Shown when 0 instances exist in the entire launcher ═══ */}
      <Show when={allList().length === 0}>
        <div class="library-header" style="margin-bottom: 16px;">
          <div class="page-title">Library</div>
          <div class="library-header-meta">
            <span>0 instances</span>
            <span>·</span>
            <span>Workspace ready</span>
          </div>
        </div>

        <div class="empty-bento-layout">
          {/* Main Bento Launchpad Hero Card (Centered Solo) */}
          <div class="empty-launchpad-card">
            <div class="bento-card-header">
              <div class="bento-card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
                <span>Instance Launchpad</span>
              </div>
            </div>

            <div class="empty-launchpad-body">
              {/* Ambient floating theme logo emblem */}
              <img src={currentThemeLogo()} alt="Vermeil" class="empty-logo-glow" draggable={false} />

              {/* Content with Animated Ellipsis */}
              <div class="empty-hero-content">
                <div class="empty-status-line">
                  <span class="card-section-tag tag-settings-accent">STANDBY</span>
                  <span>
                    Ready for first deployment<span class="animated-ellipsis"><span>.</span><span>.</span><span>.</span></span>
                  </span>
                </div>
                <h2 class="empty-launchpad-title">Your Library is Ready to Launch</h2>
                <p class="empty-launchpad-desc">
                  Click below to configure a custom Minecraft instance, browse community modpacks, or import an existing archive.
                </p>
              </div>

              {/* Single Primary CTA Button */}
              <div class="empty-action-row">
                <button
                  class="btn-create-hero"
                  onClick={() => setActiveScreen("create-choose")}
                >
                  <IconPlus />
                  <span>Create Instance</span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>

              <div class="empty-tip-footer">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>Tip: Drag &amp; drop any <code>.mrpack</code> or <code>.zip</code> file anywhere into Vermeil to import instantly</span>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* ═══ MAIN LIBRARY VIEW: Shown when user has 1+ instances ═══ */}
      <Show when={allList().length > 0}>
        {/* Header with Title, Telemetry & Toolbar */}
        <div class="library-header">
          <div class="library-header-top">
            <div>
              <div class="page-title">Library</div>
              <div class="library-header-meta">
                <span>{allList().length} {allList().length === 1 ? "instance" : "instances"}</span>
                <span>·</span>
                <span
                  class="library-meta-link tip-below"
                  data-tip="Manage pins"
                  onClick={openPinInstancesModal}
                >
                  {pinnedList().length} pinned
                </span>
                <span>·</span>
                <span>{formatPlaytime(totalPlaySeconds())} played</span>
              </div>
            </div>

            <div class="library-toolbar">
              <div class="library-search">
                <IconSearch />
                <input
                  type="text"
                  class="library-search-input"
                  placeholder="Filter instances..."
                  value={search()}
                  onInput={(e) => setSearch(e.currentTarget.value)}
                />
                <Show when={search()}>
                  <button class="library-search-clear" onClick={() => setSearch("")}>
                    <IconX />
                  </button>
                </Show>
              </div>

              <Dropdown
                value={sortBy()}
                options={SORT_OPTIONS}
                onChange={changeSort}
                width="150px"
              />

              <button
                class="btn tip-below tip-right"
                data-tip={selectMode() ? "Cancel" : "Select to delete"}
                onClick={() => {
                  setSelectMode(!selectMode());
                  setSelected(new Set<string>());
                  setShowDeleteConfirm(false);
                }}
              >
                {selectMode() ? <IconX /> : <IconTrash2 />}
              </button>
            </div>
          </div>

          {/* Filter Pills */}
          <div class="library-filter-pills">
            <button
              class={`library-filter-pill ${loaderFilter() === "all" ? "active" : ""}`}
              onClick={() => setLoaderFilter("all")}
            >
              All ({allList().length})
            </button>
            <Show when={pinnedList().length > 0}>
              <button
                class={`library-filter-pill ${loaderFilter() === "pinned" ? "active" : ""}`}
                onClick={() => setLoaderFilter("pinned")}
              >
                <IconPin />
                <span>Pinned ({pinnedList().length})</span>
              </button>
            </Show>
            <button
              class={`library-filter-pill ${loaderFilter() === "played" ? "active" : ""}`}
              onClick={() => setLoaderFilter("played")}
            >
              Played
            </button>
            <button
              class={`library-filter-pill ${loaderFilter() === "unplayed" ? "active" : ""}`}
              onClick={() => setLoaderFilter("unplayed")}
            >
              Unplayed
            </button>
            <For each={availableLoaders()}>
              {(loader) => (
                <button
                  class={`library-filter-pill ${loaderFilter() === loader ? "active" : ""}`}
                  onClick={() => setLoaderFilter(loader)}
                >
                  {loaderLabel(loader)}
                </button>
              )}
            </For>
          </div>
        </div>

        {/* ═══ SHELF 1: PINNED FAVORITES (Shown when browsing default view & pins exist) ═══ */}
        <Show when={!search() && loaderFilter() === "all" && pinnedList().length > 0}>
          <div class="library-section-shelf">
            <div class="section-label section-label--row">
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="card-section-tag tag-settings-accent">PINNED FAVORITES ({pinnedList().length})</span>
                <span style="color:var(--text-muted);font-size:var(--fs-xs);">Quick-launch on floating dock</span>
              </div>
              <button class="btn btn--sm btn--subtle" onClick={openPinInstancesModal}>
                <IconPin />
                <span>Manage Pins</span>
              </button>
            </div>

            <div class="card-grid">
              <For each={pinnedList()}>
                {(inst) => renderInstanceCard(inst)}
              </For>
              <Show when={pinnedList().length < 6}>
                <div
                  class="add-card"
                  onClick={openPinInstancesModal}
                >
                  <div class="add-card-thumb">
                    <IconPin />
                  </div>
                  <div class="add-card-body">
                    <span class="add-card-title">Pin instance</span>
                    <span class="add-card-sub">Quick dock access</span>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* ═══ SHELF 2: OTHER INSTANCES (OR SEARCH/FILTER RESULTS) ═══ */}
        <div class="library-section-shelf">
          <div class="section-label section-label--row">
            <Show when={search() || loaderFilter() !== "all"} fallback={
              <Show when={pinnedList().length > 0} fallback={
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="card-section-tag tag-settings-cloud">ALL INSTANCES ({allList().length})</span>
                  <span style="color:var(--text-muted);font-size:var(--fs-xs);">Complete library</span>
                </div>
              }>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="card-section-tag tag-settings-cloud">OTHER INSTANCES ({unpinnedList().length})</span>
                  <span style="color:var(--text-muted);font-size:var(--fs-xs);">Standard library</span>
                </div>
              </Show>
            }>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="card-section-tag tag-settings-cloud">RESULTS ({filteredInstances().length})</span>
                <span style="color:var(--text-muted);font-size:var(--fs-xs);">
                  Matching "{search() || loaderFilter()}"
                </span>
              </div>
              <button
                class="btn btn--xs btn--ghost"
                onClick={() => { setSearch(""); setLoaderFilter("all"); }}
              >
                Clear Filters
              </button>
            </Show>
          </div>

          <Show
            when={Boolean(search() || loaderFilter() !== "all")}
            fallback={
              <div class="card-grid">
                <For each={pinnedList().length > 0 ? unpinnedList() : allList()}>
                  {(inst) => renderInstanceCard(inst)}
                </For>

                {/* Add instance card */}
                <div class="add-card" onClick={() => setActiveScreen("create-choose")}>
                  <div class="add-card-thumb">
                    <IconPlus />
                  </div>
                  <div class="add-card-body">
                    <span class="add-card-title">New instance</span>
                    <span class="add-card-sub">Create or import</span>
                  </div>
                </div>
              </div>
            }
          >
            <Show
              when={filteredInstances().length > 0}
              fallback={
                <div style="padding:var(--space-6);text-align:center;background:var(--surface-panel);border:1px dashed var(--border);color:var(--text-muted);font-size:var(--fs-sm);">
                  No instances match your filter.
                  <button
                    class="btn btn--xs btn--neutral"
                    style="margin-left:var(--space-2);"
                    onClick={() => { setSearch(""); setLoaderFilter("all"); }}
                  >
                    Reset Filters
                  </button>
                </div>
              }
            >
              <div class="card-grid">
                <For each={filteredInstances()}>
                  {(inst) => renderInstanceCard(inst)}
                </For>

                <div class="add-card" onClick={() => setActiveScreen("create-choose")}>
                  <div class="add-card-thumb">
                    <IconPlus />
                  </div>
                  <div class="add-card-body">
                    <span class="add-card-title">New instance</span>
                    <span class="add-card-sub">Create or import</span>
                  </div>
                </div>
              </div>
            </Show>
          </Show>
        </div>

        {/* ═══ BENTO SECONDARY DECK (RECENT SCREENSHOTS + TELEMETRY HUB) ═══ */}
        <div class="library-bento-grid">
          {/* Bento Card 1: Recent Screenshots */}
          <div class="bento-card">
            <div class="bento-card-header">
              <div class="bento-card-title">
                <IconCamera />
                <span>Recent Screenshots</span>
              </div>
              <Show when={recentScreenshots().length > 0}>
                <span class="bento-badge">{recentScreenshots().length} CAPTURED</span>
              </Show>
            </div>
            <div class="bento-card-body">
              <Show
                when={recentScreenshots().length > 0}
                fallback={
                  <div class="screenshots-empty">
                    <div class="screenshots-empty-badge">
                      <IconCamera class="screenshots-empty-icon" />
                    </div>
                    <div class="screenshots-empty-title">No Screenshots Captured Yet</div>
                    <div class="screenshots-empty-sub">
                      Press <strong style="color:var(--accent);">F2</strong> anytime in-game to snap moments. They will automatically aggregate here across all your instances.
                    </div>
                  </div>
                }
              >
                <div class="screenshots-deck" ref={setupDeckWheel}>
                  <For each={recentScreenshots()}>
                    {(shot) => (
                      <div class="screenshot-item" onClick={() => setActiveScreenshot(shot)}>
                        <div class="screenshot-thumb-box">
                          <img src={resolveAssetUrl(shot.path)} alt={shot.file_name} loading="lazy" />
                          <div class="screenshot-overlay">
                            <IconSearch />
                          </div>
                        </div>
                        <div class="screenshot-meta">
                          <span class="screenshot-inst-tag">{shot.instance_name}</span>
                          <span class="screenshot-time">{timeAgo(new Date(shot.modified_ms).toISOString())}</span>
                        </div>
                      </div>
                    )}
                  </For>
                  {/* Single onion-skin ghost slot next to the oldest screenshot inviting new snaps */}
                  <div
                    class="screenshot-item screenshot-item--placeholder"
                  >
                    <div class="screenshot-placeholder-box">
                      <IconCamera />
                      <span class="screenshot-placeholder-key">F2</span>
                    </div>
                    <div class="screenshot-meta">
                      <span class="screenshot-inst-tag" style="color:var(--text-muted);font-weight:500;">Snap Next</span>
                      <span class="screenshot-time">Ready</span>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>

          {/* Bento Card 2: Library Hub Telemetry */}
          <div class="bento-card">
            <div class="bento-card-header">
              <div class="bento-card-title">
                <IconHardDrive />
                <span>Library Hub</span>
              </div>
              <span class="bento-badge">TELEMETRY</span>
            </div>
            <div class="bento-card-body">
              <div class="telemetry-stack">
                <div class="telemetry-row">
                  <span class="telemetry-label">Active Storage</span>
                  <span class="telemetry-value">
                    {storageFootprint() > 0 ? formatSize(storageFootprint()) : "0 B"}
                  </span>
                </div>
                <div class="telemetry-row">
                  <span class="telemetry-label">Total Content Installed</span>
                  <span class="telemetry-value">
                    {totalModsCount()} {totalModsCount() === 1 ? "item" : "items"}
                  </span>
                </div>
                <div class={`telemetry-row ${!companionEnabled() ? "telemetry-row--muted" : ""}`}>
                  <span class="telemetry-label">Companion Mod</span>
                  <span
                    class="telemetry-value"
                    style={{
                      color: companionEnabled() ? "var(--accent)" : "var(--text-muted)",
                      cursor: "default",
                    }}
                  >
                    {companionEnabled() ? "Active · Managed" : "Disabled"}
                  </span>
                </div>
              </div>

              <div class="quick-actions-grid">
                <button class="btn-action" onClick={() => setActiveScreen("create-modpack")}>
                  <IconDownload />
                  <span>Browse Modpacks</span>
                </button>
                <button class="btn-action" onClick={() => setActiveScreen("create-import")}>
                  <IconFolderOpen />
                  <span>Import .mrpack / .zip</span>
                </button>
                <button class="btn-action" onClick={() => openAppDirectory()}>
                  <IconFolderOpen />
                  <span>Open Vermeil Folder</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Floating action bar — appears at bottom-center when in select mode. */}
      <Show when={selectMode()}>
        <SelectionDock
          count={selected().size}
          mode="delete"
          primaryLabel={isDeleting() ? "Deleting..." : (showDeleteConfirm() ? "Delete All" : "Delete")}
          primaryDisabled={showDeleteConfirm() ? (deleteInput() !== "Confirm" || isDeleting()) : (selected().size === 0 || isDeleting())}
          primaryLoading={isDeleting()}
          onPrimary={async () => {
            if (showDeleteConfirm()) {
              await deleteSelected();
            } else {
              const settings = await getSettings();
              if (settings.force_delete) {
                await deleteSelected();
              } else {
                setShowDeleteConfirm(true);
              }
            }
          }}
          onClear={() => {
            if (showDeleteConfirm()) {
              setShowDeleteConfirm(false);
              setDeleteInput("");
            } else {
              setSelectMode(false);
              setSelected(new Set<string>());
            }
          }}
          clearLabel="Cancel"
          icon={<IconTrash2 />}
        >
          <Show when={showDeleteConfirm()}>
            <input
              class="field-control field-control--text"
              style="max-width:110px;height:28px;font-size:12px;border-color:var(--danger);padding:2px 8px;"
              placeholder="Type Confirm"
              value={deleteInput()}
              onInput={(e) => setDeleteInput(e.currentTarget.value)}
            />
          </Show>
        </SelectionDock>
      </Show>

      {/* ═══ SCREENSHOT LIGHTBOX OVERLAY ═══ */}
      <Show when={activeScreenshot()}>
        {(shot) => (
          <div class="lightbox-overlay active" onClick={() => setActiveScreenshot(null)}>
            <div class="lightbox-box" onClick={(e) => e.stopPropagation()}>
              <div class="lightbox-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="card-section-tag tag-settings-accent">SCREENSHOT VIEWER</span>
                  <span style="font-size: 12px; font-weight: 700; color: #fff;">
                    {shot().instance_name} · {timeAgo(new Date(shot().modified_ms).toISOString())}
                  </span>
                </div>
                <button class="btn btn--sm btn--neutral" onClick={() => setActiveScreenshot(null)}>
                  <IconX />
                  <span>Close</span>
                </button>
              </div>
              <div class="lightbox-image-wrap">
                <img src={resolveAssetUrl(shot().path)} alt={shot().file_name} />
              </div>
              <div class="lightbox-footer">
                <span>{shot().file_name} · {formatSize(shot().size_bytes)}</span>
                <div style="display: flex; gap: 8px;">
                  <button
                    class="btn btn--sm btn--neutral"
                    onClick={() => openFilePath(shot().path)}
                  >
                    <span>Open Full Size</span>
                  </button>
                  <button
                    class="btn btn--sm btn--subtle"
                    onClick={() => openInstanceFolder(shot().instance_id, "screenshots")}
                  >
                    <IconFolderOpen />
                    <span>Open Folder</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default Library;
