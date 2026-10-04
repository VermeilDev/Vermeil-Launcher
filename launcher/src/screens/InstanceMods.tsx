// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, createMemo, createResource, untrack, For, Show, onMount, onCleanup } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { setActiveScreen, instances, activeInstanceId, setActiveInstanceId, refetchInstances, refreshPinnedInstanceIds, pinnedInstanceIds, initialInstanceTab, gameRunning, setGameRunning, clearGameLogs, completeDownload, failDownload, startBulkBatch, endBulkBatch, showToast, gameLogsFor, setDockHidden, setDockPagination, logsPoppedOut, currentTheme, ensureAccountOrPrompt, downloads, launchingInstanceId, setLaunchingInstanceId } from "../App";
import { reportDependencyIssues, DependencyIssue } from "../components/DependencyIssuesModal";
import { contentVersion } from "../lib/contentVersion";
import { loaderLabel, loaderBadgeClass, loaderBannerColor } from "../lib/loader";
import Dropdown, { DropdownOption } from "../components/Dropdown";
import ModDetailModal from "../modals/ModDetailModal";
import ChangeLoaderModal, { openChangeLoaderModal } from "../modals/ChangeLoaderModal";
import { openPinInstancesModal } from "../modals/PinInstancesModal";
import { formatDownloads, formatSize, formatVersionRange } from "../lib/format";
import { searchMods, installModToInstance, installCfModToInstance, listInstanceFiles, listInstanceWorlds, openInstanceFolder, deleteInstance, renameInstance, updateInstanceOptions, toggleModInInstance, removeModFromInstance, removeModsFromInstance, checkModUpdates, applyModUpdate, ModUpdate, cloneInstance, getSettings, saveSettings, setInstanceIcon, clearInstanceIcon, searchCurseforge, getPresetJvmArgs, getKnownPresetArgs, getSystemMemory, getEffectiveMemory, EffectiveMemory, ModHit, FileEntry, WorldEntry, closeLogsWindow, syncInstanceMods, setInstanceCompanionEnabled, getInstance, exportShareCode, getModVersions, getCfModFiles, launchInstance, stopInstance, getGameVersions } from "../ipc/commands";
import { IconArrowLeft, IconBolt, IconMonitor, IconGlobe, IconTrash, IconTrash2, IconArrowUp, IconArrowDown, IconSearch, IconModrinth, IconCurseForge, IconSettings, IconCube, IconWand, IconShirt, IconX, IconCheck, IconAlertTriangle, IconFolderOpen, IconLayers, IconImage, IconDownload, IconHeart, IconShare2, IconPin, IconPackage, IconPlay, IconRefresh, IconGrid, IconList, IconShuffle } from "../components/Icons";
import SelectionDock from "../components/SelectionDock";
import TactileSwitch from "../components/TactileSwitch";
import { enqueueInstallTask, isTaskQueuedOrActive, isTaskActive, isTaskQueued } from "../services/modpackQueue";

import { resolveAssetUrl } from "../lib/assets";

const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "downloads", label: "Downloads" },
  { value: "follows", label: "Follows" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Updated" },
];
/**
 * Column-aware page size for the server-paged Browse grid — see
 * `lib/gridPageSize.ts`.
 */
type InstanceTab = "content" | "files" | "worlds" | "logs" | "settings";

/**
 * Resolve the best icon URL for a mod entry / installed item.
 *
 * Prefers `local_icon_path` when set (a disk path or cached URL — works offline,
 * no CDN re-hit). Falls back to the remote `icon_url` for items that haven't been
 * re-cached yet. Returns `undefined` if neither is available so the caller can
 * render its own fallback glyph.
 */
function resolveIconUrl(item: { local_icon_path?: string | null; icon_url?: string | null }): string | undefined {
  return resolveAssetUrl(item.local_icon_path) || (item.icon_url ? item.icon_url : undefined);
}

const CODE_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt", "rift", "liteloader", "risugami", "modloader"]);

/**
 * Detect the target install category for a search hit when browsing with the
 * "all" filter active. Checks the explicit `project_type` returned by Modrinth
 * / CurseForge, falling back to category keywords in the hit's metadata.
 *
 * Modrinth assigns `project_type: "mod"` to datapacks. On Vanilla instances
 * (or for projects lacking code loader tags), items tagged with "datapack"
 * are classified as "datapack" so they render with the correct badge and install
 * into the world's datapack directory instead of failing as jar mods.
 */
function detectCategory(mod: ModHit, currentLoader?: string): "mod" | "resourcepack" | "shader" | "datapack" {
  if (mod.project_type === "resourcepack" || mod.project_type === "shader" || mod.project_type === "datapack") {
    return mod.project_type;
  }
  const cats = mod.categories || [];
  if (cats.some(c => c.toLowerCase().includes("shader"))) return "shader";
  if (cats.some(c => c.toLowerCase().includes("resource") || c.toLowerCase().includes("texture"))) return "resourcepack";
  if (cats.some(c => c.toLowerCase().includes("data") || c.toLowerCase().includes("datapack"))) {
    const loader = currentLoader?.toLowerCase();
    if (!loader || loader === "vanilla" || !cats.some(c => CODE_LOADERS.has(c.toLowerCase()))) {
      return "datapack";
    }
  }
  return "mod";
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case "resourcepack": return "Resource Pack";
    case "shader": return "Shader";
    case "datapack": return "Datapack";
    default: return "Mod";
  }
}

/**
 * Test whether a mod search hit claims compatibility with the target instance.
 *
 * For resource packs and shaders, only Minecraft version compatibility applies.
 * For mods, loader compatibility is also validated.
 */
function checkModCompatibility(
  mod: ModHit,
  gameVersion: string,
  loader: string,
  category: string
): boolean {
  if (!mod.versions || mod.versions.length === 0) {
    // No version metadata available; let backend decide
    return true;
  }

  const stripPre = (s: string) => s.split(/-pre|-rc|-experimental|-snapshot|-beta|-alpha/)[0];
  const targetBase = stripPre(gameVersion);

  const matchesGameVersion = mod.versions.some(v => v === gameVersion || stripPre(v) === targetBase);
  if (!matchesGameVersion) {
    return false;
  }

  // Loader check for mods/datapacks
  if (category === "mod" && loader && loader !== "vanilla") {
    const knownLoaders = ["fabric", "forge", "neoforge", "quilt"];
    const modLoaders = (mod.categories || []).map(c => c.toLowerCase()).filter(c => knownLoaders.includes(c));
    if (modLoaders.length > 0) {
      const targetLoader = loader.toLowerCase();
      if (targetLoader === "quilt" && (modLoaders.includes("quilt") || modLoaders.includes("fabric"))) {
        return true;
      }
      if (!modLoaders.includes(targetLoader)) {
        return false;
      }
    }
  }

  return true;
}

function formatPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "0m";
  if (seconds < 60) return "< 1m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function isInstalledModCompatible(mod: any, instanceLoaderType?: string): boolean {
  if (!instanceLoaderType || (mod.category || "mod") !== "mod") return true;
  if (instanceLoaderType === "vanilla") return false;
  const loaders = mod.loaders as string[] | undefined;
  if (!loaders || loaders.length === 0) return true;
  const target = instanceLoaderType.toLowerCase();
  if (target === "quilt") {
    return loaders.some((l) => {
      const lower = l.toLowerCase();
      return lower === "quilt" || lower === "fabric";
    });
  }
  return loaders.some((l) => l.toLowerCase() === target);
}

function getInstalledModDisplayLoader(mod: any, instanceLoaderType?: string): string {
  const loaders = mod.loaders as string[] | undefined;
  if (loaders && loaders.length > 0) {
    if (instanceLoaderType) {
      const target = instanceLoaderType.toLowerCase();
      const match = loaders.find((l) => l.toLowerCase() === target);
      if (match) return match;
      if (target === "quilt" && loaders.some((l) => l.toLowerCase() === "fabric")) {
        return "fabric";
      }
    }
    return loaders[0];
  }
  return instanceLoaderType || "mod";
}

const InstanceMods: Component = () => {
  const [mainTab, setMainTab] = createSignal<InstanceTab>(initialInstanceTab() as InstanceTab || "content");
  const [viewMode, setViewMode] = createSignal<"grid" | "compact">("grid");

  const instance = () => {
    const list = instances();
    const id = activeInstanceId();
    if (!list || !id) return list?.[0] || null;
    return list.find(i => i.id === id) || list[0] || null;
  };

  // Full instance detail (with mods array). The global instances() resource
  // now returns InstanceSummary (mod_count only) to keep IPC lean. This
  // separate fetch loads the complete mod list for the active instance only.
  const [instanceDetail, { refetch: refetchDetail }] = createResource(
    () => activeInstanceId() || instance()?.id || null,
    async (id) => {
      if (!id) return null;
      try { return await getInstance(id); } catch { return null; }
    },
  );
  /** Shorthand: mods from the full detail, or empty array. */
  const instanceMods = () => instanceDetail()?.mods || [];

  const [settings] = createResource(getSettings);

  // When the instance summary's mod count changes, automatically refresh detail
  createEffect(() => {
    const inst = instance();
    if (inst) {
      void inst.mod_count;
      untrack(() => refetchDetail());
    }
  });

  const isCurrentInstanceInstalling = () => {
    const id = activeInstanceId() || instance()?.id;
    if (!id) return false;
    return downloads().some(
      (d) =>
        d.status === "downloading" &&
        (d.instanceId ? d.instanceId === id : d.category === "instance" && d.name === instances()?.find((i) => i.id === id)?.name)
    );
  };

  const isGameRunningThis = () => gameRunning() && activeInstanceId() === instance()?.id;
  const isLaunchingThis = () => launchingInstanceId() === instance()?.id;

  const handlePlayOrStop = async () => {
    const inst = instance();
    if (!inst) return;
    if (launchingInstanceId()) {
      showToast({ title: "Launching in progress", message: "Please wait for the current launch to finish.", type: "info" });
      return;
    }
    if (isGameRunningThis()) {
      try {
        await stopInstance();
        setGameRunning(false);
      } catch (err) {
        showToast({ title: "Stop failed", message: String(err), type: "error" });
      }
      return;
    }
    if (!ensureAccountOrPrompt()) return;
    if (isCurrentInstanceInstalling()) {
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

  // Per-instance memory. Adaptive by default (services/memory.rs); an instance
  // can opt out via `java.adaptive_override` and set RAM manually. `effectiveMemory`
  // holds the resolved value + formula breakdown for the read-only display; the
  // adaptive cap lives in Settings → Resources. Refreshed on tab/instance change
  // and after mod install/remove.
  const [systemMemoryMb] = createResource(getSystemMemory);
  const [effectiveMemory, setEffectiveMemory] = createSignal<EffectiveMemory | null>(null);
  const refreshAdaptive = async () => {
    const id = activeInstanceId();
    if (!id) return;
    try {
      setEffectiveMemory(await getEffectiveMemory(id));
    } catch {
      // Best-effort — leave the previous value.
    }
  };

  // Manual-memory slider state (used when an instance turns adaptive off).
  // The draft mirrors the slider while dragging so the GB label updates
  // instantly; the actual save is debounced to avoid instance.json write races.
  const manualMax = (): number => Math.max((systemMemoryMb() || 16384) - 2048, 4096);
  // Recommended-RAM guidance shown under the manual slider, by allocation tier.
  const memoryHint = (mb: number): { text: string; color: string } => {
    if (mb <= 1024) return { text: "Very low — may struggle with vanilla", color: "var(--danger)" };
    if (mb <= 2048) return { text: "Minimum for vanilla Minecraft", color: "var(--muted)" };
    if (mb <= 4096) return { text: "Good for vanilla and light modpacks", color: "var(--success)" };
    if (mb <= 6144) return { text: "Recommended for most modpacks", color: "var(--success)" };
    if (mb <= 8192) return { text: "Good for large modpacks (100+ mods)", color: "var(--success)" };
    if (mb <= 12288) return { text: "High — only needed for heavy modpacks", color: "var(--warn)" };
    return { text: "Very high — may cause GC stuttering", color: "var(--danger)" };
  };
  // Breakdown rows in GB. Two decimals (trailing zeros trimmed) so the rows
  // visibly sum to the pack total — every contribution is 256 MB-aligned, so
  // this is precise enough to verify the arithmetic at a glance.
  const formatMemGb = (mb: number): string =>
    `${(mb / 1024).toFixed(2).replace(/\.?0+$/, "")} GB`;
  const formatBreakdownGb = (mb: number): string =>
    `${(mb / 1024).toFixed(2)} GB`;
  const getBreakdownCategory = (label: string): { tag: string; cls: string } => {
    const l = label.toLowerCase();
    if (l.includes("base")) return { tag: "BASE", cls: "base" };
    if (l.includes("runtime") || l.includes("fabric") || l.includes("forge") || l.includes("loader")) return { tag: "LOADER", cls: "loader" };
    if (l.includes("mod")) return { tag: "MODS", cls: "mods" };
    if (l.includes("shader") || l.includes("iris") || l.includes("optifine")) return { tag: "SHADERS", cls: "shaders" };
    if (l.includes("resource") || l.includes("pack")) return { tag: "ASSETS", cls: "assets" };
    return { tag: "SYS", cls: "base" };
  };
  const [memoryDraft, setMemoryDraft] = createSignal<number | null>(null);
  const memoryValue = (): number => memoryDraft() ?? instance()?.java?.memory_max_mb ?? 4096;
  createEffect(() => {
    const inst = instance();
    const draft = memoryDraft();
    if (inst && draft !== null && inst.java.memory_max_mb === draft) setMemoryDraft(null);
  });
  let memorySaveTimer: number | undefined;
  const commitMemory = (instanceId: string, mb: number) => {
    if (memorySaveTimer !== undefined) clearTimeout(memorySaveTimer);
    memorySaveTimer = window.setTimeout(() => {
      memorySaveTimer = undefined;
      updateInstanceOptions(instanceId, { memoryMaxMb: mb })
        .then(() => refetchInstances())
        .catch((err) => showToast({ title: "Failed to save memory", message: String(err), type: "error" }));
    }, 200);
  };
  // Flip adaptive on/off for this instance. Optimistic: the toggle moves
  // immediately. The write lands in the background; on failure we refetch to
  // revert the visual to the real state.
  const [adaptiveOptimistic, setAdaptiveOptimistic] = createSignal<boolean | null>(null);
  // Resolved adaptive state: optimistic override beats the instance resource.
  const isAdaptive = (): boolean => {
    const opt = adaptiveOptimistic();
    if (opt !== null) return opt;
    return !instance()?.java?.adaptive_override;
  };
  // Clear the optimistic flag once the resource catches up.
  createEffect(() => {
    const inst = instance();
    const opt = adaptiveOptimistic();
    if (inst && opt !== null && (!inst.java.adaptive_override) === opt) setAdaptiveOptimistic(null);
  });

  // A write is in flight. Clicks are ignored until it settles so two
  // read-modify-write calls on the same instance.json can't land out of order
  // and leave the stored value disagreeing with what the toggle shows.
  // ponytail: ignoring the click is the cheap guard. Ceiling — a click inside
  // the (short) write window is dropped rather than queued. Upgrade path if
  // that ever annoys: remember the desired final state and re-issue one write
  // when the in-flight one finishes (last-write-wins coalescing).
  const [adaptiveBusy, setAdaptiveBusy] = createSignal(false);

  const toggleAdaptive = async () => {
    const inst = instance();
    if (!inst || adaptiveBusy()) return;
    // Derive the next state from the *resolved* value, not the raw resource.
    // The resource lags the write, so reading it here made a second click
    // recompute the same direction and re-apply the same value.
    const turningOff = isAdaptive(); // automatic currently on → going manual
    const seed = turningOff ? (effectiveMemory()?.value_mb ?? inst.java.memory_max_mb) : undefined;
    // Optimistic: flip the toggle instantly. When going manual, seed the slider
    // draft in the same tick — the slider renders immediately, and without the
    // draft it would show the stale stored value and then jump once the write
    // lands (the seed exists precisely to avoid a stale starting point).
    setAdaptiveBusy(true);
    setAdaptiveOptimistic(!turningOff);
    if (seed) setMemoryDraft(seed);
    try {
      await updateInstanceOptions(inst.id, { adaptiveOverride: turningOff, ...(seed ? { memoryMaxMb: seed } : {}) });
      await refetchInstances();
      await refreshAdaptive();
    } catch (e) {
      showToast({ title: "Failed to change memory mode", message: String(e), type: "error" });
      // Revert both optimistic values and pull the real state back.
      setAdaptiveOptimistic(null);
      setMemoryDraft(null);
      await refetchInstances();
    } finally {
      setAdaptiveBusy(false);
    }
  };


  // React to external tab change requests (e.g., from Home settings button)
  createEffect(() => {
    const tab = initialInstanceTab();
    if (tab) setMainTab(tab as InstanceTab);
  });

  // Keep the local "installed" cache in sync with the actual mods list.
  // Without this, bulk-delete or single-remove would leave Browse-tab
  // "Installed" badges stale until the page is reloaded.
  createEffect(() => {
    const mods = instanceMods();
    const ids = new Set<string>(mods.map((m: any) => m.project_id).filter(Boolean));
    setLocalInstalled(ids);
  });

  const [contentTab, setContentTab] = createSignal<"installed" | "browse">("installed");
  const [installedFilter, setInstalledFilter] = createSignal<"all" | "mod" | "resourcepack" | "shader" | "datapack">("all");
  // Installed tab: search + sort. Sort defaults to newest-first because users
  // most often want to find what they just installed. The Vec<ModEntry> from
  // backend is in install order (push at end), so newest = reversed list.
  const [installedSearch, setInstalledSearch] = createSignal("");
  const [installedSort, setInstalledSort] = createSignal<"newest" | "oldest">("newest");
  // Installed content renders its full filtered list (client-side, scrollable) —
  // no pagination or page-size control. The canonical `.card-grid` handles reflow.

  // Map of project_id → ModUpdate. Populated by `checkModUpdates` whenever the
  // Installed tab is opened so each card can render an "Update" pill without
  // a per-card network round-trip.
  const [modUpdates, setModUpdates] = createSignal<Map<string, ModUpdate>>(new Map());
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);

  // Refresh the update map. Runs on:
  //  - Installed tab activation
  //  - After a successful update (so the row's pill goes away)
  //  - Manual user refresh button
  // The check is best-effort: network failures are logged but don't show a
  // toast because most users won't care that an update probe failed.
  const refreshUpdates = async (interactive = false) => {
    const inst = instance();
    if (!inst) return;
    if (inst.mod_count === 0) {
      setModUpdates(new Map());
      return;
    }
    setCheckingUpdates(true);
    try {
      const map = await checkModUpdates(inst.id);
      setModUpdates(new Map(Object.entries(map)));
      if (interactive) {
        const count = Object.keys(map).length;
        showToast({
          title: count === 0 ? "Up to date" : `${count} update${count === 1 ? "" : "s"} available`,
          message:
            count === 0
              ? "Every installed item is on its latest compatible version."
              : "Click the green pill on a card to upgrade.",
          type: count === 0 ? "info" : "success",
          autoCloseMs: 3500,
        });
      }
    } catch (e) {
      console.error("Update check failed:", e);
      if (interactive) {
        showToast({
          title: "Update check failed",
          message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
          type: "error",
          autoCloseMs: 5000,
        });
      }
    } finally {
      setCheckingUpdates(false);
    }
  };
  const [browseFilter, setBrowseFilter] = createSignal<"all" | "mod" | "resourcepack" | "shader" | "datapack">("all");
  const [browseVersion, setBrowseVersion] = createSignal<string>("");

  const [gameVersionsList] = createResource(async () => {
    try {
      const s = await getSettings();
      return await getGameVersions(s.show_snapshots);
    } catch {
      return [];
    }
  });

  const browseVersionOptions = createMemo((): DropdownOption[] => {
    const inst = instance();
    const instVersion = inst?.game_version || "";
    const all = gameVersionsList() || [];

    const opts: DropdownOption[] = [];

    if (instVersion) {
      opts.push({
        value: "",
        label: `${instVersion} (Current)`,
        badge: "Current",
      });
    }

    opts.push({
      value: "any",
      label: "All Versions",
    });

    for (const v of all) {
      if (v.id === instVersion) continue;
      opts.push({
        value: v.id,
        label: v.id,
      });
    }

    return opts;
  });

  const handleBrowseVersionChange = (newVer: string) => {
    setBrowseVersion(newVer);
    setCurrentPage(1);
    clearTimeout(searchTimeout);
    doSearch(1);
  };
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<ModHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const displayBrowseResults = () => searchResults();
  const [totalHits, setTotalHits] = createSignal(0);
  const [currentPage, setCurrentPage] = createSignal(1);
  const [sortBy, setSortBy] = createSignal("relevance");
  // Browse and Installed are paged at a fixed 4 columns by 3 rows
  // (12 items per page) matching BrowseModpacks for consistency and visual unity.
  const PAGE_SIZE = 12;
  const [installedPage, setInstalledPage] = createSignal(1);
  const [modSource, setModSource] = createSignal<"modrinth" | "curseforge">("modrinth");
  /** Browse result shown in the detail overlay, if any. */
  const [detailMod, setDetailMod] = createSignal<ModHit | null>(null);

  interface IncompatiblePrompt {
    mod: ModHit;
    category: string;
    gameVersion: string;
    loader: string;
    latestVersionId?: string;
    latestVersionName?: string;
    supportedVersions: string[];
    resolvingVersion: boolean;
  }
  const [incompatiblePrompt, setIncompatiblePrompt] = createSignal<IncompatiblePrompt | null>(null);

  const [localInstalled, setLocalInstalled] = createSignal<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = createSignal(false);
  const [deleteCountdown, setDeleteCountdown] = createSignal(5);
  const [cloning, setCloning] = createSignal(false);
  // Batch delete / select mode in Installed tab (mirrors Library select mode)
  const [installedSelectMode, setInstalledSelectMode] = createSignal(false);
  const [selectedInstalled, setSelectedInstalled] = createSignal<Set<string>>(new Set());
  const [isDeletingInstalled, setIsDeletingInstalled] = createSignal(false);

  // Bulk select state
  const [selectMode, setSelectMode] = createSignal(false);
  const [selectedItems, setSelectedItems] = createSignal<Map<string, { mod: ModHit; category: string }>>(new Map());
  const [bulkInstalling, setBulkInstalling] = createSignal(false);

  // Quick instance switcher dropdown in context header
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  let switcherRef: HTMLDivElement | undefined;
  {
    const handleClickOutside = (e: MouseEvent) => {
      if (switcherOpen() && switcherRef && !switcherRef.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    onMount(() => document.addEventListener("mousedown", handleClickOutside));
    onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));
  }

  // Escape exits multi-select mode in the Browse tab or dismisses compatibility prompt
  {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (incompatiblePrompt()) {
          setIncompatiblePrompt(null);
          return;
        }
        if (selectMode()) {
          setSelectMode(false);
          setSelectedItems(new Map());
          return;
        }
      }
    };
    onMount(() => document.addEventListener("keydown", handleKey));
    onCleanup(() => document.removeEventListener("keydown", handleKey));
  }

  // Files tab state
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [filePath, setFilePath] = createSignal<string | undefined>(undefined);

  // Worlds tab state
  const [worlds, setWorlds] = createSignal<WorldEntry[]>([]);

  // Logs tab state. The actual log buffer lives at App level keyed by
  // instance ID (`gameLogs` map in App.tsx) so it persists across screen
  // navigation AND stays scoped to the right instance — viewing instance B's
  // Logs tab no longer shows instance A's output. Filters and search are
  // component-local since they're per-view UI state.
  const logs = () => gameLogsFor(activeInstanceId());
  const [logFilters, setLogFilters] = createSignal<Set<string>>(new Set(["all"]));
  /** Substring search across log lines. Empty string disables the filter. */
  const [logSearch, setLogSearch] = createSignal("");

  // Auto-scroll state for the Logs tab. True = follow new output (snap to
  // bottom on each new line). Flips to false when the user scrolls up to
  // read earlier output, and back to true when they return to the bottom.
  const [autoScrollLogs, setAutoScrollLogs] = createSignal(true);
  let viewerEl: HTMLDivElement | undefined;
  let isProgrammaticScroll = false;
  let programmaticScrollTimeout: number | undefined;

  const scrollTo = (top: number, autoFollow: boolean) => {
    if (!viewerEl) return;
    setAutoScrollLogs(autoFollow);
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
    setAutoScrollLogs(distance < 40);
  };

  // Auto-scroll to bottom when new log lines arrive while following
  createEffect(() => {
    if (mainTab() !== "logs") return;
    const count = filteredLogs().length;
    if (count > 0 && autoScrollLogs() && viewerEl && !isProgrammaticScroll) {
      requestAnimationFrame(() => {
        if (viewerEl && autoScrollLogs() && !isProgrammaticScroll) {
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

  // Hide the floating dock while on the instance screen so it doesn't cover
  // cards, controls, or log output. The dock still reveals on cursor-near-bottom.
  createEffect(() => {
    setDockHidden(true);
  });
  onCleanup(() => setDockHidden(false));

  // Dock pagination is set up after goToPage is defined (see below).
  onCleanup(() => setDockPagination(null));

  // Refresh the update map whenever the Installed tab is opened or the
  // instance's mod list actually changes. We only run while the tab is visible
  // to avoid surprise network calls in the background.
  //
  // The dependency is a primitive key, NOT `instance()`. Reading the instance
  // object directly made this effect re-run on every `refetchInstances()` —
  // including an enabled/disabled flip, which doesn't change the mod list at
  // all. That fired a full Modrinth + CurseForge probe for every installed mod
  // on each toggle click (rate-limit abuse), and the resulting `checkingUpdates`
  // flip resized the "Check updates" label, which shifted the whole search row.
  // A memo only notifies when its value actually differs, so a toggle is now a
  // no-op here. Count goes first so the "no mods" test is a leading-integer
  // check that can't be confused by an id containing a colon.
  //
  // MUST stay below `const instance` — createMemo evaluates its body eagerly on
  // creation (unlike createEffect, which is deferred), so declaring it earlier
  // hits the temporal dead zone on `instance` and throws during setup.
  const updateCheckKey = createMemo(() => {
    const inst = instance();
    return inst ? `${inst.mod_count}:${inst.id}` : "";
  });
  createEffect(() => {
    const key = updateCheckKey();
    if (mainTab() !== "content" || contentTab() !== "installed") return;
    if (!key || key.startsWith("0:")) {
      setModUpdates(new Map());
      return;
    }
    // untrack: refreshUpdates reads `instance()` internally, which would
    // otherwise re-widen this effect's dependency back to the whole resource.
    untrack(() => refreshUpdates());
  });

  // Reconcile mods the user dropped into the instance's mods/ folder by hand
  // into the tracked list so they show up in the Installed tab. Runs whenever
  // the open instance changes; refetchInstances surfaces any newly-found mods.
  // (refetchInstances doesn't change activeInstanceId, so this can't loop.)
  createEffect(() => {
    const id = activeInstanceId();
    if (!id) return;
    syncInstanceMods(id).then(() => { refetchInstances(); refetchDetail(); }).catch(() => {});
  });

  // Java args editor. Displays the effective GC flags in an editable
  // textarea. If the user has custom `extra_args` saved, those are shown.
  // If `extra_args` is empty, we pre-fill with the current GC preset flags
  // (so the user sees what's being applied and can edit from there).
  // Whatever is in the editor at blur is what the backend uses at launch —
  // `extra_args` overrides the preset when non-empty.
  //
  // Preset stickiness fix: `extra_args` saved during a previous global GC
  // preset would otherwise pin the instance to those exact flags forever
  // (the launch path uses `extra_args` verbatim when non-empty, ignoring
  // the global preset). We resolve every known preset's flags up-front and
  // treat `extra_args` as "no override" when it matches *any* of them. That
  // way switching the global preset in Settings actually propagates: the
  // next time the user opens the editor, they see the new preset's flags,
  // and on blur we save empty `extra_args` so launches stay live too.
  const [extraArgsText, setExtraArgsText] = createSignal("");
  const [knownPresets, setKnownPresets] = createSignal<Record<string, string[]>>({});
  const [globalPreset, setGlobalPreset] = createSignal<string>("g1gc");
  // Bumped when the global GC preset changes (Settings fires the event after the
  // save lands). The args effect reads it so the editor re-derives even if this
  // screen was already mounted when the preset changed.
  const [gcTick, setGcTick] = createSignal(0);
  onMount(() => {
    const onGcChange = () => setGcTick((t) => t + 1);
    window.addEventListener("vermeil-gc-preset-changed", onGcChange);
    onCleanup(() => window.removeEventListener("vermeil-gc-preset-changed", onGcChange));
  });
  let gutterRef: HTMLDivElement | undefined;

  // Instance name editing in settings tab
  const [nameDraft, setNameDraft] = createSignal("");
  const [renaming, setRenaming] = createSignal(false);

  createEffect(() => {
    const inst = instance();
    if (inst) setNameDraft(inst.name);
  });

  const handleSaveName = async () => {
    const inst = instance();
    const trimmed = nameDraft().trim();
    if (!inst || !trimmed || trimmed === inst.name) return;
    setRenaming(true);
    try {
      await renameInstance(inst.id, trimmed);
      await refetchInstances();
      showToast({
        title: "Instance renamed",
        message: `Updated name to "${trimmed}".`,
        type: "success",
        autoCloseMs: 2500,
      });
    } catch (e: any) {
      showToast({
        title: "Failed to rename",
        message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
        type: "error",
      });
    } finally {
      setRenaming(false);
    }
  };

  /** Display label for a preset ID — matches the strings in Settings.tsx. */
  const presetLabel = (id: string): string => {
    if (id === "g1gc") return "Client G1GC";
    if (id === "zgc") return "Generational ZGC";
    if (id === "shenandoah") return "Adaptive Shenandoah";
    return id.toUpperCase();
  };

  /** Multiset equality — JVM flag order doesn't change semantics, so two
   *  flag lists with the same contents in any order are considered equal. */
  const argsListsEqual = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  };

  /** Whether the given flag list matches any known preset's flags. Memory
   *  args (`-Xmx`/`-Xms`) are excluded from comparison since the slider
   *  controls them separately and they're never part of the editor's text. */
  const matchesAnyPreset = (args: string[]): boolean => {
    const cleaned = args.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
    const presets = knownPresets();
    for (const flags of Object.values(presets)) {
      if (argsListsEqual(cleaned, flags)) return true;
    }
    return false;
  };

  /** Whether the current editor contents are preset-equal — i.e. the global
   *  preset is effectively in control. Reactive because it depends on both
   *  the textarea text and the loaded preset map. */
  const isCurrentlyPreset = (): boolean => {
    const text = extraArgsText().trim();
    if (!text) return true;
    const args = text.split(/\s+/).filter(a => a.trim());
    return matchesAnyPreset(args);
  };

  // Sync editor text whenever instance changes or settings tab opens.
  // We first load the known-preset map and global preset name (so the
  // "Active preset" label and the preset-equal detection are accurate),
  // then decide what to show:
  //   • saved extra_args matches a preset → show *current* preset flags
  //     (so a global preset switch is reflected immediately),
  //   • saved extra_args is genuinely customized → show those,
  //   • no saved extra_args → show current preset flags.
  createEffect(() => {
    gcTick(); // re-derive when the global GC preset changes
    const inst = instance();
    if (!inst || mainTab() !== "settings") return;
    const id = activeInstanceId();
    if (!id) return;

    // Refresh the adaptive-RAM state in lockstep — keeps the read-only
    // memory display + slider gating in sync with the same instance/tab
    // signals that drive the rest of the settings tab.
    refreshAdaptive();

    Promise.all([
      getKnownPresetArgs(id).catch(() => ({} as Record<string, string[]>)),
      getSettings().catch(() => null),
    ]).then(([presets, settings]) => {
      setKnownPresets(presets);
      if (settings) setGlobalPreset(settings.gc_preset);

      const userArgs = (inst.java.extra_args || []).filter(a => a.trim());
      const isPresetEqual = userArgs.length === 0 || (() => {
        const cleaned = userArgs.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
        for (const flags of Object.values(presets)) {
          if (cleaned.length === flags.length) {
            const sa = [...cleaned].sort();
            const sb = [...flags].sort();
            if (sa.every((v, i) => v === sb[i])) return true;
          }
        }
        return false;
      })();

      if (!isPresetEqual && userArgs.length > 0) {
        setExtraArgsText(userArgs.join("\n"));
      } else {
        // Preset-equal or empty — render current preset flags so the editor
        // tracks the global setting live.
        getPresetJvmArgs(id).then((args) => {
          const filtered = args.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
          setExtraArgsText(filtered.join("\n"));
        }).catch(() => {});
      }
    });
  });

  // Line-number gutter
  const lineNumbers = (): number[] => {
    const text = extraArgsText();
    const count = Math.max(text.split("\n").length, 1);
    return Array.from({ length: count }, (_, i) => i + 1);
  };

  // Space → newline so each flag lives on its own line
  const handleArgsKeyDown = (e: KeyboardEvent) => {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = ta.value.slice(0, start) + "\n" + ta.value.slice(end);
      setExtraArgsText(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
    }
  };

  const handleArgsBlur = async () => {
    const inst = instance();
    if (!inst) return;
    const args = extraArgsText().split(/\s+/).filter(a => a.trim());
    // If the user's flags exactly match a known preset, save empty
    // `extra_args` instead. The launch path treats empty extras as "use the
    // global preset" — keeping it empty means switching the global preset
    // in Settings actually takes effect on next launch instead of being
    // shadowed forever by stale preset-equal extras.
    const argsToSave = matchesAnyPreset(args) ? [] : args;
    try {
      await updateInstanceOptions(inst.id, { extraArgs: argsToSave });
      await refetchInstances();
      // Keep the editor visually unchanged regardless of what we persisted.
      setExtraArgsText(args.join("\n"));
    } catch (err) {
      console.error("Save extra args failed:", err);
      showToast({ title: "Failed to save Java arguments", message: String(err), type: "error" });
    }
  };

  const totalPages = () => Math.max(1, Math.ceil(totalHits() / PAGE_SIZE));

  // Load files when tab switches
  createEffect(() => {
    if (mainTab() === "files" && instance()) {
      loadFiles();
    }
  });

  createEffect(() => {
    if (mainTab() === "worlds" && instance()) {
      loadWorlds();
    }
  });

  // Logs are streamed into a global buffer (`gameLogs` in App.tsx) so
  // they persist across screen navigation. Subscribing to the
  // `game-log` event happens once at App level — no per-screen listener
  // needed here.
  //
  // Logs persist for the lifetime of the launcher session — so users can
  // exit Minecraft, switch back to the Logs tab, and still review the
  // output from the play session that just ended. The in-memory log buffer
  // is naturally wiped when the launcher itself exits (signals don't
  // persist), which is exactly the "fresh start on relaunch" behavior we
  // want without explicit work here.

  // Auto-scroll is handled by the .log-viewer-frame ref callback below
  // (scroll listener + MutationObserver gated on autoScrollLogs). No separate
  // effect here — a second mechanism would fight the user's scroll intent.

  /**
   * Reset to page 1 and re-search when the *shape* of the browse query changes.
   *
   * The dependency list is deliberate and exhaustive: category, the column-aware
   * page size, and which instance is open. Everything else that affects the query
   * — source, sort, search text, page — is driven by its own handler that calls
   * `doSearch` directly.
   *
   * `doSearch` runs inside `untrack` because calling it synchronously from an
   * effect body makes every signal it reads a dependency of this effect. That had
   * two visible consequences: installing a mod refetched `instances`, which
   * `doSearch` reads, which threw the user back to page 1 mid-browse; and every
   * keystroke re-ran this effect immediately, firing a search alongside the
   * debounced one and doubling the request rate against a rate-limited API. Same
   * root cause as the `refreshUpdates` effect above — depending on the whole
   * `instances` resource when only one field is needed.
   */
  createEffect(() => {
    if (mainTab() !== "content" || contentTab() !== "browse") return;
    browseFilter();
    activeInstanceId();
    untrack(() => {
      if (instance()) {
        setCurrentPage(1);
        doSearch(1);
      }
    });
  });



  const loadFiles = async () => {
    const inst = instance();
    if (!inst) return;
    try {
      const result = await listInstanceFiles(inst.id, filePath());
      setFiles(result);
    } catch (e) { console.error(e); }
  };

  const loadWorlds = async () => {
    const inst = instance();
    if (!inst) return;
    try {
      const result = await listInstanceWorlds(inst.id);
      setWorlds(result);
    } catch (e) { console.error(e); }
  };

  const navigateToFolder = (path: string) => {
    setFilePath(path);
    loadFiles();
  };

  const navigateUp = () => {
    const current = filePath();
    if (!current) return;
    const parts = current.split("/");
    parts.pop();
    setFilePath(parts.length > 0 ? parts.join("/") : undefined);
    loadFiles();
  };

  let searchTimeout: number | undefined;
  let pageTimeout: number | undefined;
  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
    if (pageTimeout) clearTimeout(pageTimeout);
  });

  // Monotonic request token. Every doSearch call captures its own value
  // before awaiting and only commits results when the captured token still
  // equals the latest — otherwise the user has changed source / sort /
  // filter / page / view in the meantime and an in-flight reply is no
  // longer relevant. This subsumes the older `currentPage()` page-staleness
  // guard (page changes also bump the token) and additionally protects
  // source-toggle, which previously had no guard at all and could let a
  // slow Modrinth reply clobber a fast CurseForge reply (or vice versa).
  let searchToken = 0;

  const doSearch = async (page?: number) => {
    const inst = instance();
    if (!inst) return;

    if (inst.loader.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")) {
      setSearchResults([]);
      setTotalHits(0);
      setSearching(false);
      return;
    }

    const p = page || currentPage();
    const offset = (p - 1) * PAGE_SIZE;
    const token = ++searchToken;
    setSearching(true);
    try {
      // Version resolution:
      // An empty `browseVersion` means use the instance's active version.
      // "any" means explicitly search across all game versions (empty string sent to backend).
      // A specific version string (e.g. "1.20.1") scopes search to that version.
      const bv = browseVersion().trim();
      const version = bv === "any" ? "" : (bv ? bv.replace(/\.+$/, "") : inst.game_version);
      const filter = browseFilter();

      const source = modSource();
      const result = source === "curseforge"
        ? await searchCurseforge(searchQuery(), inst.loader.type, version, offset, PAGE_SIZE, sortBy(), filter)
        : await searchMods(searchQuery(), inst.loader.type, version, offset, PAGE_SIZE, sortBy(), filter);

      if (token !== searchToken) return; // superseded by a newer request
      setSearchResults(result.hits);
      setTotalHits(result.total_hits);
    } catch (e) {
      if (token !== searchToken) return; // superseded; ignore stale error
      // Surface the failure so an empty Browse pane is never silent. A
      // transient rate-limit or network blip would otherwise leave the
      // user staring at an empty grid with no indication of why.
      console.error("Search failed:", e);
      showToast({
        title: `${modSource() === "curseforge" ? "CurseForge" : "Modrinth"} search failed`,
        message: typeof e === "string" ? e : "Couldn't load results — try again.",
        type: "error",
      });
    } finally {
      if (token === searchToken) setSearching(false);
    }
  };

  // Close the detail overlay when the underlying list changes. Reading the
  // signals here rather than clearing at each call site means a new way of
  // changing the results can't forget to do it, and it stops the overlay from
  // describing a project that's no longer in the results.
  createEffect(() => {
    searchResults();
    modSource();
    browseFilter();
    currentPage();
    setDetailMod(null);
  });

  /**
   * Card click. Multi-select owns the gesture while it's active; otherwise the
   * card opens its detail overlay.
   */
  const handleCardClick = (mod: ModHit) => {
    if (selectMode()) {
      if (!isModInstalled(mod.project_id)) toggleSelectItem(mod);
      return;
    }
    setDetailMod(mod);
  };

  const handleSourceToggle = () => {
    setModSource(modSource() === "modrinth" ? "curseforge" : "modrinth");
    setCurrentPage(1);
    doSearch(1);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => doSearch(1), 300);
  };

  const handleSortChange = (sort: string) => { setSortBy(sort); setCurrentPage(1); doSearch(1); };

  const goToPage = (page: number) => {
    if (page < 1 || page > totalPages()) return;
    setCurrentPage(page);
    clearTimeout(pageTimeout);
    pageTimeout = window.setTimeout(() => {
      doSearch(page);
    }, 150); // Debounce rapid slider changes
  };

  // ─── Installed tab: client-side filter & pagination ──────────────────
  const installedFiltered = createMemo((): any[] => {
    const mods = instanceMods();
    const f = installedFilter();
    const q = installedSearch().trim().toLowerCase();
    const filtered = mods.filter((m: any) => {
      const cat = (m as any).category || "mod";
      if (f !== "all" && cat !== f) return false;
      // Managed companion mod jars are rendered as the dedicated managed card, not in the general mod grid.
      if (m.filename && m.filename.startsWith("vermeil-") && m.filename.includes("+")) return false;
      if (q) {
        const haystack = ((m.title || m.filename) + " " + (m.description || "")).toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    // Backend pushes new mods to the end of the Vec, so the array is
    // already in install order (oldest → newest). Reverse for newest-first.
    return installedSort() === "newest" ? filtered.slice().reverse() : filtered;
  });

  const showCompanion = (): boolean => {
    const inst = instance();
    if (!inst || !(inst as any).ingame_cape_supported) return false;
    const globalCompanion = settings()?.enable_companion_mod ?? true;
    const hasJarOnDisk = Boolean(inst.companion_version || (instanceDetail() as any)?.companion_version);
    if (!globalCompanion && !hasJarOnDisk) return false;
    if (installedFilter() !== "all" && installedFilter() !== "mod") return false;
    const q = installedSearch().trim().toLowerCase();
    if (q && !"vermeil companion mod".includes(q)) return false;
    return true;
  };

  const totalInstalledCount = () => (showCompanion() ? 1 : 0) + installedFiltered().length;
  const installedTotalPages = () => Math.max(1, Math.ceil(totalInstalledCount() / PAGE_SIZE));

  const goToInstalledPage = (page: number) => {
    if (page < 1 || page > installedTotalPages()) return;
    setInstalledPage(page);
  };

  // Reset to page 1 when filter, search, sort, or active instance changes
  createEffect(() => {
    installedFilter();
    installedSearch();
    installedSort();
    activeInstanceId();
    setInstalledPage(1);
  });

  // Clamp page if item count shrinks
  createEffect(() => {
    const total = installedTotalPages();
    if (installedPage() > total) {
      setInstalledPage(total);
    }
  });

  const pagedInstalledMods = (): any[] => {
    const mods = installedFiltered();
    const size = PAGE_SIZE;
    const page = installedPage();
    const hasComp = showCompanion();

    if (hasComp) {
      if (page === 1) {
        return mods.slice(0, Math.max(0, size - 1));
      }
      const start = (page - 1) * size - 1;
      return mods.slice(start, start + size);
    }

    const start = (page - 1) * size;
    return mods.slice(start, start + size);
  };

  // Push pagination state into the dock when Browse or Installed has multiple pages.
  createEffect(() => {
    if (mainTab() !== "content") {
      setDockPagination(null);
      return;
    }
    if (contentTab() === "browse" && totalPages() > 1) {
      if (instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")) {
        setDockPagination(null);
      } else {
        setDockPagination({ current: currentPage(), total: totalPages(), onPageChange: goToPage });
      }
    } else if (contentTab() === "installed" && installedTotalPages() > 1) {
      setDockPagination({ current: installedPage(), total: installedTotalPages(), onPageChange: goToInstalledPage });
    } else {
      setDockPagination(null);
    }
  });

  /**
   * Install a mod from the Browse tab.
   *
   * `versionId` comes from the expanded card's version picker and installs that
   * exact version (a Modrinth version id or a CurseForge file id). Omitted — the
   * plain Install button — lets the backend resolve the newest compatible one.
   */
  const handleInstallMod = (mod: ModHit, versionId?: string) => {
    const inst = instance();
    if (!inst) return;
    const cat = browseFilter() === "all" ? detectCategory(mod, inst.loader.type) : browseFilter();
    enqueueInstallTask({
      title: mod.title,
      projectId: mod.project_id,
      category: cat,
      instanceId: inst.id,
      meta: {
        iconUrl: mod.icon_url,
        loader: inst.loader.type,
        gameVersion: inst.game_version,
        author: mod.author,
      },
      execute: async (dlId: string) => {
        try {
          const resultJson = modSource() === "curseforge"
            ? await installCfModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, cat, versionId)
            : await installModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, cat, versionId);
          setLocalInstalled(prev => { const s = new Set(prev); s.add(mod.project_id); return s; });
          try {
            const result = JSON.parse(resultJson);
            const depsInstalled: number = result.deps_installed ?? 0;
            const depTitles: string[] = result.dep_titles ?? [];
            const depIssues: DependencyIssue[] = result.issues ?? [];
            const vnum: string | undefined = result.mod_entry?.version_number ?? undefined;
            if (depsInstalled > 0) {
              // Show up to 3 dep titles inline; fall back to count for the rest.
              const preview = depTitles.slice(0, 3).join(", ");
              const more = depTitles.length > 3 ? ` +${depTitles.length - 3} more` : "";
              const message = depTitles.length > 0
                ? `${mod.title} with ${preview}${more}`
                : `${mod.title} (+${depsInstalled} dep${depsInstalled === 1 ? "" : "s"})`;
              completeDownload(dlId, message, vnum);
            } else {
              completeDownload(dlId, undefined, vnum);
            }
            // Show structured per-dep modal for missing/incompatible/failed deps.
            if (depIssues.length > 0) {
              reportDependencyIssues(mod.title, depIssues);
            }
          } catch {
            completeDownload(dlId);
          }
          await refetchInstances();
          await refetchDetail();
        } catch (err: any) {
          const errStr = typeof err === "string" ? err : (err?.message || String(err));
          // If automatic resolution failed because no strictly compatible release was found,
          // prompt the user so they can force-install the latest available release.
          const isCompatIssue = !versionId && (
            errStr.toLowerCase().includes("supports mc") ||
            errStr.toLowerCase().includes("no compatible version") ||
            errStr.toLowerCase().includes("no version satisfies") ||
            errStr.toLowerCase().includes("supports fabric") ||
            errStr.toLowerCase().includes("supports forge") ||
            errStr.toLowerCase().includes("supports neoforge")
          );

          if (isCompatIssue) {
            failDownload(dlId, "Compatibility issue — confirmation required");
            handleCardInstall(mod, true);
            return;
          }
          throw err;
        }
      },
    });
  };

  /**
   * Card "+ Install" handler.
   * Checks compatibility upfront:
   * - If compatible: installs immediately (1-click install).
   * - If not strictly compatible: prompts user via Compatibility Notice modal,
   *   allowing them to force-install the latest version anyway, browse all versions,
   *   or cancel.
   */
  const handleCardInstall = async (mod: ModHit, forcePrompt: boolean = false) => {
    const inst = instance();
    if (!inst) return;
    const cat = browseFilter() === "all" ? detectCategory(mod, inst.loader.type) : browseFilter();
    if (!forcePrompt && checkModCompatibility(mod, inst.game_version, inst.loader.type, cat)) {
      handleInstallMod(mod);
      return;
    }

    const initialLatestId = mod.latest_version || undefined;
    const initialLatestName = mod.version_name || undefined;

    setIncompatiblePrompt({
      mod,
      category: cat,
      gameVersion: inst.game_version,
      loader: inst.loader.type,
      latestVersionId: initialLatestId,
      latestVersionName: initialLatestName,
      supportedVersions: mod.versions || [],
      resolvingVersion: !initialLatestId,
    });

    if (!initialLatestId) {
      try {
        if (modSource() === "curseforge") {
          const files = await getCfModFiles(mod.project_id, inst.loader.type, inst.game_version);
          if (files && files.length > 0) {
            setIncompatiblePrompt(prev => prev && prev.mod.project_id === mod.project_id ? {
              ...prev,
              latestVersionId: files[0].id,
              latestVersionName: files[0].name || prev.latestVersionName,
              resolvingVersion: false,
            } : prev);
          } else {
            setIncompatiblePrompt(prev => prev ? { ...prev, resolvingVersion: false } : null);
          }
        } else {
          const versions = await getModVersions(mod.project_id, inst.loader.type, inst.game_version, cat);
          if (versions && versions.length > 0) {
            setIncompatiblePrompt(prev => prev && prev.mod.project_id === mod.project_id ? {
              ...prev,
              latestVersionId: versions[0].id,
              latestVersionName: versions[0].name || prev.latestVersionName,
              resolvingVersion: false,
            } : prev);
          } else {
            setIncompatiblePrompt(prev => prev ? { ...prev, resolvingVersion: false } : null);
          }
        }
      } catch (e) {
        console.warn("Could not resolve latest version for prompt:", e);
        setIncompatiblePrompt(prev => prev ? { ...prev, resolvingVersion: false } : null);
      }
    }
  };

  const toggleSelectItem = (mod: ModHit) => {
    const map = new Map(selectedItems());
    if (map.has(mod.project_id)) {
      map.delete(mod.project_id);
    } else {
      const cat = browseFilter() === "all" ? detectCategory(mod, instance()?.loader?.type) : browseFilter();
      map.set(mod.project_id, { mod, category: cat });
    }
    setSelectedItems(map);
  };

  /// Apply an available update for a single Modrinth-sourced mod. Reuses the
  /// install-flow's structured error envelope so any compatibility issues
  /// during the dependency walk are surfaced through the existing modal.
  const handleUpdateMod = (projectId: string, modTitle: string) => {
    const inst = instance();
    if (!inst) return;
    enqueueInstallTask({
      title: modTitle,
      projectId,
      category: "mod",
      instanceId: inst.id,
      meta: {
        loader: inst.loader.type,
        gameVersion: inst.game_version,
      },
      execute: async (dlId: string) => {
        const resultJson = await applyModUpdate(inst.id, projectId);
        // Clear the pill optimistically; the next refresh confirms.
        setModUpdates(prev => {
          const next = new Map(prev);
          next.delete(projectId);
          return next;
        });
        try {
          const result = JSON.parse(resultJson);
          const issues: DependencyIssue[] = result.issues ?? [];
          if (issues.length > 0) {
            reportDependencyIssues(modTitle, issues);
          }
        } catch {
          // Older command shape — ignore.
        }
        await refetchInstances();
        await refetchDetail();
        completeDownload(dlId, modTitle);
        // Re-check in case the update introduced new mods that themselves have
        // pending updates (rare but possible with deep dep trees).
        refreshUpdates();
      },
    });
  };

  const handleBulkInstall = () => {
    const inst = instance();
    if (!inst) return;
    const items = Array.from(selectedItems().values());
    if (items.length === 0) return;

    setBulkInstalling(true);
    setSelectMode(false);
    setSelectedItems(new Map());

    startBulkBatch(items.length);

    // Aggregate dependency issues across the whole batch so the modal at the
    // end lists everything in one place rather than firing per-item.
    const aggregateIssues: DependencyIssue[] = [];
    let completedCount = 0;

    // Process items sequentially in queue to avoid rate limits and instance.json race conditions
    for (const { mod, category } of items) {
      enqueueInstallTask({
        title: mod.title,
        projectId: mod.project_id,
        category,
        instanceId: inst.id,
        meta: {
          iconUrl: mod.icon_url,
          loader: inst.loader.type,
          gameVersion: inst.game_version,
          author: mod.author,
        },
        execute: async (dlId: string) => {
          try {
            const resultJson = modSource() === "curseforge"
              ? await installCfModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, category)
              : await installModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, category);
            setLocalInstalled(prev => { const s = new Set(prev); s.add(mod.project_id); return s; });
            try {
              const result = JSON.parse(resultJson);
              const depIssues: DependencyIssue[] = result.issues ?? [];
              aggregateIssues.push(...depIssues);
              completeDownload(dlId, undefined, result.mod_entry?.version_number ?? undefined);
            } catch {
              // resultJson might not be valid JSON for older command shapes — ignore
              completeDownload(dlId);
            }
          } catch (e: any) {
            const errStr = typeof e === "string" ? e : (e?.message || `Failed to install ${mod.title}`);
            failDownload(dlId, errStr);
            console.error(`Bulk install failed for ${mod.title}:`, e);
          } finally {
            completedCount++;
            await refetchInstances();
            await refetchDetail();
            if (completedCount >= items.length) {
              endBulkBatch();
              setBulkInstalling(false);
              // Surface every issue collected during the batch in one modal.
              if (aggregateIssues.length > 0) {
                reportDependencyIssues(`${items.length} items`, aggregateIssues);
              }
            }
          }
        },
      });
    }
  };

  // Note: launching/stopping is now handled by the floating dock's center
  // button (`FloatingDock.tsx`). The previous inline play/stop button on
  // the instance context bar has been removed.

  const isModInstalled = (projectId: string): boolean => localInstalled().has(projectId) || (instanceMods().some((m: any) => m.project_id === projectId) || false);

  /// Installed-content count for the active category — shown beside the filter
  /// row (not on the buttons, so they keep a fixed width).
  const installedActiveCount = (): number => {
    const mods = instanceMods();
    const f = installedFilter();
    return f === "all" ? mods.length : mods.filter((m: any) => ((m as any).category || "mod") === f).length;
  };

  /// Loaders we recognize on Modrinth project `categories`. Modrinth bundles
  /// loader IDs into the same array as content categories, so we filter to
  /// just the loader subset for the badge row.
  const KNOWN_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt", "datapack", "iris", "optifine", "vanilla"]);

  /// Extract every loader a project supports from its `categories` array.
  /// Returns them in a stable order so a project that supports both Fabric and
  /// Quilt always renders Fabric first. Empty when no known loader is present.
  const LOADER_ORDER = ["fabric", "quilt", "forge", "neoforge", "datapack", "iris", "optifine", "vanilla"];
  const extractLoaders = (categories?: string[]): string[] => {
    const found = new Set<string>();
    for (const c of (categories || [])) {
      if (KNOWN_LOADERS.has(c)) found.add(c);
    }
    // For shaders on CurseForge, "vanilla" appears as a category but isn't
    // meaningful as a loader badge — CF doesn't track iris/optifine support.
    // Drop it so the card doesn't show a misleading "vanilla" pill.
    if (browseFilter() === "shader" && modSource() === "curseforge") {
      found.delete("vanilla");
    }
    return LOADER_ORDER.filter(l => found.has(l));
  };

  /// Clean tags for Browse cards (loader + primary category/tag) matching reference UI
  const extractCardTags = (categories?: string[]): { loader?: string; tag?: string } => {
    const cats = categories || [];
    const instLoader = instance()?.loader?.type;
    const loaders = extractLoaders(cats);
    const loader = loaders.find(l => l === instLoader) || loaders[0];
    const nonLoader = cats.find(c => !KNOWN_LOADERS.has(c));
    const tag = nonLoader ? nonLoader.charAt(0).toUpperCase() + nonLoader.slice(1) : undefined;
    return { loader, tag };
  };

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

  const toggleLogFilter = (filter: string) => {
    const current = new Set(logFilters());
    if (filter === "all") {
      setLogFilters(new Set(["all"]));
    } else {
      current.delete("all");
      if (current.has(filter)) {
        current.delete(filter);
        if (current.size === 0) current.add("all");
      } else {
        current.add(filter);
      }
      setLogFilters(current);
    }
    requestAnimationFrame(() => {
      if (!viewerEl) return;
      if (autoScrollLogs()) {
        viewerEl.scrollTop = viewerEl.scrollHeight;
      } else {
        viewerEl.scrollTop = 0;
      }
    });
  };

  const filteredLogs = createMemo(() => {
    const filters = logFilters();
    const search = logSearch().trim().toLowerCase();
    const allLines = logs();

    const filterAll = filters.has("all");
    const filterError = filters.has("error");
    const filterWarn = filters.has("warn");

    if (filterAll && !search) {
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

      if (matches && (!search || line.toLowerCase().includes(search))) {
        result.push(line);
      }
    }

    return result;
  });

  return (
    <div class={`screen-enter instance-screen ${mainTab() === "logs" ? "instance-screen--logs" : ""}`}>
      <Show when={instance()} fallback={
        <div style="text-align:center;color:var(--muted);padding:40px;font-size:var(--fs-sm)">
          <div style="margin-bottom:8px">No instance selected.</div>
          <button class="btn btn--subtle" onClick={() => setActiveScreen("home")}>
            <IconArrowLeft />
            <span>Go to Home</span>
          </button>
        </div>
      }>
      {/* Context bar */}
      <div class="inst-context-bar">
        <div class="inst-context-identity">
          <button class="inst-back-btn tip-below tip-left" onClick={() => setActiveScreen("library")} data-tip="Back to library">
            <IconArrowLeft />
          </button>
          <div
            class={`inst-identity-thumb ${loaderBannerColor(instance()?.loader?.type || "vanilla")}`}
          >
            <Show when={resolveAssetUrl(instance()?.icon)} fallback={
              <span class="inst-identity-thumb-letter">{(instance()?.name || "?").trim().charAt(0).toUpperCase() || "?"}</span>
            }>
              <img
                src={resolveAssetUrl(instance()?.icon)!}
                alt=""
                draggable={false}
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </Show>
          </div>
          <span class="inst-context-title">{instance()?.name}</span>

          {/* Standardized Metadata Badges Track */}
          <div class="inst-context-badges">
            <Show when={instance() && instance()!.loader.type !== "vanilla"}>
              <span class="inst-pill-tag inst-pill-loader">
                {loaderLabel(instance()!.loader.type)}
              </span>
            </Show>
            <span class="inst-pill-tag inst-pill-version">{instance()?.game_version}</span>
            <Show when={(instance()?.source_platforms || []).includes("modrinth")}>
              <span class="badge badge--source badge--modrinth tip-below" data-tip="Modrinth"><IconModrinth /></span>
            </Show>
            <Show when={(instance()?.source_platforms || []).includes("curseforge")}>
              <span class="badge badge--source badge--curseforge tip-below" data-tip="CurseForge"><IconCurseForge /></span>
            </Show>
            <Show when={instance()?.ingame_cape_supported}>
              <span class="badge badge--companion tip-below" data-tip="Companion mod">
                <img src="/logo.png" alt="Vermeil" draggable={false} />
              </span>
            </Show>
          </div>
        </div>

        <div class="ctx-action-group">
          <div class="inst-view-segmented">
            <button class={`inst-view-tab ${mainTab() === "content" ? "active" : ""}`} onClick={() => setMainTab("content")}>Content</button>
            <button class={`inst-view-tab ${mainTab() === "files" ? "active" : ""}`} onClick={() => setMainTab("files")}>Files</button>
            <button class={`inst-view-tab ${mainTab() === "worlds" ? "active" : ""}`} onClick={() => setMainTab("worlds")}>Worlds</button>
            <button class={`inst-view-tab ${mainTab() === "logs" ? "active" : ""}`} onClick={() => setMainTab("logs")}>Logs</button>
          </div>
          {/* Quick instance switcher dropdown */}
          <div class="inst-switcher-wrap" ref={switcherRef}>
            <button
              class={`inst-gear-btn tip-below tip-right ${switcherOpen() ? "active" : ""}`}
              onClick={() => setSwitcherOpen(!switcherOpen())}
              data-tip={switcherOpen() ? undefined : "Switch active instance"}
              aria-label="Switch active instance"
            >
              <IconLayers />
            </button>
            <Show when={switcherOpen()}>
              <div class="inst-switcher-menu">
                <For each={instances()}>
                  {(inst) => (
                    <div
                      class={`inst-switcher-item ${inst.id === activeInstanceId() ? "active" : ""}`}
                      onClick={() => {
                        setActiveInstanceId(inst.id);
                        setSwitcherOpen(false);
                      }}
                    >
                      <span class="inst-switcher-name">{inst.name}</span>
                      <span class="inst-switcher-badge">{inst.loader.type} · {inst.game_version}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <button
            class="inst-gear-btn tip-below tip-right"
            onClick={async () => {
              const inst = instance();
              if (!inst) return;
              try {
                const code = await exportShareCode(inst.id);
                await navigator.clipboard.writeText(code);
                const isShort = code.startsWith("VML-") || code.startsWith("VLM-");
                showToast({
                  title: "Share Code Copied",
                  message: isShort
                    ? `Copied 3-minute share code (${code}) for "${inst.name}" to clipboard.`
                    : `Copied offline share code for "${inst.name}" (${code.length} chars) to clipboard.`,
                  type: "success",
                });
              } catch (e: any) {
                showToast({
                  title: "Failed to Copy Share Code",
                  message: typeof e === "string" ? e : e?.message || "Could not generate share code",
                  type: "error",
                });
              }
            }}
            data-tip="Copy share code"
            aria-label="Copy instance share code"
          >
            <IconShare2 />
          </button>
          <button
            class={`inst-gear-btn tip-below tip-right ${pinnedInstanceIds().includes(instance()?.id ?? "") ? "active" : ""}`}
            onClick={async () => {
              const inst = instance();
              if (!inst) return;
              try {
                const s = await getSettings();
                s.theme = currentTheme();
                const currentPins = s.sidebar_pinned_instances ?? [];
                if (currentPins.includes(inst.id)) {
                  s.sidebar_pinned_instances = currentPins.filter((id) => id !== inst.id);
                  await saveSettings(s);
                  await refreshPinnedInstanceIds();
                  showToast({ title: "Unpinned", message: `Removed "${inst.name}" from quick-launch dock`, type: "info" });
                } else {
                  if (currentPins.length >= 6) {
                    showToast({
                      title: "6-pin limit reached",
                      message: "Open pin manager to choose which instances to keep pinned.",
                      type: "info",
                    });
                    openPinInstancesModal();
                    return;
                  }
                  s.theme = currentTheme();
                  s.sidebar_pinned_instances = [...currentPins, inst.id];
                  await saveSettings(s);
                  await refreshPinnedInstanceIds();
                  showToast({ title: "Pinned", message: `Added "${inst.name}" to quick-launch dock`, type: "success" });
                }
              } catch (e: any) {
                showToast({ title: "Failed to update pin", message: String(e), type: "error" });
              }
            }}
            data-tip={pinnedInstanceIds().includes(instance()?.id ?? "") ? "Unpin instance" : "Pin instance"}
            aria-label="Toggle pin"
          >
            <IconPin />
          </button>
          <button
            class={`inst-gear-btn tip-below tip-right ${mainTab() === "settings" ? "active" : ""}`}
            onClick={() => setMainTab(mainTab() === "settings" ? "content" : "settings")}
            data-tip="Instance settings"
          >
            <IconSettings />
          </button>
          <button
            class={`inst-header-play-btn ${isGameRunningThis() ? "btn--stop" : "btn--play"} ${isCurrentInstanceInstalling() || isLaunchingThis() ? "btn--disabled" : ""}`}
            onClick={handlePlayOrStop}
            aria-label={isLaunchingThis() ? "Launching instance" : isGameRunningThis() ? "Stop running game" : "Launch instance"}
          >
            <Show when={isLaunchingThis()}>
              <IconDownload />
              <span>Launching...</span>
            </Show>
            <Show when={!isLaunchingThis()}>
              <Show when={isGameRunningThis()} fallback={
                <Show when={isCurrentInstanceInstalling()} fallback={
                  <>
                    <IconPlay />
                    <span>Play</span>
                  </>
                }>
                  <>
                    <IconDownload />
                    <span>Installing...</span>
                  </>
                </Show>
              }>
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
                <span>Stop</span>
              </Show>
            </Show>
          </button>
        </div>
      </div>

      {/* ═══ INSTANCE SETTINGS TAB ═══ */}
      <Show when={mainTab() === "settings"}>
        <div class="cards-container" style="padding-top:var(--space-4);padding-bottom:var(--space-6)">
          {/* Section 1: Identity & Display */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <span class="card-section-tag tag-settings-profiles">PROFILE</span>
              <span class="card-section-label">Identity & Display</span>
              <span class="card-section-desc">Instance name, custom icon, and identity</span>
            </div>
            <div class="card-section-body">
              {/* Row 1: Instance Name */}
              <div class="setting-row full">
                <div class="setting-info">
                  <span class="setting-name">Instance name</span>
                  <span class="setting-desc">The display name of this instance shown in your Library and quick-launch menus</span>
                </div>
                <div class="setting-control" style="display:flex;gap:8px;align-items:center">
                  <input
                    type="text"
                    class="field-control field-control--text"
                    style="width:240px;font-weight:600"
                    value={nameDraft()}
                    onInput={(e) => setNameDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleSaveName();
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        setNameDraft(instance()?.name ?? "");
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Instance name"
                  />
                  <button
                    class="btn btn--primary btn--sm"
                    disabled={renaming() || !nameDraft().trim() || nameDraft().trim() === instance()?.name}
                    onClick={handleSaveName}
                  >
                    {renaming() ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>

              {/* Row 2: Instance Icon */}
              <div class="setting-row full">
                <div style="display:flex;gap:14px;align-items:center;flex:1;min-width:0">
                  <div class="instance-icon-preview">
                    <Show
                      when={resolveAssetUrl(instance()?.icon)}
                      fallback={<span class="instance-icon-placeholder">{(instance()?.name ?? "?").trim().charAt(0).toUpperCase() || "?"}</span>}
                    >
                      <img
                        src={resolveAssetUrl(instance()?.icon)!}
                        alt=""
                        draggable={false}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </Show>
                  </div>
                  <div class="setting-info">
                    <span class="setting-name">Instance icon</span>
                    <span class="setting-desc">Custom PNG, JPG, or WebP graphic. Shown on Library cards, dock pins, and detail headers.</span>
                  </div>
                </div>
                <div class="setting-control" style="display:flex;gap:8px;align-items:center">
                  <button
                    class="btn btn--sm"
                    onClick={async () => {
                      const inst = instance();
                      if (!inst) return;
                      const picked = await openDialog({
                        multiple: false,
                        directory: false,
                        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
                      });
                      if (!picked || typeof picked !== "string") return;
                      try {
                        await setInstanceIcon(inst.id, picked);
                        await refetchInstances();
                        showToast({ title: "Icon updated", message: "", type: "success", autoCloseMs: 2000 });
                      } catch (e) {
                        showToast({ title: "Couldn't set icon", message: String(e), type: "error" });
                      }
                    }}
                  >
                    Change icon
                  </button>
                  <Show when={instance() && instance()!.icon !== "cube"}>
                    <button
                      class="btn btn--ghost btn--sm"
                      onClick={async () => {
                        const inst = instance();
                        if (!inst) return;
                        try {
                          await clearInstanceIcon(inst.id);
                          await refetchInstances();
                          showToast({ title: "Icon reset", message: "", type: "info", autoCloseMs: 2000 });
                        } catch (e) {
                          showToast({ title: "Couldn't reset icon", message: String(e), type: "error" });
                        }
                      }}
                    >
                      Reset
                    </button>
                  </Show>
                </div>
              </div>

              {/* Row 3: Mod Loader */}
              <div class="setting-row full">
                <div class="setting-info">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="setting-name">Mod loader</span>
                    <span class={`badge badge--loader ${loaderBadgeClass(instance()?.loader?.type || "")}`}>
                      {loaderLabel(instance()?.loader?.type || "")} {instance()?.loader?.version || ""}
                    </span>
                  </div>
                  <span class="setting-desc">
                    Runtime modding environment (Vanilla, Fabric, NeoForge, Forge, Quilt). You can switch loaders or update the loader version.
                  </span>
                </div>
                <div class="setting-control">
                  <button
                    class="btn btn--sm"
                    disabled={gameRunning()}
                    onClick={() => {
                      const inst = instance();
                      if (inst) openChangeLoaderModal(inst.id);
                    }}
                    data-tip={gameRunning() ? "Game is running" : undefined}
                  >
                    <IconShuffle /> Change loader
                  </button>
                </div>
              </div>

              {/* Row 4: Installation Details & Folder */}
              <div class="setting-row full">
                <div class="setting-info">
                  <span class="setting-name">Installation files</span>
                  <span class="setting-desc">
                    {loaderLabel(instance()?.loader?.type || "")} {instance()?.loader?.version || ""} · Minecraft {instance()?.game_version} · {instance()?.mod_count || 0} {(instance()?.mod_count || 0) === 1 ? "mod" : "mods"} installed
                  </span>
                </div>
                <div class="setting-control">
                  <button
                    class="btn btn--sm"
                    onClick={() => {
                      const inst = instance();
                      if (inst) openInstanceFolder(inst.id);
                    }}
                  >
                    <IconFolderOpen /> Open folder
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Memory Allocation */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <span class="card-section-tag tag-settings-performance">MEMORY</span>
              <span class="card-section-label">Memory Allocation</span>
              <span class="card-section-desc">Manage heap RAM for this Minecraft instance</span>
            </div>
            <div class="card-section-body">
              {/* Automatic toggle row */}
              <div class="setting-row full">
                <div class="setting-info">
                  <span class="setting-name">Automatic memory allocation</span>
                  <span class="setting-desc">Dynamically calculate RAM based on installed mods, loader overhead, and system memory</span>
                </div>
                <div class="setting-control">
                  <TactileSwitch
                    checked={isAdaptive()}
                    onChange={toggleAdaptive}
                    aria-label="Automatic memory allocation"
                  />
                </div>
              </div>

              {/* Dynamic Allocated Display OR Manual Slider */}
              <Show
                when={isAdaptive()}
                fallback={
                  <div class="setting-row full" style="flex-direction:column;align-items:stretch;gap:10px">
                    {/* Manual slider */}
                    <div class="setting-info" style="margin-bottom:6px">
                      <span class="setting-name">Custom memory limit</span>
                      <span class="setting-desc">Explicit maximum heap RAM passed via -Xmx</span>
                    </div>
                    <div>
                      <input
                        type="range"
                        class="slider"
                        min={512}
                        max={manualMax()}
                        step={256}
                        value={memoryValue()}
                        style={`--slider-pct: ${((memoryValue() - 512) / (manualMax() - 512)) * 100}%`}
                        onInput={(e) => {
                          const inst = instance();
                          if (!inst) return;
                          const snapped = Math.max(512, Math.round(parseInt(e.currentTarget.value) / 256) * 256);
                          e.currentTarget.style.setProperty("--slider-pct", `${((snapped - 512) / (manualMax() - 512)) * 100}%`);
                          setMemoryDraft(snapped);
                          commitMemory(inst.id, snapped);
                        }}
                      />
                      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px">
                        <span>512 MB</span>
                        <span style="color:var(--accent);font-weight:700;font-size:13px">{(memoryValue() / 1024).toFixed(1).replace('.0', '')} GB</span>
                        <span>{Math.round(manualMax() / 1024)} GB</span>
                      </div>
                      <div style={`font-size:11px;font-weight:600;margin-top:6px;color:${memoryHint(memoryValue()).color}`}>
                        {memoryHint(memoryValue()).text}
                      </div>
                    </div>
                  </div>
                }
              >
                <div class="setting-row full mem-telemetry-plate" style="flex-direction:column;align-items:stretch;gap:12px">
                  <Show when={effectiveMemory()} fallback={<div class="setting-info"><span class="setting-name">Calculating footprint...</span></div>}>
                    {(em) => (
                      <>
                        <div class="mem-telemetry-header">
                          <div class="mem-telemetry-info">
                            <span class="mem-telemetry-title">Adaptive Memory Footprint</span>
                            <span class="mem-telemetry-desc">Dynamic allocation calculated from installed mods, active loader, and system headroom</span>
                          </div>
                          <div class="mem-hero-stat">
                            <div class="mem-hero-val">
                              {formatMemGb(em().value_mb)}
                            </div>
                            <Show when={em().capped}>
                              <span class="mem-status-badge mem-status-badge--capped">
                                <IconAlertTriangle /> CAPPED
                              </span>
                              <span class="mem-hero-sub">
                                Capped at limit · Pack suggests {formatMemGb(em().target_mb)}
                              </span>
                            </Show>
                            <Show when={!em().capped && em().value_mb > em().target_mb}>
                              <span class="mem-status-badge mem-status-badge--floor">
                                <IconBolt /> MIN FLOOR
                              </span>
                              <span class="mem-hero-sub">
                                Raised to {formatMemGb(em().min_mb)} floor
                              </span>
                            </Show>
                            <Show when={!em().capped && em().value_mb <= em().target_mb}>
                              <span class="mem-status-badge mem-status-badge--optimal">
                                <IconCheck /> OPTIMAL
                              </span>
                              <span class="mem-hero-sub">
                                Tiered allocation calibrated for current mod stack
                              </span>
                            </Show>
                          </div>
                        </div>

                        {/* Multi-segment memory budget composition bar */}
                        <div class="mem-budget-bar">
                          <For each={em().breakdown}>
                            {(row) => {
                              const cat = getBreakdownCategory(row.label);
                              const pct = Math.max(3, (row.value_mb / Math.max(1, em().target_mb)) * 100);
                              return (
                                <div
                                  class={`mem-budget-seg mem-budget-seg--${cat.cls}`}
                                  style={{ width: `${pct}%` }}
                                  data-tip={`${row.label} · ${formatBreakdownGb(row.value_mb)}`}
                                />
                              );
                            }}
                          </For>
                        </div>

                        {/* 2-column tactical breakdown grid */}
                        <div class="mem-breakdown-grid">
                          <For each={em().breakdown}>
                            {(row) => {
                              const cat = getBreakdownCategory(row.label);
                              return (
                                <div class="mem-grid-cell">
                                  <div class="mem-cell-left">
                                    <span class={`mem-cell-badge mem-cell-badge--${cat.cls}`}>[{cat.tag}]</span>
                                    <span class="mem-cell-label">{row.label}</span>
                                  </div>
                                  <span class="mem-cell-val">{formatBreakdownGb(row.value_mb)}</span>
                                </div>
                              );
                            }}
                          </For>
                        </div>

                        {/* Footer banner */}
                        <div class="mem-footer-banner">
                          <div style="display:flex;align-items:center">
                            <span class="mem-footer-label">Calculated Pack Target:</span>
                            <span class="mem-footer-hint">(rounded to 256 MB block, 10 GB formula ceiling)</span>
                          </div>
                          <span class="mem-footer-val">{formatMemGb(em().target_mb)}</span>
                        </div>
                      </>
                    )}
                  </Show>
                </div>
              </Show>
            </div>
          </div>

          {/* Section 3: Java & JVM Arguments */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <span class="card-section-tag tag-settings-java">JAVA</span>
              <span class="card-section-label">Java & JVM Arguments</span>
              <span class="card-section-desc">Runtime flags passed to the JVM on game launch</span>
            </div>
            <div class="card-section-body">
              <div class="setting-row full" style="flex-direction:column;align-items:stretch;gap:8px">
                <div class="java-args-panel" style="border-radius:0;box-shadow:var(--btn-depth)">
                  <div class="java-args-panel-header" style="display:flex;align-items:center;gap:8px">
                    <span>JVM flags (one per line · space = new line)</span>
                    <span style="margin-left:auto;display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-weight:500;font-size:var(--fs-2xs);color:var(--muted)">
                      <span>Active preset:</span>
                      <strong style="color:var(--text);font-weight:600">{presetLabel(globalPreset())}</strong>
                      <Show when={!isCurrentlyPreset()}>
                        <span style="color:var(--accent);font-weight:600">· custom</span>
                      </Show>
                    </span>
                  </div>
                  <div class="code-editor">
                    <div class="code-editor-gutter" ref={(el) => (gutterRef = el)}>
                      <For each={lineNumbers()}>
                        {(n) => <span>{n}</span>}
                      </For>
                    </div>
                    <textarea
                      class="code-editor-input"
                      spellcheck={false}
                      placeholder={"Flags from your GC preset will appear here.\nEdit freely — these are what's passed at launch."}
                      value={extraArgsText()}
                      onInput={(e) => setExtraArgsText(e.currentTarget.value)}
                      onKeyDown={handleArgsKeyDown}
                      onBlur={handleArgsBlur}
                      onScroll={(e) => {
                        if (gutterRef) gutterRef.scrollTop = e.currentTarget.scrollTop;
                      }}
                    />
                  </div>
                </div>
                <div class="setting-desc" style="font-size:11px">
                  Pre-filled from your client GC preset. Calibrated for smooth frame pacing and fast startup without Stop-The-World freezes. Edit, add, or remove any flag — heap memory (-Xmx/-Xms) is managed by the memory settings above.
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Instance Actions & Danger Zone */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <span class="card-section-tag tag-settings-instances">ACTIONS</span>
              <span class="card-section-label">Instance Actions & Maintenance</span>
              <span class="card-section-desc">Duplication and lifecycle controls</span>
            </div>
            <div class="card-section-body">
              {/* Clone Instance Row */}
              <div class="setting-row full">
                <div class="setting-info">
                  <span class="setting-name">Clone instance</span>
                  <span class="setting-desc">Make an exact copy with the same loader, mods, configs, and worlds. Useful for testing without risking your save files.</span>
                </div>
                <div class="setting-control">
                  <button
                    class="btn btn--primary btn--sm"
                    disabled={cloning()}
                    onClick={async () => {
                      const inst = instance();
                      if (!inst) return;
                      setCloning(true);
                      try {
                        const cloned = await cloneInstance(inst.id);
                        await refetchInstances();
                        showToast({
                          title: "Instance cloned",
                          message: `Created "${cloned.name}".`,
                          type: "success",
                          autoCloseMs: 3500,
                        });
                      } catch (e: any) {
                        showToast({
                          title: "Clone failed",
                          message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
                          type: "error",
                          autoCloseMs: 6000,
                        });
                      } finally {
                        setCloning(false);
                      }
                    }}
                  >
                    {cloning() ? "Cloning..." : "Clone"}
                  </button>
                </div>
              </div>

              {/* Danger Row: Delete Instance */}
              <div class="setting-row full" style="border-left-color:var(--danger)">
                <div class="setting-info">
                  <span class="setting-name" style="color:var(--danger)">Delete instance</span>
                  <span class="setting-desc">Permanently remove this instance, including all mods, config files, world saves, and screenshots. This action cannot be undone.</span>
                </div>
                <div class="setting-control">
                  <Show when={!deleteConfirm()} fallback={
                    <div style="display:flex;gap:8px;align-items:center">
                      <input
                        class="field-control field-control--text"
                        style="max-width:140px;border-color:var(--danger)"
                        placeholder="Type Confirm"
                        onInput={(e) => setDeleteCountdown(e.currentTarget.value === "Confirm" ? 0 : 1)}
                      />
                      <button
                        class="btn btn--danger btn--sm"
                        disabled={deleteCountdown() !== 0}
                        onClick={async () => {
                          const inst = instance();
                          if (!inst) return;
                          await deleteInstance(inst.id);
                          await refetchInstances();
                          refreshPinnedInstanceIds().catch(() => {});
                          setActiveScreen("library");
                        }}
                      >
                        Delete
                      </button>
                      <button class="btn btn--ghost btn--sm" onClick={() => setDeleteConfirm(false)}>Cancel</button>
                    </div>
                  }>
                    <button
                      class="btn btn--danger btn--sm"
                      onClick={async () => {
                        const settings = await getSettings();
                        if (settings.force_delete) {
                          const inst = instance();
                          if (!inst) return;
                          await deleteInstance(inst.id);
                          await refetchInstances();
                          refreshPinnedInstanceIds().catch(() => {});
                          setActiveScreen("library");
                        } else {
                          setDeleteConfirm(true);
                          setDeleteCountdown(1);
                        }
                      }}
                    >
                      Delete Instance
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* ═══ CONTENT TAB ═══ */}
      <Show when={mainTab() === "content"}>
        <div class="inst-content-deck">
          {/* Sticky Controls Deck: Mode Toggle + Category Navigation + Filter Toolbar Box */}
          <div class="inst-content-sticky-deck">
            {/* Category Navigation: pure text links with active underline at the top */}
            <Show when={contentTab() === "installed"}>
              <div class="inst-category-nav inst-category-nav--installed">
                <div class="inst-category-links">
                  <button class={`inst-category-item ${installedFilter() === "all" ? "active" : ""}`} onClick={() => setInstalledFilter("all")}>All</button>
                  <button class={`inst-category-item ${installedFilter() === "mod" ? "active" : ""}`} onClick={() => setInstalledFilter("mod")}>Mods</button>
                  <button class={`inst-category-item ${installedFilter() === "resourcepack" ? "active" : ""}`} onClick={() => setInstalledFilter("resourcepack")}>Resources</button>
                  <button class={`inst-category-item ${installedFilter() === "shader" ? "active" : ""}`} onClick={() => setInstalledFilter("shader")}>Shaders</button>
                  <button class={`inst-category-item ${installedFilter() === "datapack" ? "active" : ""}`} onClick={() => setInstalledFilter("datapack")}>Datapacks</button>
                </div>
                <div class="inst-category-count-wrap">
                  <span class="inst-count-text">
                    <strong class="inst-count-bold">{installedSearch().trim() ? totalInstalledCount() : installedActiveCount()}</strong> {installedSearch().trim() ? "found" : "installed"}
                  </span>
                </div>
              </div>
            </Show>

            <Show when={contentTab() === "browse"}>
              <div class="inst-category-nav inst-category-nav--browse">
                <div class="inst-category-links">
                  <button class={`inst-category-item ${browseFilter() === "all" ? "active" : ""}`} onClick={() => setBrowseFilter("all")}>All</button>
                  <button class={`inst-category-item ${browseFilter() === "mod" ? "active" : ""}`} onClick={() => setBrowseFilter("mod")}>
                    Mods
                    <Show when={instance()?.loader?.type === "vanilla"}>
                      <span class="category-unsupported-tag">unsupported</span>
                    </Show>
                  </button>
                  <button class={`inst-category-item ${browseFilter() === "resourcepack" ? "active" : ""}`} onClick={() => setBrowseFilter("resourcepack")}>Resources</button>
                  <button class={`inst-category-item ${browseFilter() === "shader" ? "active" : ""}`} onClick={() => setBrowseFilter("shader")}>
                    Shaders
                    <Show when={instance()?.loader?.type === "vanilla"}>
                      <span class="category-unsupported-tag">unsupported</span>
                    </Show>
                  </button>
                  <button class={`inst-category-item ${browseFilter() === "datapack" ? "active" : ""}`} onClick={() => setBrowseFilter("datapack")}>Datapacks</button>
                </div>
                <div class="inst-category-count-wrap">
                  <Show when={searching()}>
                    <span class="inst-count-text">Searching...</span>
                  </Show>
                  <Show when={!searching() && totalHits() > 0 && !(instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader"))}>
                    <span class="inst-count-text">
                      <strong class="inst-count-bold">
                        {modSource() === "curseforge" && totalHits() >= 10000 ? "10,000+" : totalHits().toLocaleString()}
                      </strong> results
                    </span>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Filter & Search Toolbar (1-Row Solid Panel Box) */}
            <div class="inst-unified-toolbar">
              <div class="inst-toolbar-left">
                {/* Mode Segmented Toggle: Installed vs Browse */}
                <div class="inst-mode-segmented">
                  <button class={`inst-mode-tab ${contentTab() === "installed" ? "active" : ""}`} onClick={() => { setContentTab("installed"); refetchInstances(); refetchDetail(); }}>Installed</button>
                  <button class={`inst-mode-tab ${contentTab() === "browse" ? "active" : ""}`} onClick={() => setContentTab("browse")}>Browse</button>
                </div>

                <Show when={contentTab() === "installed"}>
                  <div class="inst-search-input-wrap">
                    <span class="inst-search-icon"><IconSearch /></span>
                    <input
                      class="field-control inst-search-input"
                      placeholder="Search installed..."
                      value={installedSearch()}
                      onInput={(e) => setInstalledSearch(e.currentTarget.value)}
                    />
                    <Show when={installedSearch().length > 0}>
                      <button class="inst-search-clear tip-below" onClick={() => setInstalledSearch("")} data-tip="Clear search" aria-label="Clear search">
                        <IconX />
                      </button>
                    </Show>
                  </div>
                </Show>

                <Show when={contentTab() === "browse"}>
                  <button
                    class={`btn inst-panel-btn mod-source-toggle ${modSource() === "modrinth" ? "mr" : "cf"} tip-below`}
                    onClick={handleSourceToggle}
                    data-tip={modSource() === "modrinth" ? "Switch to CurseForge" : "Switch to Modrinth"}
                  >
                    <Show when={modSource() === "modrinth"} fallback={<IconCurseForge />}>
                      <IconModrinth />
                    </Show>
                  </button>
                  <div class="inst-search-input-wrap">
                    <span class="inst-search-icon"><IconSearch /></span>
                    <input
                      class="field-control inst-search-input"
                      placeholder={modSource() === "modrinth" ? "Search Modrinth..." : "Search CurseForge..."}
                      value={searchQuery()}
                      onInput={(e) => handleSearch(e.currentTarget.value)}
                    />
                    <Show when={searchQuery().length > 0}>
                      <button class="inst-search-clear tip-below" onClick={() => handleSearch("")} data-tip="Clear search" aria-label="Clear search">
                        <IconX />
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>

              <div class="inst-toolbar-right">
                <Show when={contentTab() === "installed"}>
                  <Dropdown
                    prefix="Sort: "
                    value={installedSort()}
                    options={[
                      { value: "newest", label: "Newest first" },
                      { value: "oldest", label: "Oldest first" },
                    ]}
                    onChange={(val) => setInstalledSort(val as "newest" | "oldest")}
                    width="155px"
                  />
                  <button
                    class="btn inst-panel-btn inst-action-btn"
                    disabled={checkingUpdates() || (instance()?.mod_count ?? 0) === 0}
                    onClick={() => refreshUpdates(true)}
                  >
                    <span class={checkingUpdates() ? "spin-icon" : ""}>
                      <IconRefresh />
                    </span>
                    <span>{checkingUpdates() ? "Checking..." : "Updates"}</span>
                  </button>
                  <button
                    class="btn inst-panel-btn tip-below"
                    onClick={() => { if (instance()) openInstanceFolder(instance()!.id); }}
                    data-tip="Open folder"
                  >
                    <IconFolderOpen />
                  </button>
                  <button
                    type="button"
                    class={`btn inst-panel-btn inst-trash-btn tip-below ${installedSelectMode() ? "active" : ""}`}
                    data-tip={installedSelectMode() ? "Cancel" : "Select to delete"}
                    disabled={(() => {
                      const mods = instanceMods();
                      if (installedFilter() === "all") return mods.length === 0;
                      return mods.filter((m: any) => ((m as any).category || "mod") === installedFilter()).length === 0;
                    })()}
                    onClick={() => {
                      const next = !installedSelectMode();
                      setInstalledSelectMode(next);
                      setSelectedInstalled(new Set<string>());
                    }}
                  >
                    <Show when={installedSelectMode()} fallback={<IconTrash />}>
                      <IconX />
                    </Show>
                  </button>
                  {/* View Mode Toggle: Grid vs Compact pinned to far right */}
                  <div class="view-mode-tabs view-mode-toggle">
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
                      class={`view-mode-btn tip-below ${viewMode() === "compact" ? "active" : ""}`}
                      onClick={() => setViewMode("compact")}
                      data-tip="Compact view"
                      aria-label="Compact view"
                    >
                      <IconList />
                    </button>
                  </div>
                </Show>

                <Show when={contentTab() === "browse"}>
                  <Show when={!(instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader"))}>
                    <Dropdown
                      prefix="Version: "
                      value={browseVersion()}
                      options={browseVersionOptions()}
                      onChange={handleBrowseVersionChange}
                      searchable={true}
                      searchPlaceholder="Search versions..."
                      width="145px"
                    />
                    <Dropdown prefix="Sort: " value={sortBy()} options={SORT_OPTIONS} onChange={handleSortChange} width="155px" />
                  </Show>
                  <button
                    class={`btn inst-panel-btn inst-action-btn ${selectMode() ? "active" : ""}`}
                    onClick={() => { setSelectMode(!selectMode()); if (selectMode()) setSelectedItems(new Map()); }}
                  >
                    {selectMode() ? `Cancel (${selectedItems().size})` : "Select"}
                  </button>
                  {/* View Mode Toggle: Grid vs Compact pinned to far right */}
                  <div class="view-mode-tabs view-mode-toggle">
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
                      class={`view-mode-btn tip-below ${viewMode() === "compact" ? "active" : ""}`}
                      onClick={() => setViewMode("compact")}
                      data-tip="Compact view"
                      aria-label="Compact view"
                    >
                      <IconList />
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </div>

          {/* ═══ INSTALLED CONTENT TAB ═══ */}
          <Show when={contentTab() === "installed"}>
            <Show when={(instance()?.mod_count || 0) === 0}>
            <div style="text-align:center;color:var(--muted);padding:30px;font-size:var(--fs-xs)">No content installed. Switch to "Browse mods" to find some.</div>
          </Show>
          <Show when={(instance()?.mod_count || 0) > 0 && totalInstalledCount() === 0}>
            <div style="text-align:center;color:var(--muted);padding:30px;font-size:var(--fs-xs)">No installed content matches your search.</div>
          </Show>
          <div class={`inst-card-grid ${viewMode() === "compact" ? "compact" : ""}`}>
            {/* Managed-mod entry for the Vermeil companion mod. Shown on page 1 of
                supported instances; the toggle here turns Vermeil's in-game
                features on/off for this instance (the jar is disabled in place,
                not deleted, so re-enabling needs no re-download). The jar itself
                is launcher-managed, so there's no delete affordance. */}
            <Show when={showCompanion() && installedPage() === 1}>
              <div class="card card--mod" style={(instance()?.companion_enabled === false || installedSelectMode()) ? "opacity:0.45" : ""}>
                <div class="mod-card-header">
                  <div class="mod-card-icon mod-card-icon--companion">
                    <img src="/logo.png" alt="" draggable={false} />
                  </div>
                  <div class="mod-card-name-wrap">
                    <div class="mod-card-name">Vermeil companion mod</div>
                    <div class="mod-card-author">by Vermeil</div>
                  </div>
                </div>
                <div class="mod-card-desc">Vermeil's custom in-game features on supported versions. Auto-installed and managed by the launcher.</div>
                <Show when={instance()}>
                  <div class="mod-card-tags">
                    <span class={`mod-tag mod-tag-loader loader-${instance()!.loader.type}`}>
                      {instance()!.loader.type === "vanilla" ? "Vanilla" : instance()!.loader.type.charAt(0).toUpperCase() + instance()!.loader.type.slice(1)}
                    </span>
                    <span class="mod-tag mod-tag-version">{instance()!.game_version}</span>
                    <Show when={instance()?.companion_version || (instanceDetail() as any)?.companion_version}>
                      {(v) => <span class="mod-tag mod-tag-vnum">{v()}</span>}
                    </Show>
                  </div>
                </Show>
                <div class="mod-card-footer">
                  <div class="mod-card-meta">mod · Managed</div>
                  <div class="mod-card-actions">
                    <button
                      type="button"
                      class={`btn btn--sm btn--icon btn--toggle ${(instance()?.companion_enabled ?? true) ? "active" : ""} tip-right`}
                      data-tip={(instance()?.companion_enabled ?? true) ? "Disable companion" : "Enable companion"}
                      aria-label="Toggle Vermeil features on this instance"
                      disabled={installedSelectMode()}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const inst = instance();
                        if (!inst) return;
                        const next = !(inst.companion_enabled ?? true);
                        try {
                          await setInstanceCompanionEnabled(inst.id, next);
                          await refetchInstances();
                          await refetchDetail();
                        } catch (e) {
                          showToast({ title: "Couldn't update", message: String(e), type: "error" });
                        }
                      }}
                    >
                      <IconCheck />
                    </button>
                  </div>
                </div>
              </div>
            </Show>
            <For each={pagedInstalledMods()}>
              {(mod) => (
                <div
                  class={`card card--mod ${installedSelectMode() && selectedInstalled().has(mod.id) ? "mod-item-selected" : ""}`}
                  style={{
                    opacity: mod.enabled ? (isDeletingInstalled() && selectedInstalled().has(mod.id) ? "0.4" : "1") : "0.5",
                    cursor: installedSelectMode() ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (installedSelectMode()) {
                      const s = new Set(selectedInstalled());
                      if (s.has(mod.id)) s.delete(mod.id);
                      else s.add(mod.id);
                      setSelectedInstalled(s);
                    }
                  }}
                >
                  <Show when={installedSelectMode()}>
                    <div class={`mod-select-check ${selectedInstalled().has(mod.id) ? "is-selected" : ""}`}>
                      <Show when={selectedInstalled().has(mod.id)}>
                        <IconCheck />
                      </Show>
                    </div>
                  </Show>
                  <div class="mod-card-header">
                    <div class="mod-card-icon">
                      <Show when={resolveIconUrl(mod as any)} fallback={
                        <span class="side-icon" style="width:20px;height:20px">{(mod as any).category === "resourcepack" ? <IconShirt /> : (mod as any).category === "shader" ? <IconWand /> : <IconCube />}</span>
                      }>
                        <img
                          src={resolveIconUrl(mod as any)!}
                          alt=""
                          draggable={false}
                          onError={(e) => {
                            const fallback = (mod as any).icon_url;
                            if (fallback && e.currentTarget.src !== fallback) {
                              e.currentTarget.src = fallback;
                            } else {
                              e.currentTarget.style.display = "none";
                            }
                          }}
                        />
                      </Show>
                    </div>
                    <div class="mod-card-name-wrap">
                      <div class="mod-card-name">{mod.title || mod.filename}</div>
                      <Show when={(mod as any).author}>
                        <div class="mod-card-author">by {(mod as any).author}</div>
                      </Show>
                    </div>
                  </div>
                  <div class="mod-card-desc">{mod.description || ""}</div>
                  {/* Installed cards show the instance's loader + MC version
                      since that's what the file is compatible with — Modrinth
                      doesn't ship a per-mod compatibility tag in the install
                      manifest. Resource packs / shaders only show the MC ver.
                      The optional update pill is rendered alongside so it
                      sits in the user's eye-line right below the title. */}
                  <Show when={instance()}>
                    {(() => {
                      const isMod = ((mod as any).category || "mod") === "mod";
                      const isCompatible = isInstalledModCompatible(mod, instance()?.loader.type);
                      const displayLoader = getInstalledModDisplayLoader(mod, instance()?.loader.type);
                      const loaderLabel = displayLoader.charAt(0).toUpperCase() + displayLoader.slice(1);
                      return (
                        <div class="mod-card-tags">
                          <Show when={isMod}>
                            <span class={`mod-tag mod-tag-loader loader-${displayLoader.toLowerCase()}`}>
                              {loaderLabel}
                            </span>
                          </Show>
                          <Show when={isMod && !isCompatible}>
                            <span
                              class="mod-tag mod-tag-incompatible tip-below"
                              data-tip={`Built for ${loaderLabel}, incompatible with ${instance()!.loader.type}`}
                            >
                              Incompatible
                            </span>
                          </Show>
                          <span class="mod-tag mod-tag-version">{instance()!.game_version}</span>
                          <Show when={contentVersion((mod as any).version_number, mod.filename, instance()!.game_version)}>
                            {(v) => <span class="mod-tag mod-tag-vnum">{v()}</span>}
                          </Show>
                          {/* A pinned entry is skipped by the update checker, so its
                              update pill never appears. Without this tag that looks
                              like the mod simply never updates, with no reason
                              given. */}
                          <Show when={(mod as any).pinned}>
                            <span
                              class="mod-tag mod-tag-held tip-below"
                              data-tip="Locked by dependency"
                            >
                              held
                            </span>
                          </Show>
                        </div>
                      );
                    })()}
                  </Show>
                  <div class="mod-card-footer">
                    <div class="mod-card-meta">{(mod as any).category || "mod"} · {mod.enabled ? "Enabled" : "Disabled"}</div>
                    <div class="mod-card-actions">
                      <Show when={modUpdates().has(mod.project_id)}>
                        <button
                          class="btn btn--sm btn--success btn--mod-update tip-right"
                          disabled={installedSelectMode() || isTaskQueuedOrActive(mod.project_id, instance()?.id)}
                          data-tip={`Update to ${modUpdates().get(mod.project_id)?.latest_version_number}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpdateMod(mod.project_id, mod.title || mod.filename);
                          }}
                        >
                          <IconArrowUp />
                          <span>
                            {isTaskActive(mod.project_id, instance()?.id)
                              ? "Updating..."
                              : isTaskQueued(mod.project_id, instance()?.id)
                              ? "Queued"
                              : "Update"}
                          </span>
                        </button>
                      </Show>
                      {(() => {
                        const isCompatible = isInstalledModCompatible(mod, instance()?.loader.type);
                        const isLocked = installedSelectMode() || (!mod.enabled && !isCompatible);
                        const displayLoader = getInstalledModDisplayLoader(mod, instance()?.loader.type);
                        const loaderLabel = displayLoader.charAt(0).toUpperCase() + displayLoader.slice(1);
                        const toggleTip = !isCompatible && !mod.enabled
                          ? `Cannot enable: built for ${loaderLabel}, incompatible with ${instance()!.loader.type}`
                          : mod.enabled
                          ? "Disable mod"
                          : "Enable mod";
                        return (
                          <button
                            type="button"
                            class={`btn btn--sm btn--icon btn--toggle ${mod.enabled ? "active" : ""} tip-right`}
                            data-tip={toggleTip}
                            aria-label={toggleTip}
                            disabled={isLocked}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const inst = instance();
                              if (!inst) return;
                              try {
                                await toggleModInInstance(inst.id, mod.id);
                                await refetchInstances();
                                await refetchDetail();
                              } catch (err: any) {
                                showToast({
                                  title: "Cannot enable mod",
                                  message: String(err),
                                  type: "error",
                                });
                              }
                            }}
                          >
                            <IconCheck />
                          </button>
                        );
                      })()}
                      <button
                        type="button"
                        class="btn btn--danger btn--sm btn--icon tip-right"
                        data-tip="Remove"
                        aria-label="Remove"
                        disabled={installedSelectMode()}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const inst = instance();
                          if (!inst) return;
                          await removeModFromInstance(inst.id, mod.id);
                          await refetchInstances();
                          await refetchDetail();
                        }}
                      >
                        <IconX />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Floating delete dock — appears when in select mode */}
          <Show when={installedSelectMode()}>
            <SelectionDock
              count={selectedInstalled().size}
              mode="delete"
              primaryLabel={isDeletingInstalled() ? "Deleting..." : "Delete"}
              primaryDisabled={selectedInstalled().size === 0 || isDeletingInstalled()}
              primaryLoading={isDeletingInstalled()}
              onPrimary={async () => {
                const inst = instance();
                if (!inst || selectedInstalled().size === 0) return;
                setIsDeletingInstalled(true);
                try {
                  const ids = Array.from(selectedInstalled());
                  const count = await removeModsFromInstance(inst.id, ids);
                  setSelectedInstalled(new Set<string>());
                  setInstalledSelectMode(false);
                  await refetchInstances();
                  await refetchDetail();
                  showToast({
                    title: "Content deleted",
                    message: `Removed ${count} ${count === 1 ? "entry" : "entries"}`,
                    type: "success",
                    autoCloseMs: 3000,
                  });
                } catch (e: any) {
                  showToast({
                    title: "Delete failed",
                    message: typeof e === "string" ? e : (e?.message || "Unknown error"),
                    type: "error",
                    autoCloseMs: 5000,
                  });
                } finally {
                  setIsDeletingInstalled(false);
                }
              }}
              onClear={() => {
                setInstalledSelectMode(false);
                setSelectedInstalled(new Set<string>());
              }}
              clearLabel="Cancel"
              icon={<IconTrash2 />}
            >
              <button
                class="btn btn--secondary btn--sm"
                onClick={() => {
                  const currentMods = installedFiltered();
                  if (selectedInstalled().size === currentMods.length && currentMods.length > 0) {
                    setSelectedInstalled(new Set<string>());
                  } else {
                    setSelectedInstalled(new Set(currentMods.map((m: any) => m.id)));
                  }
                }}
              >
                {selectedInstalled().size === installedFiltered().length && installedFiltered().length > 0
                  ? "Deselect All"
                  : "Select All"}
              </button>
            </SelectionDock>
          </Show>
        </Show>

        <Show when={contentTab() === "browse"}>
          <div class="browse-wrapper">
            <div class="browse-results">
              <Show when={instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")}>
                <div class="vanilla-unsupported-panel">
                  <div class="vanilla-unsupported-art-wrap">
                    <div class="vanilla-unsupported-glow" />
                    <div class="vanilla-unsupported-art">
                      <div class="vanilla-cube-graphic">
                        <Show when={browseFilter() === "shader"} fallback={<IconCube />}>
                          <IconWand />
                        </Show>
                      </div>
                      <div class="vanilla-badge-slash" data-tip={browseFilter() === "shader" ? "Shaders unsupported" : "Mods unsupported"}>
                        <IconX />
                      </div>
                    </div>
                  </div>

                  <div class="vanilla-unsupported-header">
                    <span class="vanilla-unsupported-pill">Vanilla Loader Active</span>
                    <h3 class="vanilla-unsupported-title">
                      {browseFilter() === "shader" ? "Shaders Are Unsupported on Vanilla" : "Mods Are Unsupported on Vanilla"}
                    </h3>
                    <p class="vanilla-unsupported-desc">
                      {browseFilter() === "shader" ? (
                        <>
                          Vanilla Minecraft has no built-in shader pipeline. Shaderpacks (.zip) require a shader loader mod such as <strong>Iris</strong> (Fabric/NeoForge) or <strong>Oculus</strong> (Forge).
                        </>
                      ) : (
                        <>
                          This instance is running vanilla Minecraft. The official game engine cannot load or run code mods (.jar) without a modding loader such as <strong>Fabric</strong>, <strong>NeoForge</strong>, <strong>Forge</strong>, or <strong>Quilt</strong>.
                        </>
                      )}
                    </p>
                  </div>

                  <div class="vanilla-unsupported-guide">
                    <div class="vanilla-guide-card">
                      <div class="vanilla-guide-icon"><IconSettings /></div>
                      <div class="vanilla-guide-info">
                        <div class="vanilla-guide-title">{browseFilter() === "shader" ? "Want to use shaders?" : "Want to use mods?"}</div>
                        <div class="vanilla-guide-text">
                          {browseFilter() === "shader"
                            ? "Switch to Fabric or NeoForge in settings to enable Iris Shaders."
                            : "Change this instance's loader to Fabric, NeoForge, or Forge in settings."}
                        </div>
                      </div>
                      <button class="btn btn--primary btn--sm vanilla-guide-btn" onClick={() => setMainTab("settings")}>
                        Change Loader
                      </button>
                    </div>

                    <div class="vanilla-guide-card">
                      <div class="vanilla-guide-icon"><IconImage /></div>
                      <div class="vanilla-guide-info">
                        <div class="vanilla-guide-title">Looking for visuals?</div>
                        <div class="vanilla-guide-text">Vanilla supports custom textures, models, and audio packs without mods.</div>
                      </div>
                      <button class="btn btn--outline btn--sm vanilla-guide-btn" onClick={() => setBrowseFilter("resourcepack")}>
                        Browse Resources
                      </button>
                    </div>

                    <div class="vanilla-guide-card">
                      <div class="vanilla-guide-icon"><IconWand /></div>
                      <div class="vanilla-guide-info">
                        <div class="vanilla-guide-title">Custom mechanics?</div>
                        <div class="vanilla-guide-text">Vanilla supports Datapacks for custom loot tables, recipes, and advancements.</div>
                      </div>
                      <button class="btn btn--outline btn--sm vanilla-guide-btn" onClick={() => setBrowseFilter("datapack")}>
                        Browse Datapacks
                      </button>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!(instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")) && searching()}>
                <div class="browse-status-pane">
                  <div class="browse-loading-spinner" />
                  <div class="browse-status-text">Searching {modSource() === "curseforge" ? "CurseForge" : "Modrinth"}...</div>
                </div>
              </Show>

              <Show when={!(instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")) && !searching() && displayBrowseResults().length === 0}>
                <div class="browse-status-pane">
                  <div class="browse-status-icon"><IconSearch /></div>
                  <div class="browse-status-title">No results found</div>
                  <div class="browse-status-text">
                    {searchQuery()
                      ? `No items matching "${searchQuery()}" were found.`
                      : "No compatible content found for this filter."}
                  </div>
                </div>
              </Show>

              <Show when={!(instance()?.loader?.type === "vanilla" && (browseFilter() === "mod" || browseFilter() === "shader")) && !searching() && displayBrowseResults().length > 0}>
                <div class={`inst-card-grid ${viewMode() === "compact" ? "compact" : ""}`}>
                <For each={displayBrowseResults()}>
                {(mod) => (
                  <div class={`card card--mod ${selectMode() && selectedItems().has(mod.project_id) ? "mod-item-selected" : ""}`}
                    onClick={() => handleCardClick(mod)}>
                    <div class="mod-card-header">
                      <div class="mod-card-icon">
                        <Show when={mod.icon_url} fallback={<IconBolt />}>
                          <img src={mod.icon_url!} />
                        </Show>
                      </div>
                      <div class="mod-card-name-wrap">
                        <div class="mod-card-name">{mod.title}</div>
                        <Show when={mod.author}>
                          <div class="mod-card-author">by {mod.author}</div>
                        </Show>
                      </div>
                    </div>
                    <div class="mod-card-desc">{mod.description}</div>
                    <div class="mod-card-tags">
                      {(() => {
                        const currentCat = detectCategory(mod, instance()?.loader?.type);
                        const tags = extractCardTags(mod.categories);
                        return (
                          <>
                            <Show when={browseFilter() === "all"}>
                              <span class={`mod-tag mod-tag-type mod-tag-type--${currentCat}`}>
                                {categoryLabel(currentCat)}
                              </span>
                            </Show>
                            <Show when={tags.loader && currentCat === "mod"}>
                              <span class={`mod-tag mod-tag-loader loader-${tags.loader}`}>
                                {tags.loader === "vanilla" ? "Vanilla" : tags.loader!.charAt(0).toUpperCase() + tags.loader!.slice(1)}
                              </span>
                            </Show>
                            <Show when={tags.tag}>
                              <span class="mod-tag">{tags.tag}</span>
                            </Show>
                            <Show when={!tags.tag && mod.versions && mod.versions.length > 0}>
                              <span class="mod-tag mod-tag-version">{formatVersionRange(mod.versions)}</span>
                            </Show>
                          </>
                        );
                      })()}
                    </div>
                    <div class="mod-card-footer">
                      <div class="mod-card-meta">
                        <span class="mod-meta-stat"><IconDownload /> {formatDownloads(mod.downloads)}</span>
                        <Show when={mod.follows > 0}>
                          <span>·</span>
                          <span class="mod-meta-stat"><IconHeart /> {formatDownloads(mod.follows)}</span>
                        </Show>
                        <Show when={mod.client_side || mod.server_side}>
                          {" · "}
                          <Show when={mod.client_side === "required" || mod.client_side === "optional"}>
                            <span class="side-icon" data-tip={`Client: ${mod.client_side}`}><IconMonitor /></span>
                          </Show>
                          <Show when={mod.server_side === "required" || mod.server_side === "optional"}>
                            <span class="side-icon" data-tip={`Server: ${mod.server_side}`}><IconGlobe /></span>
                          </Show>
                        </Show>
                      </div>
                      <Show when={isModInstalled(mod.project_id)}>
                        <span class="btn btn--installed"><IconCheck /> Installed</span>
                      </Show>
                      <Show when={!isModInstalled(mod.project_id)}>
                        <Show when={selectMode()} fallback={
                          /* stopPropagation so installing doesn't also toggle
                             the card's detail view. */
                          <button class="btn btn--sm btn--primary" disabled={isTaskQueuedOrActive(mod.project_id, instance()?.id)}
                            onClick={(e) => { e.stopPropagation(); handleCardInstall(mod); }}>
                            {isTaskActive(mod.project_id, instance()?.id) ? "..." : isTaskQueued(mod.project_id, instance()?.id) ? "Queued" : "+ Install"}
                          </button>
                        }>
                          <div class={`select-check ${selectedItems().has(mod.project_id) ? "checked" : ""}`}>
                            <Show when={selectedItems().has(mod.project_id)}><span class="side-icon"><IconCheck /></span></Show>
                          </div>
                        </Show>
                      </Show>
                    </div>

                  </div>
                )}
              </For>
              </div>
              </Show>
            </div>
            {/* Detail overlay. Outside the grid, so opening it can't reflow the
                results behind it. */}
            <ModDetailModal
              mod={detailMod()}
              source={modSource()}
              loader={instance()?.loader?.type ?? ""}
              /* The instance's version, deliberately NOT the free-text version
                 box. That box scopes the *search*; compatibility has to be judged
                 against the instance we'd install into, which is the version
                 `handleInstallMod` passes. Using the box here let the picker
                 label a version compatible that the installer then resolved
                 differently — or, on CurseForge, silently substituted. */
              gameVersion={instance()?.game_version ?? ""}
              category={browseFilter() === "all" ? (detailMod() ? detectCategory(detailMod()!, instance()?.loader?.type) : "mod") : browseFilter()}
              loaders={detailMod() ? extractLoaders(detailMod()!.categories) : []}
              installedVersionId={instanceMods().find((m: any) => m.project_id === detailMod()?.project_id)?.version_id}
              busy={isTaskQueuedOrActive(detailMod()?.project_id || "", instance()?.id)}
              onClose={() => setDetailMod(null)}
              /* Close on install. The install-progress popup and toasts sit at
                 z-index 9998/9999, well above the modal overlay's 50, so leaving
                 the overlay open would let them land on top of its controls.
                 Closing also matches the intent — the choice has been made. */
              onInstall={(v) => {
                const m = detailMod();
                if (!m) return;
                setDetailMod(null);
                handleInstallMod(m, v.id);
              }}
            />
            {/* Compatibility Confirmation Modal */}
            <Show when={incompatiblePrompt()}>
              {(prompt) => (
                <div class="modal-overlay" onClick={() => setIncompatiblePrompt(null)}>
                  <div
                    class="modal panel panel--bracketed"
                    style="max-width: 500px; width: 100%;"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="modal-header">
                      <div class="modal-header-left">
                        <span class="card-section-tag tag-settings-accent">
                          COMPATIBILITY NOTICE
                        </span>
                        <span class="modal-title">
                          No Matching Version Found
                        </span>
                      </div>
                    </div>

                    <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
                      {/* Target Content Banner */}
                      <div style="display: flex; align-items: center; gap: 14px; padding: 12px; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm, 4px);">
                        <div style="width: 44px; height: 44px; border-radius: var(--radius-sm, 4px); overflow: hidden; background: var(--surface-panel); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--border);">
                          <Show
                            when={prompt().mod.icon_url}
                            fallback={<span style="color: var(--accent);"><IconPackage /></span>}
                          >
                            <img
                              src={prompt().mod.icon_url!}
                              alt=""
                              style="width: 100%; height: 100%; object-fit: cover;"
                            />
                          </Show>
                        </div>
                        <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                          <span style="font-weight: 600; font-size: var(--fs-md, 14px); color: var(--text-bright, #fff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            {prompt().mod.title}
                          </span>
                          <span style="font-size: var(--fs-xs, 12px); color: var(--text-muted); text-transform: capitalize;">
                            {prompt().category === "resourcepack" ? "Resource Pack" : prompt().category === "shader" ? "Shader Pack" : prompt().category}
                            {prompt().mod.author ? ` · by ${prompt().mod.author}` : ""}
                          </span>
                        </div>
                      </div>

                      {/* Explanation Text */}
                      <div style="font-size: var(--fs-sm, 13px); line-height: 1.5; color: var(--text);">
                        <p style="margin: 0 0 10px 0;">
                          No release strictly targeting <strong>Minecraft {prompt().gameVersion}</strong>
                          <Show when={prompt().category === "mod" && prompt().loader && prompt().loader !== "vanilla"}>
                            {" "}(<strong>{prompt().loader}</strong>)
                          </Show>{" "}
                          was found for this {prompt().category === "resourcepack" ? "resource pack" : prompt().category === "shader" ? "shader" : "content"}.
                        </p>
                        <Show
                          when={prompt().category === "resourcepack" || prompt().category === "shader"}
                          fallback={
                            <p style="margin: 0; color: var(--warn);">
                              Installing an incompatible mod may cause Minecraft to crash during startup or corrupt instance state.
                            </p>
                          }
                        >
                          <p style="margin: 0; color: var(--text-muted);">
                            Resource packs and shaders frequently continue to work across Minecraft releases. You can force-install the latest available build or browse all files.
                          </p>
                        </Show>
                      </div>

                      {/* Version details box */}
                      <div style="display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); font-size: var(--fs-xs, 12px);">
                        <div style="display: flex; justify-content: space-between; gap: 12px;">
                          <span style="color: var(--text-muted);">Instance target:</span>
                          <span style="font-weight: 500; color: var(--text-bright);">
                            Minecraft {prompt().gameVersion}
                            <Show when={prompt().loader && prompt().loader !== "vanilla"}>
                              {" "}· {prompt().loader}
                            </Show>
                          </span>
                        </div>
                        <div style="display: flex; justify-content: space-between; gap: 12px;">
                          <span style="color: var(--text-muted);">Latest available build:</span>
                          <span style="font-weight: 500; color: var(--accent);">
                            <Show when={!prompt().resolvingVersion} fallback={"Resolving..."}>
                              {prompt().latestVersionName || prompt().latestVersionId || "Latest release"}
                            </Show>
                          </span>
                        </div>
                        <Show when={prompt().supportedVersions.length > 0}>
                          <div style="display: flex; justify-content: space-between; gap: 12px;">
                            <span style="color: var(--text-muted);">Known versions:</span>
                            <span style="color: var(--text); text-align: right; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" data-tip={prompt().supportedVersions.join(", ")}>
                              {prompt().supportedVersions.slice(0, 5).join(", ")}
                              {prompt().supportedVersions.length > 5 ? ` +${prompt().supportedVersions.length - 5} more` : ""}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </div>

                    {/* Modal Footer with Actions */}
                    <div class="modal-footer" style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
                      <button
                        type="button"
                        class="btn btn--subtle"
                        onClick={() => setIncompatiblePrompt(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="btn btn--secondary"
                        onClick={() => {
                          const p = prompt();
                          setIncompatiblePrompt(null);
                          setDetailMod(p.mod);
                        }}
                      >
                        Browse All Versions
                      </button>
                      <button
                        type="button"
                        class="btn btn--primary"
                        disabled={prompt().resolvingVersion || !prompt().latestVersionId}
                        onClick={() => {
                          const p = prompt();
                          setIncompatiblePrompt(null);
                          if (p.latestVersionId) {
                            handleInstallMod(p.mod, p.latestVersionId);
                          }
                        }}
                      >
                        <IconDownload />
                        <span>Install Latest Anyway</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Show>
            {/* Bulk install floating dock */}
            <Show when={selectMode() && selectedItems().size > 0 && !bulkInstalling()}>
              <SelectionDock
                count={selectedItems().size}
                mode="install"
                primaryLabel="Install"
                onPrimary={handleBulkInstall}
                onClear={() => setSelectedItems(new Map())}
                icon={<IconDownload />}
              />
            </Show>
          </div>
        </Show>
        </div>
      </Show>

      {/* ═══ FILES TAB ═══ */}
      <Show when={mainTab() === "files"}>
        <div style="padding-top:var(--space-4)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <Show when={filePath()}>
              <button class="btn btn--sm btn--subtle" onClick={navigateUp}>
                <IconArrowLeft />
                <span>Back</span>
              </button>
            </Show>
            <span style="font-size:var(--fs-xs);color:var(--muted);font-family:var(--font-mono)">
              /{filePath() || ""}
            </span>
            <button class="btn btn--sm" style="margin-left:auto" onClick={() => openInstanceFolder(instance()!.id, filePath())}>
              Open in Explorer
            </button>
          </div>
          <div class="mod-list">
            <For each={files()}>
              {(file) => (
                <div class="mod-item" style="cursor:pointer" onClick={() => file.is_dir && navigateToFolder(file.path)}>
                  <div class="mod-icon" style={file.is_dir ? "background:var(--accent-soft)" : "background:var(--surface-sunken)"}>
                    <Show when={file.is_dir} fallback={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    }>
                      <IconFolderOpen />
                    </Show>
                  </div>
                  <div class="mod-details">
                    <div class="mod-name">{file.name}</div>
                    <div class="mod-stats">{file.is_dir ? "Folder" : formatSize(file.size)}</div>
                  </div>
                </div>
              )}
            </For>
            <Show when={files().length === 0}>
              <div style="text-align:center;color:var(--muted);padding:30px;font-size:var(--fs-xs)">Empty folder</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* ═══ WORLDS TAB ═══ */}
      <Show when={mainTab() === "worlds"}>
        <div style="padding-top:var(--space-4)">
          <Show when={worlds().length === 0}>
            <div style="text-align:center;color:var(--muted);padding:30px;font-size:var(--fs-xs)">No worlds yet. Play the game to create one.</div>
          </Show>
          <div class="mod-list">
            <For each={worlds()}>
              {(world) => (
                <div class="mod-item">
                  <div class="mod-icon" style="background:var(--accent-soft);overflow:hidden;">
                    <Show when={world.icon} fallback={<IconGlobe />}>
                      <img src={world.icon!} alt="" style="width:100%;height:100%;object-fit:cover;image-rendering:pixelated;" />
                    </Show>
                  </div>
                  <div class="mod-details">
                    <div class="mod-name">{world.name}</div>
                    <div class="mod-stats">
                      {world.game_mode} · {world.size_mb} MB
                      {world.play_time_seconds > 0 ? ` · ${formatPlaytime(world.play_time_seconds)}` : ""}
                    </div>
                  </div>
                  <button class="btn btn--sm" onClick={() => openInstanceFolder(instance()!.id, `saves/${world.folder_name}`)}>
                    Open
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ═══ LOGS TAB ═══ */}
      <Show when={mainTab() === "logs"}>
        <Show
          when={!logsPoppedOut()}
          fallback={
            <div class="logs-detached">
              <div style="font-size:var(--fs-sm)">Logs are open in a separate window.</div>
              <button class="btn" onClick={() => closeLogsWindow()}>Bring logs back</button>
            </div>
          }
        >
          <div class="inst-logs-tab" style="margin-top:var(--space-4)">
            <div class="log-toolbar">
              {/* Filter chips on the left */}
              <div class="log-toolbar-filters">
                <button
                  type="button"
                  class={`log-filter-btn ${logFilters().has("all") ? "active" : ""}`}
                  onClick={() => toggleLogFilter("all")}
                >
                  All
                </button>
                <button
                  type="button"
                  class={`log-filter-btn error ${logFilters().has("error") ? "active" : ""}`}
                  onClick={() => toggleLogFilter("error")}
                >
                  Errors
                </button>
                <button
                  type="button"
                  class={`log-filter-btn warn ${logFilters().has("warn") ? "active" : ""}`}
                  onClick={() => toggleLogFilter("warn")}
                >
                  Warnings
                </button>
              </div>

              {/* Search input — case-insensitive substring match across log lines. */}
              <div class="log-toolbar-search">
                <span class="log-toolbar-search-icon"><IconSearch /></span>
                <input
                  class="log-toolbar-search-input"
                  type="text"
                  spellcheck={false}
                  placeholder="Search logs..."
                  value={logSearch()}
                  onInput={(e) => setLogSearch(e.currentTarget.value)}
                />
                <Show when={logSearch()}>
                  <button
                    type="button"
                    class="log-toolbar-search-clear tip-below"
                    onClick={() => setLogSearch("")}
                    data-tip="Clear search"
                    aria-label="Clear search"
                  >
                    <span class="side-icon"><IconX /></span>
                  </button>
                </Show>
              </div>

              {/* Jump-to-top / jump-to-bottom + line count on the right */}
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
                class={`log-toolbar-jump tip-below ${autoScrollLogs() ? "active" : ""}`}
                onClick={jumpToBottom}
                data-tip={autoScrollLogs() ? "Lock scroll" : "Jump to bottom"}
                aria-label="Jump to latest"
              >
                <IconArrowDown />
              </button>
              <span class="log-toolbar-count">
                <Show when={filteredLogs().length !== logs().length} fallback={`${logs().length} lines`}>
                  {filteredLogs().length} / {logs().length} lines
                </Show>
              </span>
            </div>

            <div class="log-viewer-frame">
              {/* Log placeholder — Feather-style terminal icon (MIT).
                  Pinned to the frame so it stays centered regardless of log scroll.
                  Disappears as soon as any log line is present. */}
              <Show when={filteredLogs().length === 0}>
                <div class="log-ascii-backdrop">
                  <svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 24 24" fill="none" stroke="url(#log-grad)" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round">
                    <defs>
                      <linearGradient id="log-grad" x1="0%" y1="0%" x2="100%" y2="100%">
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
                    if (viewerEl && autoScrollLogs()) {
                      viewerEl.scrollTop = viewerEl.scrollHeight;
                    }
                  });
                }}
              >
                <Show when={filteredLogs().length === 0}>
                  <div class="log-empty-hint">
                    <Show
                      when={gameRunning()}
                      fallback={
                        <Show
                          when={logSearch()}
                          fallback={<span>No logs yet. Launch the game to see output here.</span>}
                        >
                          <span>No matches for "{logSearch()}".</span>
                        </Show>
                      }
                    >
                      <span>Waiting for game output...</span>
                    </Show>
                  </div>
                </Show>
                <For each={filteredLogs()}>
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
        </Show>
      </Show>

      </Show>

      <ChangeLoaderModal />
    </div>
  );
};

export default InstanceMods;
