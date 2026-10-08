// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createResource, createEffect, Show, onMount, onCleanup, lazy, untrack } from "solid-js";
import FloatingDock from "./components/FloatingDock";
import Titlebar from "./components/Titlebar";
import ResizeHandles from "./components/ResizeHandles";
import Home from "./screens/Home";
import Library from "./screens/Library";
import InstanceMods from "./screens/InstanceMods";
import Settings from "./screens/Settings";
import Account from "./screens/Account";
import Downloads from "./screens/Downloads";
// Lazy-load the Skins screen because skinview3d pulls in ~500 KB of three.js
// that we don't want to pay for unless the user actually opens Skins.
const Skins = lazy(() => import("./screens/Skins"));
import CreateChoose from "./modals/CreateChoose";
import CreateCustom from "./modals/CreateCustom";
import BrowseModpacks from "./modals/BrowseModpacks";
import ImportInstance from "./modals/ImportInstance";
import NoAccountModal from "./components/NoAccountModal";
import Toasts, { showToast, updateToast, dismissToast, isToastActive } from "./components/Toasts";
import { initInstallProgress } from "./services/installProgress";
import BulkInstallToast from "./components/BulkInstallToast";
import Splash from "./components/Splash";
import DependencyIssuesModal from "./components/DependencyIssuesModal";
import ManualDownloadModal from "./components/ManualDownloadModal";
import UpdateBanner from "./components/UpdateBanner";
import CrashReportModal, { showCrashReport } from "./components/CrashReportModal";
import OnboardingWizard, { openOnboarding } from "./modals/OnboardingWizard";
import PinInstancesModal, { pinInstancesModalOpen, closePinInstancesModal } from "./modals/PinInstancesModal";
import InstancePickerModal, { instancePickerModalOpen, closeInstancePickerModal } from "./modals/InstancePickerModal";
import ServerRoutingModal, { serverRoutingModalOpen, closeServerRoutingModal } from "./modals/ServerRoutingModal";
import { listInstances, getActiveAccount, getSettings, getSkinProfile, getIngameCape, listCustomCapes, showWindow, loadDownloadHistory, saveDownloadHistory, isGoogleCloudConnected, setThemeIcon, type LocalSkin, type SkinVariant, type CustomCape, type Instance, type LauncherSettings } from "./ipc/commands";
import { listen } from "@tauri-apps/api/event";
import { checkForUpdates } from "./services/updater";
import { matchesKeybind, resolveBinding } from "./lib/keybinds";
import { getThemeLogo } from "./lib/theme";

export type Screen =
  | "home"
  | "library"
  | "mods"
  | "settings"
  | "account"
  | "skins"
  | "downloads"
  | "create-choose"
  | "create-custom"
  | "create-modpack"
  | "create-import";

const [activeScreen, _setActiveScreen] = createSignal<Screen>("home");
const setActiveScreen = (screen: Screen) => {
  _setActiveScreen(screen);
  // Reset scroll position on navigation
  setTimeout(() => document.querySelector(".content")?.scrollTo(0, 0), 0);
};
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null);
const [initialInstanceTab, setInitialInstanceTab] = createSignal<string>("content");
const [gameLaunched, setGameLaunched] = createSignal(false);
const [gameRunning, setGameRunning] = createSignal(false);
const [launchingInstanceId, setLaunchingInstanceId] = createSignal<string | null>(null);
// True while the game logs are detached into the separate popout window. The
// Logs tab swaps its live viewer for a "bring back" placeholder while this is
// set. Driven by the backend's logs-popped-out / logs-reattached events so it
// stays correct whether the window is closed via the button or natively.
const [logsPoppedOut, setLogsPoppedOut] = createSignal(false);
const [showNoAccountModal, setShowNoAccountModal] = createSignal(false);

// Live game log buffer, keyed by instance ID. Lives at module scope (not
// per-screen) so logs persist across navigation — exit Minecraft, browse
// the Library, come back to the Logs tab, and the output from your last
// play session is still there to review.
//
// Per-instance buckets fix the cross-talk where launching instance A then
// switching to instance B's Logs tab would show A's output. Each `game-log`
// event carries its originating instance ID; the listener routes lines
// into the matching bucket.
//
// The whole map lives until the launcher itself restarts.
const [gameLogs, setGameLogs] = createSignal<Record<string, string[]>>({});

/** Per-instance log buffer cap. A chatty modpack can emit tens of thousands
 *  of lines per session; keeping them all would grow memory and the Logs-tab
 *  DOM unbounded. We retain the most recent lines (tail), matching the logs
 *  popout window's identical cap. */
const MAX_LOG_LINES = 5000;

// Batch incoming log lines and flush once per animation frame. Modded
// Minecraft emits 100–500 lines/sec during boot; updating the signal per-line
// would spread a 5,000-element array hundreds of times per second, thrashing
// the GC and causing UI micro-stutters.
const _logBuffer = new Map<string, string[]>();
let _logFlushScheduled = false;

function _flushLogBuffer() {
  _logFlushScheduled = false;
  if (_logBuffer.size === 0) return;
  const batch = new Map(_logBuffer);
  _logBuffer.clear();
  setGameLogs(prev => {
    const next = { ...prev };
    for (const [id, lines] of batch) {
      const existing = next[id] ?? [];
      const merged = existing.concat(lines);
      next[id] = merged.length > MAX_LOG_LINES
        ? merged.slice(merged.length - MAX_LOG_LINES)
        : merged;
    }
    return next;
  });
}

export function appendGameLog(instanceId: string, line: string) {
  const buf = _logBuffer.get(instanceId);
  if (buf) { buf.push(line); } else { _logBuffer.set(instanceId, [line]); }
  if (!_logFlushScheduled) {
    _logFlushScheduled = true;
    requestAnimationFrame(_flushLogBuffer);
  }
}

/** Clear logs for a single instance. Called at launch time so a fresh
 *  session starts with an empty viewer instead of last session's output. */
export function clearGameLogs(instanceId: string) {
  _logBuffer.delete(instanceId);
  setGameLogs(prev => {
    const next = { ...prev };
    delete next[instanceId];
    return next;
  });
}

/** Logs for a specific instance, or empty array if none. */
export function gameLogsFor(instanceId: string | null | undefined): string[] {
  if (!instanceId) return [];
  return gameLogs()[instanceId] ?? [];
}

export { gameLogs };

// Network state
const [offline, setOffline] = createSignal(!navigator.onLine);
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
}

// Tag the root element with the host platform so CSS can correct per-engine
// rendering differences (e.g. WebKitGTK on Linux renders thin SVG strokes
// heavier than WebView2 on Windows — see the dock icon override in dock.css).
if (typeof document !== "undefined") {
  const ua = navigator.userAgent;
  const platform = ua.includes("Windows") ? "windows" : ua.includes("Mac") ? "mac" : "linux";
  document.documentElement.classList.add(`platform-${platform}`);
}

// Download tracking
export interface DownloadEntry {
  id: string;
  name: string;
  category: string;
  status: "downloading" | "completed" | "failed";
  timestamp: number;
  iconUrl?: string;
  loader?: string;
  gameVersion?: string;
  /** Human-readable content version (e.g. "0.5.8+mc1.21"). Set upfront for
   *  modpacks (known from the search hit) or on completion for individual
   *  mods (resolved server-side at install). Omitted when unknown. */
  versionNumber?: string;
  /** Primary author display name. Cached when the user installs from
   *  search results so we can show "by Author" in the Downloads history
   *  card without re-fetching project metadata. */
  author?: string;
  /** Instance ID on disk for modpacks, used to link back to instance data. */
  instanceId?: string;
}
const [downloads, setDownloads] = createSignal<DownloadEntry[]>([]);
const [bulkBatchSize, setBulkBatchSize] = createSignal(0); // Track bulk install total

// Load persisted download history on startup
loadDownloadHistory().then(json => {
  try {
    const entries: DownloadEntry[] = JSON.parse(json);
    // Only load completed/failed entries (not stale "downloading" from a crash)
    const persisted = entries.filter(d => d.status !== "downloading").slice(0, 200);
    setDownloads(persisted);
  } catch {}
}).catch(() => {});

// Persist to disk whenever a download completes or fails
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function persistDownloads(immediate = false) {
  if (saveTimeout) clearTimeout(saveTimeout);
  const doSave = () => {
    const completed = downloads().filter(d => d.status !== "downloading").slice(0, 200);
    saveDownloadHistory(JSON.stringify(completed)).catch(() => {});
  };
  if (immediate) {
    doSave();
  } else {
    saveTimeout = setTimeout(doSave, 300);
  }
}

// Active download queue toast tracking
let activeDownloadToastId: string | null = null;
let currentBatchTotal = 0;
let currentBatchCompleted = 0;
let currentBatchFailed = 0;
let lastFinishedItemName: string | null = null;

function updateDownloadQueueToast() {
  if (!downloadToastsEnabled()) {
    if (activeDownloadToastId) {
      dismissToast(activeDownloadToastId);
      activeDownloadToastId = null;
    }
    return;
  }

  const active = downloads().filter((d) => d.status === "downloading");
  if (active.length === 0) return;

  // Oldest active download is at the end of the active array (since new entries prepend)
  const currentItem = active[active.length - 1];
  const queueRemaining = active.length - 1;

  const isPack = currentItem.category === "modpack";
  const isJava = currentItem.category === "java";
  const isInstance = currentItem.category === "instance";
  const title = isPack
    ? "Installing modpack..."
    : isJava
    ? "Installing Java runtime..."
    : isInstance
    ? "Preparing instance..."
    : "Installing content";
  const message = queueRemaining > 0
    ? `${currentItem.name} (+${queueRemaining} in queue)`
    : currentItem.name;

  if (activeDownloadToastId && isToastActive(activeDownloadToastId)) {
    updateToast(activeDownloadToastId, {
      title,
      message,
      type: "loading",
      autoCloseMs: 0,
      action: {
        label: "View",
        onClick: () => setActiveScreen("downloads"),
      },
    });
  } else {
    activeDownloadToastId = showToast({
      title,
      message,
      type: "loading",
      autoCloseMs: 0,
      action: {
        label: "View",
        onClick: () => setActiveScreen("downloads"),
      },
    });
  }
}

export function trackDownload(
  name: string,
  category: string,
  meta?: { iconUrl?: string | null; loader?: string; gameVersion?: string; author?: string | null; versionNumber?: string | null; instanceId?: string },
): string {
  const id = Math.random().toString(36).slice(2);
  const entry: DownloadEntry = {
    id,
    name,
    category,
    status: "downloading",
    timestamp: Date.now(),
    iconUrl: meta?.iconUrl ?? undefined,
    loader: meta?.loader,
    gameVersion: meta?.gameVersion,
    versionNumber: meta?.versionNumber ?? undefined,
    author: meta?.author ?? undefined,
    instanceId: meta?.instanceId ?? undefined,
  };
  setDownloads(prev => [entry, ...prev].slice(0, 200));

  currentBatchTotal++;
  if (downloadToastsEnabled()) {
    updateDownloadQueueToast();
  }

  return id;
}

export function completeDownload(
  id: string,
  nameOverride?: string,
  versionNumber?: string,
  metaUpdates?: {
    iconUrl?: string | null;
    loader?: string;
    gameVersion?: string;
    author?: string | null;
    instanceId?: string;
  },
) {
  let alreadyFinalized = false;
  let finishedItem: DownloadEntry | undefined;
  setDownloads(prev =>
    prev.map(d => {
      if (d.id === id) {
        if (d.status === "completed" || d.status === "failed") {
          alreadyFinalized = true;
          return d;
        }
        finishedItem = {
          ...d,
          status: "completed" as const,
          timestamp: Date.now(),
          name: nameOverride || d.name,
          versionNumber: versionNumber ?? d.versionNumber,
          iconUrl: metaUpdates?.iconUrl !== undefined ? (metaUpdates.iconUrl ?? undefined) : d.iconUrl,
          loader: metaUpdates?.loader ?? d.loader,
          gameVersion: metaUpdates?.gameVersion ?? d.gameVersion,
          author: metaUpdates?.author !== undefined ? (metaUpdates.author ?? undefined) : d.author,
          instanceId: metaUpdates?.instanceId ?? d.instanceId,
        };
        return finishedItem;
      }
      return d;
    })
  );
  if (alreadyFinalized) return;
  persistDownloads();

  currentBatchCompleted++;
  if (nameOverride || finishedItem?.name) {
    lastFinishedItemName = nameOverride || finishedItem!.name;
  }

  const remaining = downloads().filter(d => d.status === "downloading");

  if (remaining.length > 0) {
    if (downloadToastsEnabled()) {
      updateDownloadQueueToast();
    }
  } else {
    if (downloadToastsEnabled() && activeDownloadToastId && isToastActive(activeDownloadToastId)) {
      if (currentBatchTotal > 1) {
        updateToast(activeDownloadToastId, {
          title: "Downloads complete",
          message: currentBatchFailed > 0
            ? `${currentBatchCompleted} installed (${currentBatchFailed} failed)`
            : `${currentBatchCompleted} items installed`,
          type: currentBatchFailed > 0 ? "warning" : "success",
          autoCloseMs: 4000,
          action: {
            label: "View",
            onClick: () => setActiveScreen("downloads"),
          },
        });
      } else {
        const isPack = finishedItem?.category === "modpack";
        const isInstance = finishedItem?.category === "instance";
        const isJava = finishedItem?.category === "java";
        const displayName = lastFinishedItemName || finishedItem?.name || "Content";
        updateToast(activeDownloadToastId, {
          title: isPack
            ? "Modpack installed"
            : isInstance
            ? "Instance ready"
            : isJava
            ? "Java runtime installed"
            : "Installed",
          message: isPack || isInstance
            ? `${displayName} is ready to play`
            : isJava
            ? (finishedItem?.versionNumber ? `${displayName} (${finishedItem.versionNumber})` : displayName)
            : displayName,
          type: "success",
          autoCloseMs: 3500,
          action: {
            label: "View",
            onClick: () => setActiveScreen("downloads"),
          },
        });
      }
    }
    currentBatchTotal = 0;
    currentBatchCompleted = 0;
    currentBatchFailed = 0;
    lastFinishedItemName = null;
  }
}

export function failDownload(id: string, errorMsg?: string) {
  let alreadyFinalized = false;
  let failedItem: DownloadEntry | undefined;
  setDownloads(prev =>
    prev.map(d => {
      if (d.id === id) {
        failedItem = d;
        if (d.status === "failed" || d.status === "completed") {
          alreadyFinalized = true;
          return d;
        }
        return { ...d, status: "failed" as const, timestamp: Date.now() };
      }
      return d;
    })
  );
  if (alreadyFinalized) return;
  persistDownloads();

  currentBatchFailed++;

  const isCancelled = errorMsg === "Install cancelled" || errorMsg === "Import cancelled";
  const isManualDownload = typeof errorMsg === "string" && (
    errorMsg.includes("disabled third-party downloads") ||
    errorMsg.includes("can't be downloaded automatically")
  );

  const remaining = downloads().filter(d => d.status === "downloading");

  if (remaining.length > 0) {
    if (downloadToastsEnabled()) {
      updateDownloadQueueToast();
    }
    if (!isManualDownload) {
      showToast({
        title: isCancelled ? "Install cancelled" : "Install failed",
        message: errorMsg || `${failedItem?.name || "Content"} failed to install`,
        type: isCancelled ? "info" : "error",
        autoCloseMs: 5000,
      });
    }
  } else {
    if (activeDownloadToastId && isToastActive(activeDownloadToastId)) {
      if (currentBatchCompleted > 0 && downloadToastsEnabled()) {
        updateToast(activeDownloadToastId, {
          title: "Downloads complete",
          message: `${currentBatchCompleted} installed (${currentBatchFailed} failed)`,
          type: "warning",
          autoCloseMs: 4000,
          action: {
            label: "View",
            onClick: () => setActiveScreen("downloads"),
          },
        });
      } else if (!isManualDownload && downloadToastsEnabled()) {
        updateToast(activeDownloadToastId, {
          title: isCancelled ? "Install cancelled" : "Install failed",
          message: errorMsg || `${failedItem?.name || "Content"} failed to install`,
          type: isCancelled ? "info" : "error",
          autoCloseMs: 5000,
          action: undefined,
        });
      } else {
        dismissToast(activeDownloadToastId);
        activeDownloadToastId = null;
      }
    } else if (!isManualDownload) {
      showToast({
        title: isCancelled ? "Install cancelled" : "Install failed",
        message: errorMsg || `${failedItem?.name || "Content"} failed to install`,
        type: isCancelled ? "info" : "error",
        autoCloseMs: 5000,
      });
    }
    currentBatchTotal = 0;
    currentBatchCompleted = 0;
    currentBatchFailed = 0;
    lastFinishedItemName = null;
  }
}

export function startBulkBatch(total: number) { setBulkBatchSize(total); }
export function endBulkBatch() { setBulkBatchSize(0); }

const activeDownloadCount = () => downloads().filter(d => d.status === "downloading").length;
const isBulkInstall = () => bulkBatchSize() > 1;
const bulkDone = () => bulkBatchSize() - activeDownloadCount();
const bulkProgress = () => bulkBatchSize() > 0 ? bulkDone() / bulkBatchSize() : 0;

export function clearDownloadHistory() {
  setDownloads(prev => prev.filter(d => d.status === "downloading"));
  persistDownloads(true);
}

// Auto-updater state. Populated by `services/updater.ts` after a successful
// check; read by the <UpdateBanner /> component to render the install prompt.
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body: string;
  date: string;
}
const [updateAvailable, setUpdateAvailable] = createSignal<AvailableUpdate | null>(null);
const [updateDownloading, setUpdateDownloading] = createSignal(false);
const [updateInstalling, setUpdateInstalling] = createSignal(false);
const [updateDownloaded, setUpdateDownloaded] = createSignal(false);
const [updateProgress, setUpdateProgress] = createSignal(0);
export {
  updateAvailable,
  setUpdateAvailable,
  updateDownloading,
  setUpdateDownloading,
  updateInstalling,
  setUpdateInstalling,
  updateDownloaded,
  setUpdateDownloaded,
  updateProgress,
  setUpdateProgress,
};

/**
 * Pre-launch check. If no account exists, shows modal and returns false.
 * Caller should bail out of the launch if this returns false.
 */
export function ensureAccountOrPrompt(): boolean {
  if (!account()) {
    setShowNoAccountModal(true);
    return false;
  }
  return true;
}

const [instances, { refetch: refetchInstances }] = createResource(listInstances);
const [account, { refetch: refetchAccount }] = createResource(getActiveAccount);

// Auto-heal modpack download entries missing metadata (e.g. from local file imports)
createEffect(() => {
  const instList = instances();
  if (!instList || instList.length === 0) return;
  const currentDownloads = untrack(() => downloads());
  let changed = false;
  const updated = currentDownloads.map((d) => {
    if (d.category !== "modpack") return d;
    const dlNorm = d.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const inst = (d.instanceId && instList.find((i) => i.id === d.instanceId)) ||
      instList.find((i) => {
        const instNorm = i.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        return (dlNorm.length > 0 && instNorm.length > 0) && (dlNorm.includes(instNorm) || instNorm.includes(dlNorm));
      });
    if (inst) {
      const newName = (d.name.includes(" v") || d.name.endsWith(".mrpack") || d.name.endsWith(".zip")) ? inst.name : d.name;
      const newInstId = inst.id;
      // Do not store multi-megabyte base64 strings in download history; card renders will resolve it dynamically
      const candidateIcon = inst.icon && inst.icon !== "cube" && !inst.icon.startsWith("data:") ? inst.icon : undefined;
      const newIcon = d.iconUrl || candidateIcon;
      const newLoader = (d.loader && d.loader !== "modrinth" && d.loader !== "curseforge") ? d.loader : inst.loader?.type;
      const newGv = d.gameVersion || inst.game_version;
      const newVn = d.versionNumber || inst.source_version || undefined;

      if (newName !== d.name || newInstId !== d.instanceId || newIcon !== d.iconUrl || newLoader !== d.loader || newGv !== d.gameVersion || newVn !== d.versionNumber) {
        changed = true;
        return {
          ...d,
          name: newName,
          instanceId: newInstId,
          iconUrl: newIcon,
          loader: newLoader,
          gameVersion: newGv,
          versionNumber: newVn,
        };
      }
    }
    return d;
  });

  if (changed) {
    setDownloads(updated);
    persistDownloads();
  }
});

// Sidebar pinned-instance IDs. Sourced from `LauncherSettings.sidebar_pinned_instances`
// but mirrored into a signal so the sidebar updates reactively the moment
// `PinInstancesModal` saves new pins. Without this mirror, the sidebar
// would be reading from a settings snapshot that doesn't refresh until the
// app is reloaded.
const [pinnedInstanceIds, setPinnedInstanceIds] = createSignal<string[]>([]);

// Download toast suppression toggle. When false, content and modpack download
// toasts are suppressed and the floating dock displays an active download count badge.
const [downloadToastsEnabled, setDownloadToastsEnabled] = createSignal(true);
export { downloadToastsEnabled, setDownloadToastsEnabled };

createEffect(() => {
  if (!downloadToastsEnabled() && activeDownloadToastId) {
    dismissToast(activeDownloadToastId);
    activeDownloadToastId = null;
  }
});

// Global theme state & dynamic 3D logo resolution. Zero-reload GPU paint cascade.
const savedInitialTheme = (typeof localStorage !== "undefined" && localStorage.getItem("vermeil-theme")) || "neon-aurora";
const [currentTheme, setCurrentTheme] = createSignal<string>(savedInitialTheme);
export { currentTheme, setCurrentTheme };
export const currentThemeLogo = () => getThemeLogo(currentTheme());

export function applyTheme(name: string) {
  const t = name || "neon-aurora";
  setCurrentTheme(t);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem("vermeil-theme", t);
    } catch {}
  }
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
  }
  setThemeIcon(t).catch((e) => console.warn("Failed to set theme icon:", e));
}

let autoUpdateIntervalId: ReturnType<typeof setInterval> | null = null;

/** Single Source of Truth runtime settings applicator: synchronously applies
 *  active side-effects across theme, navigation dock layout, download notifications,
 *  keybind cache, and reactive auto-update polling intervals whenever settings are loaded,
 *  saved locally, or synchronized from Google Cloud. */
export async function applyRuntimeSettings(s: LauncherSettings) {
  if (s.theme && s.theme !== currentTheme()) {
    applyTheme(s.theme);
  }
  if (typeof s.download_toasts === "boolean") {
    setDownloadToastsEnabled(s.download_toasts);
  }
  if (typeof s.auto_hide_dock === "boolean") {
    setAutoHideDockSetting(s.auto_hide_dock);
  }
  if (s.pagination_position === "bottom" || s.pagination_position === "left" || s.pagination_position === "right") {
    setPaginationPosition(s.pagination_position);
  }
  if (s.auto_update) {
    if (!autoUpdateIntervalId && !offline()) {
      checkForUpdates(true).catch((e) => console.error("Auto-update check failed:", e));
      autoUpdateIntervalId = setInterval(() => {
        if (!offline()) {
          checkForUpdates(true).catch((e) => console.error("Auto-update re-check failed:", e));
        }
      }, 5 * 60 * 1000);
    }
  } else if (autoUpdateIntervalId) {
    clearInterval(autoUpdateIntervalId);
    autoUpdateIntervalId = null;
  }
  window.dispatchEvent(new CustomEvent("vermeil-keybinds-changed"));
  window.dispatchEvent(new CustomEvent("vermeil-settings-changed"));
}

/** Re-load pin list from disk. Called on startup, after the pin manager modal
 *  saves changes, and after instance creation/deletion. */
export async function refreshPinnedInstanceIds() {
  try {
    const s = await getSettings();
    setPinnedInstanceIds(s.sidebar_pinned_instances ?? []);
  } catch (e) {
    console.error("Failed to load sidebar pins:", e);
  }
}

// Seed pins and reconcile runtime state on launcher boot so state reflects disk.
refreshPinnedInstanceIds().catch(() => {});
getSettings().then((s) => {
  applyRuntimeSettings(s).catch(() => {});
}).catch(() => {});

listen("cloud-settings-synced", async () => {
  await refreshPinnedInstanceIds();
  try {
    const s = await getSettings();
    await applyRuntimeSettings(s);
  } catch (e) {
    console.error("Failed to apply synced settings:", e);
  }
}).catch(() => {});

export { pinnedInstanceIds };

// Pin selector overlay — when true, the floating dock transforms into a
// scrollable horizontal carousel of pinned instances. Toggled by the
// `toggle_pin_selector` keybind (default Ctrl+P) or by the dock's center
// button while in selector mode.
const [pinSelectorOpen, setPinSelectorOpen] = createSignal(false);
export { pinSelectorOpen, setPinSelectorOpen };

// Global dock auto-hide setting. When true, the floating dock auto-hides across
// all screens until hovered, collapsing bottom clearance to maximize vertical space.
const [autoHideDockSetting, setAutoHideDockSetting] = createSignal(true);
export { autoHideDockSetting, setAutoHideDockSetting };

// Pagination dock position & orientation ("bottom" | "left" | "right").
const [paginationPosition, setPaginationPosition] = createSignal<"bottom" | "left" | "right">("bottom");
export { paginationPosition, setPaginationPosition };

// Dock auto-hide. Set true to slide the floating dock out of view (used on
// the instance Logs tab so it doesn't cover log output). The dock reveals
// itself when the cursor nears the bottom of the window regardless of this
// flag, and screens reset it to false when they unmount.
const [dockHidden, setDockHidden] = createSignal(false);
export { dockHidden, setDockHidden };

const isDockHidden = () => autoHideDockSetting() || dockHidden();
export { isDockHidden };

// Dock pagination. Screens that need page navigation set this to a descriptor
// object; the floating dock renders the page controls inline. When the screen
// unmounts or no longer needs paging, it sets this back to null.
export interface DockPaginationState {
  current: number;
  total: number;
  onPageChange: (page: number) => void;
}
const [dockPagination, setDockPagination] = createSignal<DockPaginationState | null>(null);
export { dockPagination, setDockPagination };

// Pagination scroll mode. When true, mouse wheel anywhere in the app is
// captured and forwarded to `dockPagination().onPageChange`.
const [paginationScrollMode, setPaginationScrollMode] = createSignal(false);
export { paginationScrollMode, setPaginationScrollMode };

createEffect(() => {
  if (!dockPagination()) {
    setPaginationScrollMode(false);
  }
});

// Active skin URL for the currently signed-in Microsoft account. Populated
// lazily from `getSkinProfile()` whenever the active account changes; cleared
// for offline accounts since they have no Mojang profile to fetch.
//
// Surfaced everywhere a user avatar is shown — titlebar pill, Account screen
// rows, etc. — so the launcher feels personalized without each component
// having to round-trip Mojang on its own.
const [activeSkinUrl, setActiveSkinUrl] = createSignal<string | null>(null);

/**
 * Re-fetch the active skin from Mojang and update the global signal.
 * Called from `App.tsx` on account change and from any code path that
 * uploads / resets a skin (e.g. the Skins screen).
 */
export async function refreshActiveSkin() {
  const a = account();
  if (!a) {
    setActiveSkinUrl(null);
    return;
  }
  try {
    const profile = await getSkinProfile();
    const active = profile.skins.find((s) => s.state === "ACTIVE") ?? profile.skins[0];
    setActiveSkinUrl(active?.texture ?? null);
  } catch (e) {
    console.error("Active skin fetch failed:", e);
    setActiveSkinUrl(null);
  }
}

export interface ActiveCapeInfo {
  type: "custom" | "mojang";
  id: string;
  texture: string;
  customCape?: CustomCape;
}

const [activeCape, setActiveCape] = createSignal<ActiveCapeInfo | null>(null);
export const activeCapeUrl = () => activeCape()?.texture ?? null;

/**
 * Re-fetch the active cape (custom cape or Mojang cape) and update the global signal.
 * Custom capes take priority over Mojang capes when enabled in-game.
 */
export async function refreshActiveCape(cachedProfile?: any) {
  try {
    // 1. Check in-game custom cape state first
    const ingame = await getIngameCape().catch(() => null);
    if (ingame?.enabled && ingame.cape_id) {
      const capes = await listCustomCapes().catch(() => [] as CustomCape[]);
      const custom = capes.find((c) => c.id === ingame.cape_id);
      if (custom) {
        setActiveCape({
          type: "custom",
          id: custom.id,
          texture: custom.texture,
          customCape: custom,
        });
        return;
      }
    }

    // 2. Fall back to Mojang active cape if user has a non-offline Microsoft account
    const a = account();
    if (a && !a.is_offline) {
      const profile = cachedProfile !== undefined ? cachedProfile : await getSkinProfile().catch(() => null);
      const activeMojang = profile?.capes?.find((c: any) => c.state === "ACTIVE");
      if (activeMojang) {
        setActiveCape({
          type: "mojang",
          id: activeMojang.id,
          texture: activeMojang.texture,
        });
        return;
      }
    }

    // 3. No cape active
    setActiveCape(null);
  } catch (e) {
    console.error("Active cape fetch failed:", e);
    setActiveCape(null);
  }
}

// React to account changes — clear or re-fetch active skin and cape.
createEffect(() => {
  const a = account();
  if (!a) {
    setActiveSkinUrl(null);
    refreshActiveCape().catch(() => {});
    return;
  }
  refreshActiveSkin().catch(() => {});
  refreshActiveCape().catch(() => {});
});

// Seed active cape on launcher startup
refreshActiveCape().catch(() => {});

// Offline 3D dummy mannequin skin & preview state. Kept in App.tsx so both
// CharacterStage (Home screen) and the lazy-loaded Skins screen share it
// without breaking Vite chunk splitting.
const [activeOfflineSkin, setActiveOfflineSkin] = createSignal<LocalSkin | null>(null);
const [offlineDummyVariant, setOfflineDummyVariant] = createSignal<SkinVariant>("CLASSIC");

export function getDummySkinDataUrl(variant: SkinVariant = "CLASSIC"): string {
  return variant === "SLIM" ? "/dummy_skin_slim.png" : "/dummy_skin.png";
}

// Google Cloud connection state for settings backup and sync.
const [cloudConnected, { refetch: refetchCloudStatus }] = createResource(isGoogleCloudConnected);

export { activeScreen, setActiveScreen, activeInstanceId, setActiveInstanceId, initialInstanceTab, setInitialInstanceTab, gameLaunched, setGameLaunched, gameRunning, setGameRunning, launchingInstanceId, setLaunchingInstanceId, logsPoppedOut, setLogsPoppedOut, downloads, activeDownloadCount, isBulkInstall, bulkBatchSize, bulkDone, bulkProgress, instances, refetchInstances, account, refetchAccount, activeSkinUrl, setActiveSkinUrl, activeCape, setActiveCape, activeOfflineSkin, setActiveOfflineSkin, offlineDummyVariant, setOfflineDummyVariant, offline, showToast, updateToast, cloudConnected, refetchCloudStatus };

const screenTitles: Record<Screen, string> = {
  home: "Home",
  library: "Library",
  mods: "Instance",
  settings: "Settings",
  account: "Account",
  skins: "Skins & capes",
  downloads: "Downloads",
  "create-choose": "Create Instance",
  "create-custom": "Custom Setup",
  "create-modpack": "Browse Modpacks",
  "create-import": "Import",
};

const App: Component = () => {
  // Boot splash. Shown by default the moment the (initially hidden) window is
  // revealed; `splashOn` is flipped off early in init when the setting is
  // disabled, and `appShown` starts the dismissal countdown once the window
  // is actually on screen.
  const [splashOn, setSplashOn] = createSignal(true);
  const [appShown, setAppShown] = createSignal(false);

  // Listen for game exit/crash events from backend
  onMount(async () => {
    const cleanupInstallProgress = initInstallProgress();
    onCleanup(() => {
      cleanupInstallProgress();
    });

    // Live game log stream. Subscribe at app level so log lines pour into
    // the global per-instance buckets even when the user is on a different
    // screen — they can switch to the Logs tab later and still see
    // everything for that specific instance.
    listen<{ instanceId: string; line: string }>("game-log", (event) => {
      const { instanceId, line } = event.payload;
      if (instanceId) {
        appendGameLog(instanceId, line);
      }
    });

    listen("game-exited", () => {
      setGameRunning(false);
      refetchInstances();
      refetchAccount();
    });

    // Companion-mod install status, emitted at launch by services::companion_mod.
    // Surface what actually happened so an in-game cape that's "on" but didn't
    // land (no matching build / network blip / unsupported instance) isn't a
    // silent failure — only show a toast when it's an actual failure so normal
    // launches remain silent and clean without redundant popups.
    type CompanionStatus =
      | { kind: "installed"; detail: { file: string } }
      | { kind: "skipped" }
      | { kind: "failed"; detail: { reason: string } };
    listen<CompanionStatus>("companion-mod-status", (event) => {
      const s = event.payload;
      if (s.kind === "failed") {
        showToast({
          title: "Companion mod not installed",
          message: `${s.detail.reason} — the cape won't render this run.`,
          type: "error",
          autoCloseMs: 8000,
        });
      }
    });

    // Logs detach/reattach: the backend opens the popout window on launch
    // (when enabled) and emits these so the Logs tab can swap between its
    // live viewer and the "bring back" placeholder. logs-reattached fires
    // when the popout closes — via the button or the native close.
    listen("logs-popped-out", () => {
      setLogsPoppedOut(true);
    });
    listen("logs-reattached", () => {
      setLogsPoppedOut(false);
    });

    // Re-fetch instances when modpack metadata enrichment completes in the
    // background. The install command returns immediately for snappy UX;
    // the backend then enriches mod metadata + checks cross-platform
    // availability and emits this event so cards can update.
    listen<string>("instance-enriched", () => {
      refetchInstances();
    });

    // When an instance is registered on disk during background modpack install or import,
    // immediately refetch instances so its in-flight card appears in the Library, and link
    // the download entry to the new instance ID.
    listen<Instance>("instance-created", (event) => {
      refetchInstances();
      const inst = event.payload;
      if (inst?.id) {
        setDownloads((prev) =>
          prev.map((d) => {
            if (
              d.status === "downloading" &&
              !d.instanceId &&
              (d.category === "instance" || d.category === "modpack") &&
              (d.name === inst.name || d.name === inst.source_project_id)
            ) {
              return {
                ...d,
                instanceId: inst.id,
              };
            }
            return d;
          })
        );
      }
    });

    listen<string>("instance-deleted", () => {
      refetchInstances();
    });

    listen<string | null>("game-crashed", (event) => {
      setGameRunning(false);
      refetchInstances();
      const crashPath = event.payload;
      showToast({
        title: "Game crashed",
        message: crashPath
          ? "Open the crash report or check the Logs tab for details."
          : "The game exited unexpectedly. Check the Logs tab for details.",
        type: "error",
        autoCloseMs: 12000,
        action: crashPath
          ? {
              label: "View report",
              onClick: () => showCrashReport(crashPath),
            }
          : undefined,
      });
    });

    // First-run onboarding and runtime state initialization.
    try {
      const [s, list] = await Promise.all([getSettings(), listInstances()]);
      await applyRuntimeSettings(s);
      if (!s.onboarded && list.length === 0) {
        openOnboarding();
      }
      // Decide the splash before the window is revealed so a disabled splash
      // never flashes. Default-on if the read fails (catch leaves splashOn true).
      if (!s.splash_screen) setSplashOn(false);
    } catch (e) {
      console.error("Initialization gate failed:", e);
    }

    // Show window after initialization is complete (window starts hidden)
    await showWindow();
    // The window is now on screen — start the splash dismissal countdown.
    setAppShown(true);

    // Global keyboard shortcuts.
    //
    // Bindings are sourced from `LauncherSettings.keybinds` (user-customizable
    // via Settings → Keybinds) with fallbacks defined in `lib/keybinds.ts`.
    // We cache the user bindings here and refresh them whenever settings
    // change. The cache is invalidated by listening on a custom DOM event
    // (`vermeil-keybinds-changed`) that the Settings tab fires after save.
    let userBindings: Record<string, string> = {};
    const refreshBindings = async () => {
      try {
        const s = await getSettings();
        userBindings = s.keybinds ?? {};
      } catch {
        userBindings = {};
      }
    };
    refreshBindings();
    window.addEventListener("vermeil-keybinds-changed", () => {
      refreshBindings();
    });

    // Customizable shortcuts. Each lookup resolves to either the user's
    // override or the action's default. Supports keyboard shortcuts and mouse side buttons.
    const handleActionTrigger = (e: KeyboardEvent | MouseEvent) => {
      // Ignore OS key repeating while a key is held down so toggles don't flap rapidly.
      if ("repeat" in e && e.repeat) {
        return;
      }

      // Don't fire app shortcuts while the user is typing in a text field — a
      // keybind like "T" or "P" must type the character, not toggle a feature.
      // Escape (handled above) still works so users can back out of an input.
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT")) {
        return;
      }

      if (matchesKeybind(e, resolveBinding("create_instance", userBindings))) {
        e.preventDefault();
        setActiveScreen("create-choose");
        return;
      }
      if (matchesKeybind(e, resolveBinding("open_settings", userBindings))) {
        e.preventDefault();
        setActiveScreen("settings");
        return;
      }
      if (
        matchesKeybind(e, resolveBinding("toggle_pin_selector", userBindings)) ||
        matchesKeybind(e, "Ctrl+P")
      ) {
        e.preventDefault();
        setPinSelectorOpen((v) => !v);
        return;
      }
      if (
        matchesKeybind(e, resolveBinding("toggle_pagination_scroll", userBindings)) ||
        matchesKeybind(e, "Z")
      ) {
        e.preventDefault();
        const pag = dockPagination();
        if (!pag || pag.total <= 1) return;
        setPaginationScrollMode((v) => !v);
        return;
      }
    };

    document.addEventListener("keydown", (e) => {
      // Escape is hardcoded — closes the topmost open modal/tool. Not
      // user-rebindable because users expect Escape to "back out" of UI
      // and remapping it would brick recovery from a stuck modal.
      if (e.key === "Escape") {
        if (e.repeat) return;
        if (paginationScrollMode()) {
          setPaginationScrollMode(false);
          return;
        }
        if (pinInstancesModalOpen()) {
          closePinInstancesModal();
          return;
        }
        if (instancePickerModalOpen()) {
          closeInstancePickerModal();
          return;
        }
        if (serverRoutingModalOpen()) {
          closeServerRoutingModal();
          return;
        }
        if (pinSelectorOpen()) {
          setPinSelectorOpen(false);
          return;
        }
        const screen = activeScreen();
        // Step back one level in the navigation hierarchy, not all
        // the way to library. Create sub-screens back to the chooser;
        // the chooser backs to library; instance page backs to library.
        if (screen === "create-custom" || screen === "create-modpack" || screen === "create-import") {
          setActiveScreen("create-choose");
          return;
        }
        if (screen === "create-choose" || screen === "mods") {
          setActiveScreen("library");
          return;
        }
      }

      handleActionTrigger(e);
    });

    document.addEventListener("mousedown", (e) => {
      // Only process auxiliary/side buttons (Middle=1, Side1=3, Side2=4, etc.)
      // Left click (0) and right click (2) are ignored so normal UI interaction is undisturbed
      if (e.button === 0 || e.button === 2) return;
      handleActionTrigger(e);
    });

    // Prevent default browser back/forward navigation when mouse side buttons are clicked
    window.addEventListener("auxclick", (e) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    });
  });

  return (
    <div class="app">
      <ResizeHandles />
      <div class="main">
        <Show when={offline()}>
          <div class="offline-banner">No internet connection</div>
        </Show>
        <Titlebar title={screenTitles[activeScreen()]} />
        <div class={`content ${isDockHidden() ? "dock-hidden" : ""}`}>
          <Show when={activeScreen() === "home"}><Home /></Show>
          <Show when={activeScreen() === "library"}><Library /></Show>
          <Show when={activeScreen() === "mods"}><InstanceMods /></Show>
          <Show when={activeScreen() === "settings"}><Settings /></Show>
          <Show when={activeScreen() === "account"}><Account /></Show>
          <Show when={activeScreen() === "skins"}><Skins /></Show>
          <Show when={activeScreen() === "downloads"}><Downloads /></Show>
          <Show when={activeScreen() === "create-choose"}><CreateChoose /></Show>
          <Show when={activeScreen() === "create-custom"}><CreateCustom /></Show>
          <Show when={activeScreen() === "create-modpack"}><BrowseModpacks /></Show>
          <Show when={activeScreen() === "create-import"}><ImportInstance /></Show>
        </div>
        <FloatingDock />
      </div>
      <NoAccountModal open={showNoAccountModal()} onClose={() => setShowNoAccountModal(false)} />
      <BulkInstallToast />
      <DependencyIssuesModal />
      <ManualDownloadModal />
      <UpdateBanner />
      <CrashReportModal />
      <OnboardingWizard />
      <PinInstancesModal />
      <InstancePickerModal />
      <ServerRoutingModal />
      <Toasts />
      <Show when={splashOn()}>
        <Splash start={appShown()} onDone={() => setSplashOn(false)} />
      </Show>
    </div>
  );
};

export default App;
