// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createResource, Show, For, onMount, onCleanup, createEffect } from "solid-js";
import { getSettings, saveSettings, getCacheSize, purgeCache, getSharedGameDataSize, purgeSharedGameData, getAppDirectory, openAppDirectory, LauncherSettings, detectJavaInstallations, validateJavaPath, setJavaPath, installRecommendedJava, deleteJavaInstall, pruneInvalidJavaPaths, getSystemMemory, JavaInstall, testCurseforgeKey, testModrinthToken, ApiKeyTestResult } from "../ipc/commands";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, instances, showToast, setDownloadToastsEnabled, setAutoHideDockSetting, setPaginationPosition, applyTheme, trackDownload, completeDownload, failDownload, downloads } from "../App";
import { THEMES } from "../lib/theme";
import { checkForUpdates } from "../services/updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconDownload, IconSearch, IconFolderOpen, IconTrash, IconModrinth, IconCurseForge, IconChevronRight, IconGlobe, IconSettings as IconSettingsIcon, IconLayers, IconCube, IconMonitor, IconBolt, IconX, IconInfo, IconPalette, IconSliders, IconMousePointer, IconVolume2, IconCpu, IconHardDrive, IconCoffee, IconRefresh, IconPuzzle, IconMaximize2, IconKey, IconEye, IconEyeOff } from "../components/Icons";
import JavaPathInput from "../components/JavaPathInput";
import JavaChooserModal from "../modals/JavaChooserModal";
import Dropdown from "../components/Dropdown";
import KeybindCapture from "../components/KeybindCapture";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";
import { javaActionButtonLabel, javaActionButtonTip, javaVendorShortName, javaVendorOwner } from "../lib/java";
import { KEYBINDS, resolveBinding } from "../lib/keybinds";
import { listen } from "@tauri-apps/api/event";
import { resolveAssetUrl } from "../lib/assets";

type SettingsTab = "all" | "general" | "resources" | "instances" | "keybinds" | "about";

/// Clamp a concurrency setting to a per-field range. The download semaphore is
/// capped at 10 because most CDNs throttle individual clients past that point;
/// the write semaphore can safely go higher because disk I/O is local.
const clampConcurrency = (n: number, max: number): number =>
  Math.max(1, Math.min(max, Math.round(Number.isNaN(n) ? 10 : n)));

const clampSpeedLimit = (n: number, max = 500): number =>
  Math.max(0, Math.min(max, Math.round(Number.isNaN(n) ? 0 : n)));

interface TactileSwitchProps {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  tip?: string;
  tipClass?: string;
  "aria-label"?: string;
}

const TactileSwitch: Component<TactileSwitchProps> = (props) => (
  <button
    type="button"
    role="switch"
    aria-checked={props.checked}
    aria-label={props["aria-label"]}
    disabled={props.disabled}
    class={`tactile-switch ${props.checked ? "active" : ""} ${props.tipClass ?? ""}`}
    data-tip={props.tip}
    onClick={(e) => {
      e.stopPropagation();
      if (!props.disabled) props.onChange(!props.checked);
    }}
  />
);

// Module-level Java state: persists across screen switches so background installs
// don't abort, state isn't reset, and buttons remain disabled/queued when navigating
// between Settings, Downloads, Home, etc.
const JAVA_SLOTS: number[] = [25, 21, 17, 8];
const [javaDetections, setJavaDetections] = createSignal<JavaInstall[]>([]);
const [javaBusy, setJavaBusy] = createSignal<Record<number, "install" | "detect" | "browse" | "delete" | "queued" | null>>({});
const setJavaSlotBusy = (major: number, busy: "install" | "detect" | "browse" | "delete" | "queued" | null) => {
  setJavaBusy(prev => ({ ...prev, [major]: busy }));
};

interface JavaQueueTask {
  major: number;
  dlId: string;
  distroName: string;
  ownerName: string;
}

const javaQueue: JavaQueueTask[] = [];
let isProcessingJavaQueue = false;

const processJavaQueue = async () => {
  if (isProcessingJavaQueue) return;
  isProcessingJavaQueue = true;

  while (javaQueue.length > 0) {
    const task = javaQueue[0];
    const { major, dlId, distroName, ownerName } = task;

    // If user cancelled while queued in Downloads tab:
    const entry = downloads().find(d => d.id === dlId);
    if (entry && (entry.status === "failed" || entry.status === "completed")) {
      setJavaSlotBusy(major, null);
      javaQueue.shift();
      continue;
    }

    setJavaSlotBusy(major, "install");

    try {
      const install = await installRecommendedJava(major);
      // Refresh detections so the install shows up in the local cache too.
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      window.dispatchEvent(new CustomEvent("vermeil-settings-changed"));
      completeDownload(
        dlId,
        `Java ${major} (${distroName})`,
        install.full_version,
        {
          gameVersion: `Java ${major}`,
          author: ownerName,
        }
      );
    } catch (e) {
      failDownload(dlId, String(e));
    } finally {
      setJavaSlotBusy(major, null);
      javaQueue.shift();
    }
  }

  isProcessingJavaQueue = false;
};

const Settings: Component = () => {
  const [tab, setTab] = createSignal<SettingsTab>("all");
  const [search, setSearch] = createSignal("");
  let canvasRef: HTMLDivElement | undefined;
  const q = () => search().trim().toLowerCase();
  const isSearching = () => q().length > 0;

  /** Comprehensive multi-token matcher with hyphen/underscore/slash normalization. */
  const matches = (...texts: (string | undefined | null | number)[]): boolean => {
    const query = q();
    if (!query) return true;
    const combined = texts
      .filter((t): t is string | number => t !== null && t !== undefined)
      .map((t) => String(t).toLowerCase())
      .join(" ");

    if (combined.includes(query)) return true;

    const normCombined = combined.replace(/[-_/]/g, " ");
    const normQuery = query.replace(/[-_/]/g, " ");
    if (normCombined.includes(normQuery)) return true;

    const words = normQuery.split(/\s+/).filter((w) => w.length > 0);
    return words.length > 1 && words.every((w) => normCombined.includes(w));
  };

  // Section-level matching: when query matches a section name or primary concept, show that whole section
  const isGeneralSection = () => matches("general", "launcher", "core preferences", "startup");
  const isAboutSection = () => matches("about", "version", "release", "channel", "updates", "update");
  const isResourcesSection = () => matches("resources", "resource", "storage", "performance", "java", "memory", "cache", "concurrency", "download", "write");
  const isInstancesSection = () => matches("instance", "instances", "global instance", "defaults", "video", "graphics", "sound", "audio", "window", "display", "ram");
  const isKeybindsSection = () => matches("keybind", "keybinds", "keyboard", "shortcuts", "shortcut", "hotkey", "hotkeys", "bindings", "controls");

  // Group-level matchers for Bento boxes
  const matchesThemes = () => isGeneralSection() || matches(
    "Theme", "Themes", "Color Themes", "Appearance", "Neon Aurora", "Emerald", "Inferno", "Stealth", "Deep Ocean", "Void", "palette", "aesthetic"
  );
  const matchesDock = () => isGeneralSection() || matches(
    "dock", "autohide", "auto-hide", "floating dock", "pagination", "page dock", "pagination dock position", "notifications", "download notifications", "toast", "toasts", "splash", "boot", "startup", "boot splash"
  );
  const matchesIntegrations = () => isGeneralSection() || matches(
    "companion", "cape", "in-game cape", "vermeil companion", "companion mod", "discord", "rpc", "rich presence", "snapshots", "snapshot", "experimental", "force delete", "delete", "confirmation"
  );
  const matchesUpdater = () => isAboutSection() || matches(
    "update", "updates", "updater", "channel", "release stream", "stable", "experimental", "beta", "check for updates", "auto-update", "auto update"
  );
  const matchesLifecycle = () => isGeneralSection() || matches(
    "lifecycle", "system", "tray", "minimize", "close", "popout", "logs", "console"
  );

  const matchesGeneral = () => matchesThemes() || matchesDock() || matchesIntegrations() || matchesLifecycle();
  const matchesAbout = () => isAboutSection() || matchesUpdater() || matches(
    "About", "Vermeil", "Version", "Release Channel", "Update channel", "channel", "stable", "experimental",
    "Check for updates", "Manually check for a new version", "Website", "vermeillauncher.app",
    "Privacy", "No data is collected", "telemetry", "Disclaimer", "unofficial Minecraft launcher"
  );

  const matchesStorage = () => isResourcesSection() || matches(
    "Storage", "App directory", "App cache", "Shared game data", "Version metadata and loader installers",
    "folder", "path", "directory", "cache", "purge", "clear", "assets", "libraries"
  );
  const matchesPerformance = () => isResourcesSection() || matches(
    "Performance", "Concurrency", "Concurrent downloads", "Concurrent writes", "Download speed limit",
    "parallel", "threads", "downloads", "writes", "disk", "speed", "bandwidth", "limit", "throttle", "rate"
  );
  const matchesApis = () => isResourcesSection() || matches(
    "Content Platform APIs", "CurseForge", "Modrinth", "API", "token", "key", "access token", "api key", "BYOK", "credential"
  );
  const matchesJava = () => isResourcesSection() || matches(
    "Java", "jdk", "jre", "runtime", "Adoptium", "System Java", "GC preset", "Garbage collection",
    "g1gc", "zgc", "shenandoah", "slots", "location", "detect", "browse", "install", "8", "17", "21", "25"
  );

  const matchesVideo = () => isInstancesSection() || matches(
    "Video", "Display", "Rendering", "Max FPS", "fps", "framerate", "VSync", "vertical sync",
    "GUI Scale", "scale", "FOV", "field of view", "Brightness", "gamma"
  );
  const matchesAccessibility = () => isInstancesSection() || matches(
    "Accessibility", "Motion", "View Bobbing", "bobbing", "FOV Effects", "effects", "Subtitles", "show subtitles"
  );
  const matchesControls = () => isInstancesSection() || matches(
    "Controls", "Mouse", "Sensitivity", "mouse sensitivity", "Invert", "invert mouse", "Auto-Jump", "autojump", "jump"
  );
  const matchesAudio = () => isInstancesSection() || matches(
    "Sound", "Audio", "Volume", "Master Volume", "Music Volume", "Weather", "Hostile", "Blocks", "Players", "sound", "music", "master"
  );
  const matchesWindow = () => isInstancesSection() || matches(
    "Window", "Resolution", "Dimensions", "width", "height", "Start Maximized", "maximized", "fullscreen"
  );
  const matchesMemory = () => isInstancesSection() || matches(
    "Memory", "RAM", "Maximum RAM", "Maximum memory", "allocation", "adaptive", "heap", "mb", "gb"
  );

  const matchesResources = () => matchesStorage() || matchesPerformance() || matchesApis() || matchesJava();
  const matchesInstances = () => matchesVideo() || matchesAccessibility() || matchesControls() || matchesAudio() || matchesWindow() || matchesMemory() ||
    (instances() || []).some(i => matches(i.name, i.game_version, i.loader.type));
  const matchesKeybinds = () => isKeybindsSection() || KEYBINDS.some(a => matches(a.label, a.description, a.default));

  const hasAnyMatches = () => !isSearching() || matchesGeneral() || matchesAbout() || matchesResources() || matchesInstances() || matchesKeybinds();
  const [settings, { refetch, mutate }] = createResource(getSettings);
  const [appVersion] = createResource(getVersion);
  const [appDirectory] = createResource(getAppDirectory);
  const [systemMemoryMb] = createResource(getSystemMemory);
  const [cacheSize, setCacheSize] = createSignal(0);
  const [purging, setPurging] = createSignal(false);
  const [sharedDataSize, setSharedDataSize] = createSignal(0);
  const [purgingShared, setPurgingShared] = createSignal(false);

  // Video settings read straight from the resource — `updateSetting` mutates it
  // optimistically (see below), so reads are always the latest value, no
  // separate mirror to drift out of sync. Only valid inside `<Show when={settings()}>`.
  type VS = LauncherSettings["video_settings"];
  const vs = (): VS => settings()!.video_settings;

  // When the game exits, the backend reads options.txt back and emits the
  // merged video settings. Fold them into the resource so an open Settings
  // screen reflects in-game changes live (single source of truth).
  // Also listen for cloud sync and external settings changes to keep the UI
  // reactively in sync with disk state.
  onMount(() => {
    let unlistenVideo: (() => void) | undefined;
    let unlistenCloud: (() => void) | undefined;
    let cancelled = false;

    listen<VS>("video-settings-synced", (e) => {
      const cur = settings();
      if (cur) mutate({ ...cur, video_settings: e.payload });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenVideo = fn;
    });

    listen("cloud-settings-synced", () => {
      refetch();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenCloud = fn;
    });

    const onSettingsChanged = () => {
      refetch();
    };
    window.addEventListener("vermeil-settings-changed", onSettingsChanged);

    onCleanup(() => {
      cancelled = true;
      unlistenVideo?.();
      unlistenCloud?.();
      window.removeEventListener("vermeil-settings-changed", onSettingsChanged);
    });
  });

  // Same optimistic-display pattern for the concurrency sliders. Without
  // these, the displayed number lags the thumb because the read source
  // (`settings()!.concurrent_*`) only refreshes after the save+refetch
  // round-trip completes.
  const [dlDraft, setDlDraft] = createSignal<number | null>(null);
  const [wrDraft, setWrDraft] = createSignal<number | null>(null);
  const [speedDraft, setSpeedDraft] = createSignal<number | null>(null);
  const dlValue = (): number => dlDraft() ?? Math.min(settings()?.concurrent_downloads ?? 10, 20);
  const wrValue = (): number => wrDraft() ?? settings()?.concurrent_writes ?? 10;
  const speedValue = (): number => speedDraft() ?? settings()?.download_speed_limit_mb ?? 0;
  createEffect(() => {
    const s = settings();
    const d = dlDraft();
    if (s && d !== null && Math.min(s.concurrent_downloads, 20) === d) setDlDraft(null);
  });
  createEffect(() => {
    const s = settings();
    const w = wrDraft();
    if (s && w !== null && s.concurrent_writes === w) setWrDraft(null);
  });
  createEffect(() => {
    const s = settings();
    const sp = speedDraft();
    if (s && sp !== null && (s.download_speed_limit_mb ?? 0) === sp) setSpeedDraft(null);
  });

  // Java location finder — populated by `runDetect()` and re-run on demand.
  // The four "slots" (8/17/21/25) cover every Minecraft version that exists.
  // Anything missing falls back to auto-detection / auto-install at launch.

  /** Best detected install for a given major, used as the path display fallback. */
  const detectionFor = (major: number): JavaInstall | undefined =>
    javaDetections().find(i => i.major === major);
  /** Resolved path for a given major: user override beats detection. */
  const javaPathFor = (major: number): string => {
    const userSet = settings()?.java_paths?.[major];
    if (userSet) return userSet;
    return detectionFor(major)?.path ?? "";
  };

  // Chooser-modal state. When `Detect` finds more than one matching JRE for
  // a major, we surface this modal so the user picks one explicitly instead
  // of silently auto-selecting the first by source priority. Single matches
  // still auto-apply — no popup for the obvious case.
  const [chooser, setChooser] = createSignal<{ major: number; options: JavaInstall[] } | null>(null);

  /** Apply a detected install: persist, refetch settings, toast. */
  const applyDetection = async (major: number, install: JavaInstall) => {
    await setJavaPath(major, install.path);
    await refetch();
    setJavaDetections((prev) => {
      const without = prev.filter((i) => i.path !== install.path);
      return [...without, install];
    });
    showToast({ title: `Java ${major} set`, message: install.path, type: "success" });
  };

  const runDetect = async (major?: number) => {
    if (major !== undefined) setJavaSlotBusy(major, "detect");
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      if (major !== undefined) {
        const matches = found.filter((i) => i.major === major);
        if (matches.length === 0) {
          showToast({ title: `Java ${major} not found`, message: "Try Install recommended or Browse manually.", type: "info" });
        } else if (matches.length === 1) {
          await applyDetection(major, matches[0]);
        } else {
          // Multiple matches — let the user pick. The chooser handles the
          // apply step itself via `onPick`.
          setChooser({ major, options: matches });
        }
      } else {
        showToast({ title: `Found ${found.length} Java install${found.length === 1 ? "" : "s"}`, type: "success" });
      }
    } catch (e) {
      showToast({ title: "Detection failed", message: String(e), type: "error" });
    } finally {
      if (major !== undefined) setJavaSlotBusy(major, null);
    }
  };

  const runDelete = async (major: number) => {
    setJavaSlotBusy(major, "delete");
    try {
      const deletedDir = await deleteJavaInstall(major);
      await refetch();
      // Path-scoped cache invalidation: only drop detections inside the
      // directory we just removed. Filtering by `major` would also wipe an
      // unrelated user JDK for the same major (Oracle / Microsoft / etc.),
      // hiding it from the slot until the next full re-detect.
      setJavaDetections((prev) => prev.filter((i) => !i.path.startsWith(deletedDir)));
      showToast({ title: `Java ${major} removed`, message: "Vermeil's downloaded copy was deleted.", type: "success" });
    } catch (e) {
      showToast({ title: `Java ${major} delete failed`, message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const runInstall = async (major: number) => {
    if (javaBusy()[major]) return;

    const runtime = settings()?.java_runtime === "auto" ? "adoptium" : (settings()?.java_runtime || "adoptium");
    const distroName = javaVendorShortName(runtime);
    const ownerName = javaVendorOwner(runtime);
    const dlId = trackDownload(`Java ${major} (${distroName})`, "java", {
      gameVersion: `Java ${major}`,
      versionNumber: `JDK ${major}`,
      author: ownerName,
    });

    javaQueue.push({ major, dlId, distroName, ownerName });

    if (isProcessingJavaQueue) {
      setJavaSlotBusy(major, "queued");
      showToast({
        title: `Java ${major} queued`,
        message: `Added to download queue (#${javaQueue.length})`,
        type: "info",
      });
    } else {
      processJavaQueue();
    }
  };

  const runBrowse = async (major: number) => {
    setJavaSlotBusy(major, "browse");
    try {
      const isWin = navigator.userAgent.includes("Windows");
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: isWin
          ? [{ name: "Java executable", extensions: ["exe"] }]
          : [],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const install = await validateJavaPath(path);
      if (install.major !== major) {
        showToast({
          title: `That's Java ${install.major}, not ${major}`,
          message: "Pick a JRE matching the requested major version.",
          type: "warning",
        });
        return;
      }
      await setJavaPath(major, install.path);
      await refetch();
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} updated`, message: install.path, type: "success" });
    } catch (e) {
      showToast({ title: "Browse failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  onMount(async () => {
    try { setCacheSize(await getCacheSize()); } catch {}
    try { setSharedDataSize(await getSharedGameDataSize()); } catch {}
    // Self-heal stale Java overrides. The user may have deleted a JRE
    // manually (or uninstalled an external one) since the last launch — we
    // clear those entries before showing them so the input never displays
    // a path pointing at nothing. Each cleared major gets its own toast so
    // the cause-effect is visible to the user.
    try {
      const cleared = await pruneInvalidJavaPaths();
      if (cleared.length > 0) {
        await refetch();
        for (const m of cleared) {
          showToast({
            title: `Java ${m} path cleared`,
            message: "The previous file no longer exists on disk.",
            type: "info",
          });
        }
      }
    } catch (e) {
      console.error("Java path prune failed:", e);
    }
    // Fire-and-forget initial detection so the Java section has paths to show
    // when the user first opens the Resources tab.
    detectJavaInstallations().then(setJavaDetections).catch(() => {});
  });

  const formatCacheSize = () => (cacheSize() / (1024 * 1024)).toFixed(1);
  const formatSharedDataSize = () => {
    const bytes = sharedDataSize();
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const handlePurgeCache = async () => {
    setPurging(true);
    try {
      await purgeCache();
      setCacheSize(0);
    } catch (e) { console.error(e); }
    finally { setPurging(false); }
  };

  const handlePurgeSharedData = async () => {
    const instCount = (instances() || []).length;
    if (instCount > 0) {
      const ok = window.confirm(
        `You have ${instCount} installed instance${instCount === 1 ? "" : "s"}. Cleaning shared game assets and libraries will require Minecraft to re-download them the next time you play.\n\nAre you sure you want to clean shared game data?`
      );
      if (!ok) return;
    }
    setPurgingShared(true);
    try {
      const freed = await purgeSharedGameData();
      setSharedDataSize(0);
      try { setCacheSize(await getCacheSize()); } catch {}
      const freedMb = (freed / (1024 * 1024)).toFixed(0);
      showToast({
        title: "Shared game data cleaned",
        message: `Freed ${freedMb} MB of shared assets and libraries.`,
        type: "success",
      });
    } catch (e) {
      console.error(e);
      showToast({
        title: "Failed to clean shared data",
        message: String(e),
        type: "error",
      });
    } finally {
      setPurgingShared(false);
    }
  };

  // Adaptive RAM defaults — mirrors `services::memory::default_max_for_system`
  // and `default_min_for_system` so the Settings UI can show real numbers in
  // placeholders without an extra IPC round trip. **PARALLEL SURFACE**: if
  // either Rust function changes its constants, update this too.
  const adaptiveDefaultMax = (systemMb: number): number => {
    if (!systemMb) return 4096;
    const [reserve, pct] = systemMb <= 4096
      ? [1536, 0.70]
      : systemMb <= 8192
        ? [2048, 0.80]
        : systemMb <= 16384
          ? [4096, 0.75]
          : [6144, 0.65];
    const usable = Math.max(0, systemMb - reserve);
    const aligned = Math.floor(Math.floor(usable * pct) / 256) * 256;
    return Math.max(1024, Math.min(aligned, 12288));
  };

  /** Format MB as "X.X GB" matching the rest of the launcher's memory text. */
  const formatMemoryGb = (mb: number): string => {
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 1 : 0).replace(/\.0$/, "")} GB`;
  };

  const updateSetting = async <K extends keyof LauncherSettings>(key: K, value: LauncherSettings[K]) => {
    const current = settings();
    if (!current) return;
    const updated = { ...current, [key]: value };
    // Optimistic: update the resource synchronously so the UI (toggles, sliders,
    // dropdowns) reflects the change immediately and the next read-modify-write
    // sees the latest state — no save→refetch round-trip to lag behind or clobber.
    mutate(updated);
    if (key === "theme") {
      applyTheme(value as string);
    }
    if (key === "download_toasts") {
      setDownloadToastsEnabled(value as boolean);
    }
    if (key === "auto_hide_dock") {
      setAutoHideDockSetting(value as boolean);
    }
    if (key === "pagination_position") {
      setPaginationPosition(value as "bottom" | "left" | "right");
    }
    try {
      await saveSettings(updated);
      window.dispatchEvent(new CustomEvent("vermeil-settings-changed"));
      // Notify the global keydown handler that the keybind cache is stale.
      // App.tsx listens for this event and re-reads settings.keybinds.
      if (key === "keybinds") {
        window.dispatchEvent(new CustomEvent("vermeil-keybinds-changed"));
      }
      // The per-instance Java-args editor pre-fills from the global GC preset.
      // It lives on another screen, so fire after the save lands (not just the
      // optimistic mutate) — it reads settings from disk and would otherwise
      // race this write. The instance screen re-derives its args on this event.
      if (key === "gc_preset") {
        window.dispatchEvent(new CustomEvent("vermeil-gc-preset-changed"));
      }
    } catch (e) {
      console.error("Failed to save setting:", e);
      // Roll back on failure
      mutate(current);
      if (key === "theme") {
        applyTheme(current.theme);
      }
      if (key === "download_toasts") {
        setDownloadToastsEnabled(current.download_toasts);
      }
      if (key === "auto_hide_dock") {
        setAutoHideDockSetting(current.auto_hide_dock);
      }
      if (key === "pagination_position") {
        setPaginationPosition(current.pagination_position as "bottom" | "left" | "right");
      }
      await refetch();
    }
  };

  const [showRollbackConfirmModal, setShowRollbackConfirmModal] = createSignal(false);
  const isCurrentExperimental = () => {
    const v = appVersion();
    return Boolean(v && (v.includes("-") || v.toLowerCase().includes("exp")));
  };
  const activeChannel = () =>
    settings()?.update_channel || (isCurrentExperimental() ? "experimental" : "stable");

  const handleChannelSwitch = async (target: "stable" | "experimental") => {
    const current = activeChannel();
    if (current === target) return;

    if (target === "stable" && isCurrentExperimental()) {
      setShowRollbackConfirmModal(true);
      return;
    }

    await updateSetting("update_channel", target);
    showToast({
      title: "Update channel changed",
      message: `Now tracking the ${target === "experimental" ? "Experimental" : "Stable"} channel.`,
      type: "info",
      autoCloseMs: 3000,
    });
    checkForUpdates(false, false, target).catch(() => {});
  };

  const confirmRollbackToStable = async () => {
    setShowRollbackConfirmModal(false);
    await updateSetting("update_channel", "stable");
    showToast({
      title: "Checking for rollback",
      message: "Querying the Stable channel for the latest verified release...",
      type: "info",
      autoCloseMs: 4000,
    });
    checkForUpdates(false, true, "stable").catch(() => {});
  };

  // Patch helper for video_settings: merges onto the current resource value and
  // writes through `updateSetting` (which mutates optimistically, so the slider
  // tracks the thumb live with no separate mirror).
  const updateVideoSettings = (patch: Partial<VS>) => {
    const cur = settings()?.video_settings;
    if (!cur) return;
    updateSetting("video_settings", { ...cur, ...patch });
  };

  // Content Platform API Credentials state
  const [showCfKey, setShowCfKey] = createSignal(false);
  const [showModrinthToken, setShowModrinthToken] = createSignal(false);
  const [cfKeyDraft, setCfKeyDraft] = createSignal<string | null>(null);
  const [modrinthTokenDraft, setModrinthTokenDraft] = createSignal<string | null>(null);
  const [testingCf, setTestingCf] = createSignal(false);
  const [testingModrinth, setTestingModrinth] = createSignal(false);
  const [cfTestResult, setCfTestResult] = createSignal<ApiKeyTestResult | null>(null);
  const [modrinthTestResult, setModrinthTestResult] = createSignal<ApiKeyTestResult | null>(null);

  let cfFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let modrinthFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (cfFeedbackTimer) clearTimeout(cfFeedbackTimer);
    if (modrinthFeedbackTimer) clearTimeout(modrinthFeedbackTimer);
  });

  const currentCfKey = () => (cfKeyDraft() !== null ? cfKeyDraft()! : (settings()?.curseforge_api_key ?? ""));
  const currentModrinthToken = () => (modrinthTokenDraft() !== null ? modrinthTokenDraft()! : (settings()?.modrinth_token ?? ""));

  const isCfFeedback = () => testingCf() || cfTestResult() !== null;
  const cfInputValue = () => {
    if (testingCf()) return "Testing connection...";
    if (cfTestResult()) return cfTestResult()!.message;
    return currentCfKey();
  };
  const cfInputClass = () => {
    const base = "api-credential-input";
    if (testingCf()) return `${base} api-credential-input--testing`;
    if (cfTestResult()) {
      return `${base} ${cfTestResult()!.success ? "api-credential-input--success" : "api-credential-input--error"}`;
    }
    return base;
  };
  const clearCfFeedback = () => {
    if (cfFeedbackTimer) clearTimeout(cfFeedbackTimer);
    if (cfTestResult()) setCfTestResult(null);
  };

  const isModrinthFeedback = () => testingModrinth() || modrinthTestResult() !== null;
  const modrinthInputValue = () => {
    if (testingModrinth()) return "Testing connection...";
    if (modrinthTestResult()) return modrinthTestResult()!.message;
    return currentModrinthToken();
  };
  const modrinthInputClass = () => {
    const base = "api-credential-input";
    if (testingModrinth()) return `${base} api-credential-input--testing`;
    if (modrinthTestResult()) {
      return `${base} ${modrinthTestResult()!.success ? "api-credential-input--success" : "api-credential-input--error"}`;
    }
    return base;
  };
  const clearModrinthFeedback = () => {
    if (modrinthFeedbackTimer) clearTimeout(modrinthFeedbackTimer);
    if (modrinthTestResult()) setModrinthTestResult(null);
  };

  const commitCfKey = async () => {
    if (cfKeyDraft() === null) return;
    const next = cfKeyDraft()!.trim();
    if (next === (settings()?.curseforge_api_key ?? "")) {
      setCfKeyDraft(null);
      return;
    }
    await updateSetting("curseforge_api_key", next);
    setCfKeyDraft(null);
  };

  const commitModrinthToken = async () => {
    if (modrinthTokenDraft() === null) return;
    const next = modrinthTokenDraft()!.trim();
    if (next === (settings()?.modrinth_token ?? "")) {
      setModrinthTokenDraft(null);
      return;
    }
    await updateSetting("modrinth_token", next);
    setModrinthTokenDraft(null);
  };

  const handleTestCf = async () => {
    if (cfFeedbackTimer) clearTimeout(cfFeedbackTimer);
    await commitCfKey();
    setTestingCf(true);
    setCfTestResult(null);
    try {
      const key = (currentCfKey() || "").trim();
      const res = await testCurseforgeKey(key || null);
      setCfTestResult(res);
    } catch (e) {
      setCfTestResult({ success: false, message: String(e) });
    } finally {
      setTestingCf(false);
      cfFeedbackTimer = setTimeout(() => {
        setCfTestResult(null);
      }, 3500);
    }
  };

  const handleResetCf = async () => {
    if (cfFeedbackTimer) clearTimeout(cfFeedbackTimer);
    setCfKeyDraft(null);
    setCfTestResult(null);
    await updateSetting("curseforge_api_key", "");
    showToast({
      title: "CurseForge Key Reset",
      message: "Reverted to built-in default key",
      type: "info",
    });
  };

  const handleTestModrinth = async () => {
    if (modrinthFeedbackTimer) clearTimeout(modrinthFeedbackTimer);
    await commitModrinthToken();
    setTestingModrinth(true);
    setModrinthTestResult(null);
    try {
      const token = (currentModrinthToken() || "").trim();
      const res = await testModrinthToken(token || null);
      setModrinthTestResult(res);
    } catch (e) {
      setModrinthTestResult({ success: false, message: String(e) });
    } finally {
      setTestingModrinth(false);
      modrinthFeedbackTimer = setTimeout(() => {
        setModrinthTestResult(null);
      }, 3500);
    }
  };

  const handleClearModrinth = async () => {
    if (modrinthFeedbackTimer) clearTimeout(modrinthFeedbackTimer);
    setModrinthTokenDraft(null);
    setModrinthTestResult(null);
    await updateSetting("modrinth_token", "");
    showToast({
      title: "Modrinth Token Cleared",
      message: "Switched to public unauthenticated access",
      type: "info",
    });
  };

  const openInstanceOptions = (id: string) => {
    setActiveInstanceId(id);
    setInitialInstanceTab("settings");
    setActiveScreen("mods");
  };

  return (
    <div class="screen-enter settings-screen-container">
      {/* Top Header Bar: Section Title */}
      <div class="settings-top-bar">
        <div class="settings-title-group">
          <div class="section-label">Settings</div>
          <span class="settings-subtitle">// GLOBAL CONFIGURATION & HARDWARE PROFILE</span>
        </div>
      </div>

      {/* Top Tactile Shelf Deck (Horizontal Navigation on Left + Symmetrical Search on Right) */}
      <nav class="settings-shelf" aria-label="Settings navigation">
        <div class="settings-shelf-tabs">
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "all" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("all"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconLayers />
            <span>All</span>
          </button>
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "general" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("general"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconSettingsIcon />
            <span>General</span>
          </button>
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "resources" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("resources"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconCube />
            <span>Resources</span>
          </button>
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "instances" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("instances"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconMonitor />
            <span>Instance</span>
          </button>
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "keybinds" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("keybinds"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconBolt />
            <span>Keybinds</span>
          </button>
          <button
            type="button"
            class={`settings-shelf-btn ${tab() === "about" && !isSearching() ? "active" : ""}`}
            onClick={() => { setTab("about"); setSearch(""); canvasRef?.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <IconInfo />
            <span>About</span>
          </button>
        </div>

        {/* Search input (Canonical 32px height, anchored to right) */}
        <div class="settings-search-wrap">
          <span class="settings-search-icon">
            <IconSearch />
          </span>
          <input
            type="text"
            class="settings-search"
            placeholder="Search settings..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <Show when={search()}>
            <button
              type="button"
              class="settings-search-clear tip-below"
              onClick={() => setSearch("")}
              data-tip="Clear search"
              aria-label="Clear search"
            >
              <IconX />
            </button>
          </Show>
        </div>
      </nav>

      {/* Content area */}
      <div ref={canvasRef} class="settings-content settings-content-canvas">
      <Show when={settings()}>
        {/* ═══ GENERAL ═══ */}
        <Show when={isSearching() ? matchesGeneral() : (tab() === "all" || tab() === "general")}>
          <div class="settings-category">
            <div class="page-header">
              <div class="page-title-group">
                <div class="page-title">General</div>
                <div class="page-subtitle">Core launcher preferences and client lifecycle options</div>
              </div>
            </div>

            <div class="cards-container">
              {/* ═══ BENTO 1: TACTILE THEME PALETTE & SHELL SYNC ═══ */}
              <Show when={!isSearching() || matchesThemes()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconPalette />
                      <span>Tactile Theme Palette & Accent</span>
                    </div>
                    <span class="bento-badge bento-badge-accent">WIN32 COM SYNCED</span>
                  </div>

                  <div class="card-section-body">
                    <div class="theme-card-grid">
                      <For each={THEMES}>
                        {(t) => {
                          const isActive = () => (settings()?.theme || "neon-aurora") === t.id;
                          return (
                            <div
                              class={`theme-card ${isActive() ? "active" : ""}`}
                              onClick={() => {
                                updateSetting("theme", t.id);
                              }}
                            >
                              <div class="theme-card-emblem-wrap">
                                <img
                                  class="theme-card-emblem"
                                  src={t.logo}
                                  alt={t.name}
                                  draggable={false}
                                />
                              </div>
                              <div class="theme-card-title">{t.name}</div>
                              <div class="theme-card-desc">{t.tagline}</div>
                              <div class="theme-card-swatches">
                                <For each={t.swatches}>
                                  {(hex) => (
                                    <span
                                      class="theme-swatch tip-below"
                                      data-tip={hex}
                                      style={{ "background-color": hex }}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>

                  <div class="card-section-footer">
                    <span>THEME ENGINE: TACTILE DYNAMIC</span>
                    <span>NO RESTART REQUIRED</span>
                  </div>
                </div>
              </Show>

              {/* ═══ BENTO 2: FLOATING DOCK & DISPLAY ═══ */}
              <Show when={!isSearching() || matchesDock()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconLayers />
                      <span>Floating Dock & Display</span>
                    </div>
                    <span class="bento-badge">INTERFACE</span>
                  </div>

                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      <Show when={isGeneralSection() || matches("Auto-hide dock", "Hide floating dock across all screens until hovered", "dock", "autohide", "floating dock")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("auto_hide_dock", !settings()!.auto_hide_dock)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Auto-hide floating dock</span>
                            <span class="setting-desc">Hides floating dock across all screens until hovered</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.auto_hide_dock}
                              onChange={(val) => updateSetting("auto_hide_dock", val)}
                              aria-label="Auto-hide floating dock"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Pagination dock position", "Position and orientation of the pagination dock", "pagination", "page dock")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Pagination dock position</span>
                            <span class="setting-desc">Position and orientation of page indicator</span>
                          </div>
                          <div class="setting-control">
                            <Dropdown
                              width="145px"
                              value={settings()!.pagination_position || "bottom"}
                              options={[
                                { value: "bottom", label: "Bottom Centered" },
                                { value: "left", label: "Left Centered" },
                                { value: "right", label: "Right Centered" },
                              ]}
                              onChange={(val) => updateSetting("pagination_position", val as "bottom" | "left" | "right")}
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Download notifications", "Show toast notifications when downloads start and complete", "toasts", "download toast", "notifications")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("download_toasts", !settings()!.download_toasts)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Download notifications</span>
                            <span class="setting-desc">Show toast notifications for downloads</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.download_toasts}
                              onChange={(val) => updateSetting("download_toasts", val)}
                              aria-label="Download notifications"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Boot splash", "Show the animated logo splash on startup", "splash", "startup", "boot")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("splash_screen", !settings()!.splash_screen)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Boot splash animation</span>
                            <span class="setting-desc">Show animated logo splash on startup</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.splash_screen}
                              onChange={(val) => updateSetting("splash_screen", val)}
                              aria-label="Boot splash animation"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <div class="card-section-footer">
                    <span>DOCK: {(settings()?.pagination_position || "bottom").toUpperCase()}</span>
                    <span>ANIMATION: {settings()?.splash_screen ? "ON" : "OFF"}</span>
                  </div>
                </div>
              </Show>

              {/* ═══ BENTO 3: INTEGRATIONS & GAMEPLAY ═══ */}
              <Show when={!isSearching() || matchesIntegrations()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconPuzzle />
                      <span>Integrations & Gameplay</span>
                    </div>
                    <span class="bento-badge bento-badge-accent">EXTENSIONS</span>
                  </div>

                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      <Show when={isGeneralSection() || matches("Vermeil companion mod", "Auto-install companion mod", "companion", "in-game cape", "companion mod")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("enable_companion_mod", !(settings()!.enable_companion_mod ?? true))}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Global companion auto-install</span>
                            <span class="setting-desc">Installs companion mod during instance preparation</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.enable_companion_mod ?? true}
                              onChange={(val) => updateSetting("enable_companion_mod", val)}
                              aria-label="Global companion auto-install"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Discord Rich Presence", "Display playing status", "discord", "rpc", "rich presence")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("discord_rpc", !settings()!.discord_rpc)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Discord Rich Presence</span>
                            <span class="setting-desc">Show game status in Discord</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.discord_rpc}
                              onChange={(val) => updateSetting("discord_rpc", val)}
                              aria-label="Discord Rich Presence"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Show snapshots", "Include experimental versions", "snapshots", "snapshot", "experimental")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("show_snapshots", !settings()!.show_snapshots)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Show snapshots</span>
                            <span class="setting-desc">Include experimental Minecraft versions</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.show_snapshots}
                              onChange={(val) => updateSetting("show_snapshots", val)}
                              aria-label="Show snapshots"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Force delete", "Skip confirmation when deleting instances", "delete", "remove", "confirmation")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("force_delete", !settings()!.force_delete)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Force direct delete</span>
                            <span class="setting-desc">Skip confirmation dialog on removals</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.force_delete}
                              onChange={(val) => updateSetting("force_delete", val)}
                              aria-label="Force direct delete"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <div class="card-section-footer">
                    <span>CLIENT INTEGRATIONS</span>
                    <span>ZERO TELEMETRY</span>
                  </div>
                </div>
              </Show>

              {/* ═══ BENTO 4: CLIENT LIFECYCLE & PROCESS ═══ */}
              <Show when={!isSearching() || matchesLifecycle()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconCpu />
                      <span>Client Lifecycle & Process</span>
                    </div>
                    <span class="bento-badge">PROCESS</span>
                  </div>

                  <div class="card-section-body">
                    <div class="setting-card-grid setting-card-grid--2col">
                      <Show when={isGeneralSection() || matches("Minimize to tray on launch", "Hides launcher when game starts", "tray", "minimize", "hide", "close")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("close_on_launch", !settings()!.close_on_launch)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Minimize to tray on launch</span>
                            <span class="setting-desc">Hides launcher when game starts</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.close_on_launch}
                              onChange={(val) => updateSetting("close_on_launch", val)}
                              aria-label="Minimize to tray on launch"
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isGeneralSection() || matches("Pop out logs on launch", "Opens the game log in a separate window", "logs", "popout", "console")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateSetting("popout_logs", !settings()!.popout_logs)}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Pop out logs on launch</span>
                            <span class="setting-desc">Opens the game log in a separate window</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={settings()!.popout_logs}
                              onChange={(val) => updateSetting("popout_logs", val)}
                              aria-label="Pop out logs on launch"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <div class="card-section-footer">
                    <span>PROCESS LIFECYCLE</span>
                    <span>STANDALONE LOGS</span>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* ═══ RESOURCES ═══ */}
        <Show when={isSearching() ? matchesResources() : (tab() === "all" || tab() === "resources")}>
          <div class="settings-category">
            <div class="page-header">
              <div class="page-title-group">
                <div class="page-title">Resources</div>
                <div class="page-subtitle">Storage paths, download concurrency, and Java environment</div>
              </div>
            </div>

            <div class="cards-container">
              <Show when={!isSearching() || matchesStorage()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconHardDrive />
                      <span>Storage Management</span>
                    </div>
                    <span class="bento-badge">LOCAL DISK</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      <div
                        class="setting-row"
                        style="cursor:pointer"
                        onClick={() => openAppDirectory()}
                      >
                        <div class="setting-info">
                          <span class="setting-name">App directory</span>
                          <span class="setting-desc settings-val--mono">{appDirectory() ?? "…"}</span>
                        </div>
                        <div class="setting-control">
                          <button
                            class="btn btn--sm"
                            onClick={(e) => { e.stopPropagation(); openAppDirectory(); }}
                          >
                            <IconFolderOpen /> Open
                          </button>
                        </div>
                      </div>

                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">App cache</span>
                          <span class="setting-desc">{formatCacheSize()} MB cached metadata and installers</span>
                        </div>
                        <div class="setting-control">
                          <button class="btn btn--sm" onClick={handlePurgeCache} disabled={purging()}>
                            {purging() ? "Purging..." : "Purge cache"}
                          </button>
                        </div>
                      </div>

                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Shared game data</span>
                          <span class="setting-desc">{formatSharedDataSize()} shared Minecraft assets</span>
                        </div>
                        <div class="setting-control">
                          <button
                            class="btn btn--sm"
                            onClick={handlePurgeSharedData}
                            disabled={purgingShared() || sharedDataSize() === 0}
                          >
                            {purgingShared() ? "Cleaning..." : "Clean data"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!isSearching() || matchesPerformance()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconBolt />
                      <span>Concurrency & Bandwidth</span>
                    </div>
                    <span class="bento-badge bento-badge-accent">MULTI-THREADED</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Concurrent downloads</span>
                          <span class="setting-desc">Max files downloading simultaneously (1–20)</span>
                        </div>
                        <div class="setting-control">
                          <div class="concurrency-control">
                            <input
                              class="concurrency-slider"
                              type="range"
                              min="1"
                              max="20"
                              step="1"
                              value={dlValue()}
                              style={`--slider-pct: ${((dlValue() - 1) / 19) * 100}%`}
                              onInput={(e) => {
                                const safe = clampConcurrency(parseInt(e.currentTarget.value), 20);
                                e.currentTarget.style.setProperty('--slider-pct', `${((safe - 1) / 19) * 100}%`);
                                setDlDraft(safe);
                                updateSetting("concurrent_downloads", safe);
                              }}
                            />
                            <input
                              class="concurrency-number"
                              type="number"
                              min="1"
                              max="20"
                              value={dlValue()}
                              onChange={(e) => {
                                const safe = clampConcurrency(parseInt(e.currentTarget.value), 20);
                                e.currentTarget.value = String(safe);
                                setDlDraft(safe);
                                updateSetting("concurrent_downloads", safe);
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Concurrent writes</span>
                          <span class="setting-desc">Max files being written to disk simultaneously (1–50)</span>
                        </div>
                        <div class="setting-control">
                          <div class="concurrency-control">
                            <input
                              class="concurrency-slider"
                              type="range"
                              min="1"
                              max="50"
                              step="1"
                              value={wrValue()}
                              style={`--slider-pct: ${((wrValue() - 1) / 49) * 100}%`}
                              onInput={(e) => {
                                const safe = clampConcurrency(parseInt(e.currentTarget.value), 50);
                                e.currentTarget.style.setProperty('--slider-pct', `${((safe - 1) / 49) * 100}%`);
                                setWrDraft(safe);
                                updateSetting("concurrent_writes", safe);
                              }}
                            />
                            <input
                              class="concurrency-number"
                              type="number"
                              min="1"
                              max="50"
                              value={wrValue()}
                              onChange={(e) => {
                                const safe = clampConcurrency(parseInt(e.currentTarget.value), 50);
                                e.currentTarget.value = String(safe);
                                setWrDraft(safe);
                                updateSetting("concurrent_writes", safe);
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Download speed limit</span>
                          <span class="setting-desc">
                            {speedValue() === 0 ? "Unlimited bandwidth (0 = uncapped)" : `Capped at ${speedValue()} MB/s across all transfers`}
                          </span>
                        </div>
                        <div class="setting-control">
                          <div class="concurrency-control">
                            <input
                              class="concurrency-slider"
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={Math.min(speedValue(), 100)}
                              style={`--slider-pct: ${(Math.min(speedValue(), 100) / 100) * 100}%`}
                              onInput={(e) => {
                                const safe = clampSpeedLimit(parseInt(e.currentTarget.value));
                                e.currentTarget.style.setProperty('--slider-pct', `${(Math.min(safe, 100) / 100) * 100}%`);
                                setSpeedDraft(safe);
                                updateSetting("download_speed_limit_mb", safe);
                              }}
                            />
                            <input
                              class="concurrency-number"
                              type="number"
                              min="0"
                              max="500"
                              value={speedValue()}
                              onChange={(e) => {
                                const safe = clampSpeedLimit(parseInt(e.currentTarget.value));
                                e.currentTarget.value = String(safe);
                                setSpeedDraft(safe);
                                updateSetting("download_speed_limit_mb", safe);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!isSearching() || matchesApis()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconKey />
                      <span>Content Platform APIs</span>
                    </div>
                    <span class="bento-badge">INTEGRATIONS</span>
                  </div>
                  <div class="card-section-body">
                    <div class="api-credential-grid">
                      {/* CurseForge API Key Card */}
                      <div class="api-credential-card">
                        <div class="api-credential-header">
                          <div class="api-credential-title-wrap">
                            <IconCurseForge />
                            <span class="api-credential-title">CurseForge API Key</span>
                          </div>
                          <Show when={Boolean(settings()?.curseforge_api_key?.trim())} fallback={
                            <span class="api-status-badge api-status-badge--default">Default</span>
                          }>
                            <span class="api-status-badge api-status-badge--custom">Custom</span>
                          </Show>
                        </div>
                        <span class="api-credential-desc">
                          Used for browsing, downloading mods, and importing modpacks. Leave blank to use the built-in default key.
                        </span>
                        <div class="api-credential-input-group">
                          <div class="api-credential-input-wrap">
                            <input
                              type={isCfFeedback() ? "text" : (showCfKey() ? "text" : "password")}
                              class={cfInputClass()}
                              placeholder={settings()?.curseforge_api_key ? "Custom key active" : "Using built-in default key"}
                              value={cfInputValue()}
                              readOnly={isCfFeedback()}
                              spellcheck={false}
                              onInput={(e) => {
                                if (!isCfFeedback()) setCfKeyDraft(e.currentTarget.value);
                              }}
                              onFocus={clearCfFeedback}
                              onClick={clearCfFeedback}
                              onBlur={commitCfKey}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  commitCfKey();
                                  (e.currentTarget as HTMLInputElement).blur();
                                } else if (e.key === "Escape") {
                                  setCfKeyDraft(null);
                                  (e.currentTarget as HTMLInputElement).blur();
                                }
                              }}
                            />
                            <button
                              type="button"
                              class="api-credential-eye-btn tip-below"
                              data-tip={showCfKey() ? "Hide key" : "Show key"}
                              aria-label={showCfKey() ? "Hide key" : "Show key"}
                              disabled={isCfFeedback()}
                              onClick={() => setShowCfKey(!showCfKey())}
                            >
                              <Show when={showCfKey()} fallback={<IconEye />}>
                                <IconEyeOff />
                              </Show>
                            </button>
                          </div>
                          <button
                            type="button"
                            class="btn btn--sm btn--neutral"
                            disabled={testingCf()}
                            onClick={handleTestCf}
                          >
                            {testingCf() ? "Testing..." : "Test"}
                          </button>
                          <Show when={Boolean(settings()?.curseforge_api_key?.trim())}>
                            <button
                              type="button"
                              class="btn btn--sm btn--neutral tip-below"
                              data-tip="Revert to built-in default key"
                              onClick={handleResetCf}
                            >
                              Reset
                            </button>
                          </Show>
                        </div>
                      </div>

                      {/* Modrinth Access Token Card */}
                      <div class="api-credential-card">
                        <div class="api-credential-header">
                          <div class="api-credential-title-wrap">
                            <IconModrinth />
                            <span class="api-credential-title">Modrinth Access Token</span>
                          </div>
                          <Show when={Boolean(settings()?.modrinth_token?.trim())} fallback={
                            <span class="api-status-badge api-status-badge--default">Public</span>
                          }>
                            <span class="api-status-badge api-status-badge--custom">Personal PAT</span>
                          </Show>
                        </div>
                        <span class="api-credential-desc">
                          Personal access token (PAT) for authenticated requests and higher rate limits. Optional (public by default).
                        </span>
                        <div class="api-credential-input-group">
                          <div class="api-credential-input-wrap">
                            <input
                              type={isModrinthFeedback() ? "text" : (showModrinthToken() ? "text" : "password")}
                              class={modrinthInputClass()}
                              placeholder={settings()?.modrinth_token ? "Personal PAT active" : "Leave blank for public access"}
                              value={modrinthInputValue()}
                              readOnly={isModrinthFeedback()}
                              spellcheck={false}
                              onInput={(e) => {
                                if (!isModrinthFeedback()) setModrinthTokenDraft(e.currentTarget.value);
                              }}
                              onFocus={clearModrinthFeedback}
                              onClick={clearModrinthFeedback}
                              onBlur={commitModrinthToken}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  commitModrinthToken();
                                  (e.currentTarget as HTMLInputElement).blur();
                                } else if (e.key === "Escape") {
                                  setModrinthTokenDraft(null);
                                  (e.currentTarget as HTMLInputElement).blur();
                                }
                              }}
                            />
                            <button
                              type="button"
                              class="api-credential-eye-btn tip-below"
                              data-tip={showModrinthToken() ? "Hide token" : "Show token"}
                              aria-label={showModrinthToken() ? "Hide token" : "Show token"}
                              disabled={isModrinthFeedback()}
                              onClick={() => setShowModrinthToken(!showModrinthToken())}
                            >
                              <Show when={showModrinthToken()} fallback={<IconEye />}>
                                <IconEyeOff />
                              </Show>
                            </button>
                          </div>
                          <button
                            type="button"
                            class="btn btn--sm btn--neutral"
                            disabled={testingModrinth()}
                            onClick={handleTestModrinth}
                          >
                            {testingModrinth() ? "Testing..." : "Test"}
                          </button>
                          <Show when={Boolean(settings()?.modrinth_token?.trim())}>
                            <button
                              type="button"
                              class="btn btn--sm btn--neutral tip-below"
                              data-tip="Clear custom token"
                              onClick={handleClearModrinth}
                            >
                              Clear
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!isSearching() || matchesJava()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconCoffee />
                      <span>Java Environment</span>
                    </div>
                    <span class="bento-badge">JVM RUNTIME</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-grid setting-card-grid--2col" style="margin-bottom:14px">
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Managed Java runtime</span>
                          <span class="setting-desc">
                            {settings()!.java_runtime === "zulu"
                              ? "Azul Zulu (Optimized OpenJDK)"
                              : settings()!.java_runtime === "corretto"
                              ? "Amazon Corretto (AWS Production OpenJDK)"
                              : "Eclipse Adoptium (Temurin · Default)"}
                          </span>
                        </div>
                        <div class="setting-control">
                          <Dropdown
                            value={settings()!.java_runtime === "auto" ? "adoptium" : settings()!.java_runtime}
                            options={[
                              { value: "adoptium", label: "Adoptium (Temurin)" },
                              { value: "zulu", label: "Azul Zulu" },
                              { value: "corretto", label: "Amazon Corretto" },
                            ]}
                            onChange={(val) => updateSetting("java_runtime", val)}
                          />
                        </div>
                      </div>

                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">GC preset</span>
                          <span class="setting-desc">
                            {settings()!.gc_preset === "zgc"
                              ? "Generational ZGC (High-End, Java 21+)"
                              : settings()!.gc_preset === "shenandoah"
                              ? "Adaptive Shenandoah (Low-Latency, Java 12+)"
                              : "Client-Tuned G1GC (Low & Mid-End, Java 8/17)"}
                          </span>
                        </div>
                        <div class="setting-control">
                          <Dropdown
                            value={settings()!.gc_preset}
                            options={[
                              { value: "g1gc", label: "G1GC (Client-Tuned · Recommended)" },
                              { value: "zgc", label: "ZGC (Generational · Java 21+)" },
                              { value: "shenandoah", label: "Shenandoah (Adaptive · Java 12+)" },
                            ]}
                            onChange={(val) => updateSetting("gc_preset", val)}
                          />
                        </div>
                      </div>
                    </div>
                    <div class="java-slots">
                      <For each={JAVA_SLOTS}>
                        {(major) => {
                          const path = () => javaPathFor(major);
                          const installed = () => Boolean(path());
                          const det = () => detectionFor(major);
                          const busy = () => javaBusy()[major] ?? null;
                          const eraLabel = () => {
                            switch (major) {
                              case 25: return "Minecraft 26.x+";
                              case 21: return "Minecraft 1.20.5 – 1.21.x";
                              case 17: return "Minecraft 1.18 – 1.20.4";
                              case 8: return "Minecraft 1.8.9 – 1.16";
                              default: return "";
                            }
                          };
                          return (
                            <div class="java-slot">
                              <div class="java-slot-header">
                                <div class="java-slot-title-wrap">
                                  <span class="java-slot-title">Java {major}</span>
                                  <span class="java-slot-subtitle">{eraLabel()}</span>
                                </div>
                                <Show when={installed()} fallback={
                                  <span class="java-status-badge java-status-badge--missing">Missing</span>
                                }>
                                  <span class="java-status-badge java-status-badge--ready">
                                    {det()?.is_vermeil_managed ? "Managed" : "Ready"}
                                  </span>
                                </Show>
                              </div>
                              <JavaPathInput
                                major={major}
                                value={path()}
                                placeholder={`No Java ${major} configured`}
                                disabled={busy() !== null}
                                onCommit={async (newPath) => {
                                  // Refresh the settings resource so other UI sees the
                                  // change, and refresh detections so the meta line
                                  // under the input picks up the new install.
                                  await refetch();
                                  if (newPath) {
                                    try {
                                      const install = await validateJavaPath(newPath);
                                      setJavaDetections(prev => {
                                        const without = prev.filter(i => i.path !== install.path);
                                        return [...without, install];
                                      });
                                    } catch {
                                      // Already toasted by JavaPathInput on the unhappy path.
                                    }
                                  }
                                }}
                              />
                              <Show when={det() && installed()}>
                                <div class="java-slot-meta">
                                  {det()!.full_version} · {det()!.arch} · {det()!.source.replace("_", " ")}
                                </div>
                              </Show>
                              <div class="java-slot-actions">
                                <button
                                  class={`btn btn--sm tip-below tip-right ${installed() ? "btn--neutral" : "btn--primary"}`}
                                  onClick={() => runInstall(major)}
                                  disabled={busy() !== null}
                                  data-tip={javaActionButtonTip(installed(), path(), det()?.full_version, settings()!.java_runtime === "auto" ? "adoptium" : settings()!.java_runtime, major, det()?.is_vermeil_managed)}
                                >
                                  <IconDownload />
                                  {javaActionButtonLabel(installed(), path(), det()?.full_version, settings()!.java_runtime === "auto" ? "adoptium" : settings()!.java_runtime, busy())}
                                </button>
                                <button
                                  class="btn btn--sm btn--neutral"
                                  onClick={() => runDetect(major)}
                                  disabled={busy() !== null}
                                >
                                  <IconSearch />
                                  {busy() === "detect" ? "Detecting..." : "Detect"}
                                </button>
                                <button
                                  class="btn btn--sm btn--neutral"
                                  onClick={() => runBrowse(major)}
                                  disabled={busy() !== null}
                                >
                                  <IconFolderOpen />
                                  {busy() === "browse" ? "Picking..." : "Browse"}
                                </button>
                                {(() => {
                                  const det = javaDetections().find((i) => i.path === path());
                                  const ownsCurrent = det?.is_vermeil_managed === true;
                                  return (
                                    <Show when={ownsCurrent}>
                                        <button
                                          class="btn btn--sm btn--danger tip-right"
                                          onClick={() => runDelete(major)}
                                          disabled={busy() !== null}
                                          data-tip="Delete Vermeil's downloaded copy"
                                        >
                                        <IconTrash />
                                        {busy() === "delete" ? "Deleting..." : "Delete"}
                                      </button>
                                    </Show>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>{/* .java-slots */}
                  </div>{/* .card-section-body */}
                </div>{/* .card-gamemode-section */}
              </Show>
            </div>{/* .cards-container */}
          </div>{/* .settings-category */}
        </Show>

        {/* ═══ INSTANCE OPTIONS ═══ */}
        <Show when={isSearching() ? matchesInstances() : (tab() === "all" || tab() === "instances")}>
          <div class="settings-category">
            <div class="page-header">
              <div class="page-title-group">
                <div class="page-title">Global Instance Defaults</div>
                <div class="page-subtitle">Default video, audio, window, and memory configurations applied to all instances</div>
              </div>
              <button class="btn btn--sm" onClick={() => {
                updateVideoSettings({
                  max_fps: 120,
                  vsync: true,
                  gui_scale: 0,
                  gamma: 1.0,
                  fov: 0.0,
                  view_bobbing: true,
                  fov_effects: 1.0,
                  show_subtitles: false,
                  mouse_sensitivity: 0.5,
                  invert_y_mouse: false,
                  auto_jump: false,
                  master_volume: 1.0,
                  music_volume: 1.0,
                  weather_volume: 1.0,
                  hostile_volume: 1.0,
                  block_volume: 1.0,
                  player_volume: 1.0,
                  window_width: null,
                  window_height: null,
                  start_maximized: null,
                });
              }}>Reset All</button>
            </div>

            <div class="cards-container">
              {/* Video Panel */}
              <Show when={!isSearching() || matchesVideo()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconMonitor />
                      <span>Display & Rendering</span>
                    </div>
                    <span class="bento-badge">RENDER ENGINE</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-grid setting-card-grid--2col">
                      {/* Max Framerate — slider */}
                      <Show when={isInstancesSection() || matches("max fps", "framerate", "fps limit")}>
                        <div class="setting-row setting-row--span-2">
                          <div class="setting-info">
                            <span class="setting-name">Max FPS</span>
                            <span class="setting-desc">{(vs().max_fps ?? 120) === 260 ? "Unlimited" : `${vs().max_fps ?? 120} FPS`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="10"
                              max="260"
                              step="10"
                              value={vs().max_fps ?? 120}
                              class="slider vs-slider"
                              style={`--slider-pct:${((vs().max_fps ?? 120) - 10) / 250 * 100}%`}
                              onInput={(e) => {
                                const val = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${(val - 10) / 250 * 100}%`);
                                updateVideoSettings({ max_fps: val });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* VSync */}
                      <Show when={isInstancesSection() || matches("vsync", "vertical sync", "sync frame rate")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ vsync: !(vs().vsync ?? true) })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">VSync</span>
                            <span class="setting-desc">Sync frame rate with monitor</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={vs().vsync ?? true}
                              onChange={(val) => updateVideoSettings({ vsync: val })}
                              aria-label="VSync"
                            />
                          </div>
                        </div>
                      </Show>

                      {/* GUI Scale */}
                      <Show when={isInstancesSection() || matches("gui scale", "ui scale", "interface scale")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">GUI Scale</span>
                            <span class="setting-desc">User interface scale</span>
                          </div>
                          <div class="setting-control">
                            <Dropdown
                              value={String(vs().gui_scale ?? 0)}
                              options={[
                                { value: "0", label: "Auto" },
                                { value: "1", label: "Small" },
                                { value: "2", label: "Normal" },
                                { value: "3", label: "Large" },
                                { value: "4", label: "Huge" },
                              ]}
                              onChange={(val) => {
                                updateVideoSettings({ gui_scale: parseInt(val) });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Brightness */}
                      <Show when={isInstancesSection() || matches("brightness", "gamma", "light")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Brightness</span>
                            <span class="setting-desc">{Math.round((vs().gamma ?? 1) * 100) === 0 ? "Moody (0%)" : Math.round((vs().gamma ?? 1) * 100) === 100 ? "Bright (100%)" : `${Math.round((vs().gamma ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().gamma === null ? 100 : Math.round(vs().gamma! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().gamma === null ? 100 : Math.round(vs().gamma! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ gamma: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* FOV */}
                      <Show when={isInstancesSection() || matches("fov", "field of view")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">FOV</span>
                            <span class="setting-desc">{`${Math.round(40 * (vs().fov ?? 0) + 70)}°`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="30"
                              max="110"
                              step="1"
                              value={vs().fov === null ? 70 : Math.round(40 * vs().fov! + 70)}
                              class="slider vs-slider"
                              style={`--slider-pct:${((vs().fov === null ? 70 : Math.round(40 * vs().fov! + 70)) - 30) / 80 * 100}%`}
                              onInput={(e) => {
                                const degrees = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${(degrees - 30) / 80 * 100}%`);
                                const fovValue = (degrees - 70) / 40;
                                updateVideoSettings({ fov: fovValue });
                              }}
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Accessibility & Motion Panel */}
              <Show when={!isSearching() || matchesAccessibility()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconSliders />
                      <span>Accessibility & Motion</span>
                    </div>
                    <span class="bento-badge">ASSISTIVE</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      {/* View Bobbing */}
                      <Show when={isInstancesSection() || matches("view bobbing", "camera motion", "walking", "bobbing")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ view_bobbing: !(vs().view_bobbing ?? true) })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">View Bobbing</span>
                            <span class="setting-desc">Camera motion while walking</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={vs().view_bobbing ?? true}
                              onChange={(val) => updateVideoSettings({ view_bobbing: val })}
                              aria-label="View Bobbing"
                            />
                          </div>
                        </div>
                      </Show>

                      {/* FOV Effects */}
                      <Show when={isInstancesSection() || matches("fov effects", "distortion", "effects", "zoom")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">FOV Effects</span>
                            <span class="setting-desc">{`${Math.round((vs().fov_effects ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().fov_effects === null ? 100 : Math.round(vs().fov_effects! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().fov_effects === null ? 100 : Math.round(vs().fov_effects! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ fov_effects: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Show Subtitles */}
                      <Show when={isInstancesSection() || matches("subtitles", "show subtitles", "captions")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ show_subtitles: !(vs().show_subtitles ?? false) })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Show Subtitles</span>
                            <span class="setting-desc">Directional sound captions on screen</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={vs().show_subtitles ?? false}
                              onChange={(val) => updateVideoSettings({ show_subtitles: val })}
                              aria-label="Show Subtitles"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Controls & Mouse Panel */}
              <Show when={!isSearching() || matchesControls()}>
                <div class="card-gamemode-section bento-col-6">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconMousePointer />
                      <span>Controls & Mouse</span>
                    </div>
                    <span class="bento-badge">INPUT & AXIS</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-stack">
                      {/* Mouse Sensitivity */}
                      <Show when={isInstancesSection() || matches("mouse sensitivity", "sensitivity", "aim", "mouse")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Mouse Sensitivity</span>
                            <span class="setting-desc">{Math.round((vs().mouse_sensitivity ?? 0.5) * 200) === 200 ? "Hyperspeed" : `${Math.round((vs().mouse_sensitivity ?? 0.5) * 200)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="200"
                              step="5"
                              value={vs().mouse_sensitivity === null ? 100 : Math.round(vs().mouse_sensitivity! * 200)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().mouse_sensitivity === null ? 100 : Math.round(vs().mouse_sensitivity! * 200)) / 2}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct / 2}%`);
                                updateVideoSettings({ mouse_sensitivity: pct / 200 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Invert Mouse */}
                      <Show when={isInstancesSection() || matches("invert mouse", "invert y", "axis")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ invert_y_mouse: !(vs().invert_y_mouse ?? false) })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Invert Mouse</span>
                            <span class="setting-desc">Invert vertical looking axis</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={vs().invert_y_mouse ?? false}
                              onChange={(val) => updateVideoSettings({ invert_y_mouse: val })}
                              aria-label="Invert Mouse"
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Auto-Jump */}
                      <Show when={isInstancesSection() || matches("auto-jump", "autojump", "jump")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ auto_jump: !(vs().auto_jump ?? false) })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Auto-Jump</span>
                            <span class="setting-desc">Automatically jump up step blocks</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={vs().auto_jump ?? false}
                              onChange={(val) => updateVideoSettings({ auto_jump: val })}
                              aria-label="Auto-Jump"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Audio Panel */}
              <Show when={!isSearching() || matchesAudio()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconVolume2 />
                      <span>Sound Levels</span>
                    </div>
                    <span class="bento-badge">AUDIO MIXER</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-grid">
                      {/* Master Volume */}
                      <Show when={isInstancesSection() || matches("master volume", "master", "sound")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Master Volume</span>
                            <span class="setting-desc">{`${Math.round((vs().master_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().master_volume === null ? 100 : Math.round(vs().master_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().master_volume === null ? 100 : Math.round(vs().master_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ master_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Music Volume */}
                      <Show when={isInstancesSection() || matches("music volume", "music", "soundtrack")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Music Volume</span>
                            <span class="setting-desc">{`${Math.round((vs().music_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().music_volume === null ? 100 : Math.round(vs().music_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().music_volume === null ? 100 : Math.round(vs().music_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ music_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Weather Volume */}
                      <Show when={isInstancesSection() || matches("weather volume", "weather", "rain", "thunder")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Weather</span>
                            <span class="setting-desc">{`${Math.round((vs().weather_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().weather_volume === null ? 100 : Math.round(vs().weather_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().weather_volume === null ? 100 : Math.round(vs().weather_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ weather_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Hostile Creatures */}
                      <Show when={isInstancesSection() || matches("hostile volume", "hostile", "monsters", "mobs")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Hostile Creatures</span>
                            <span class="setting-desc">{`${Math.round((vs().hostile_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().hostile_volume === null ? 100 : Math.round(vs().hostile_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().hostile_volume === null ? 100 : Math.round(vs().hostile_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ hostile_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Blocks */}
                      <Show when={isInstancesSection() || matches("block volume", "blocks", "placing", "breaking")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Blocks</span>
                            <span class="setting-desc">{`${Math.round((vs().block_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().block_volume === null ? 100 : Math.round(vs().block_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().block_volume === null ? 100 : Math.round(vs().block_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ block_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Players */}
                      <Show when={isInstancesSection() || matches("player volume", "players", "footsteps")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Players</span>
                            <span class="setting-desc">{`${Math.round((vs().player_volume ?? 1) * 100)}%`}</span>
                          </div>
                          <div class="setting-control">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              value={vs().player_volume === null ? 100 : Math.round(vs().player_volume! * 100)}
                              class="slider vs-slider"
                              style={`--slider-pct:${(vs().player_volume === null ? 100 : Math.round(vs().player_volume! * 100))}%`}
                              onInput={(e) => {
                                const pct = parseInt(e.currentTarget.value);
                                e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                                updateVideoSettings({ player_volume: pct / 100 });
                              }}
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Window & Memory Panel */}
              <Show when={!isSearching() || matchesWindow() || matchesMemory()}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconMaximize2 />
                      <span>Window & Memory Defaults</span>
                    </div>
                    <span class="bento-badge">HARDWARE DEFAULTS</span>
                  </div>
                  <div class="card-section-body">
                    <div class="setting-card-grid">
                      {/* Resolution preset dropdown */}
                      <Show when={isInstancesSection() || matches("resolution", "window size", "dimensions", "width", "height")}>
                        <div class="setting-row">
                          <div class="setting-info">
                            <span class="setting-name">Resolution</span>
                            <span class="setting-desc">Default window size</span>
                          </div>
                          <div class="setting-control">
                            <Dropdown
                              disabled={!!vs().start_maximized}
                              value={vs().window_width && vs().window_height ? `${vs().window_width}x${vs().window_height}` : "1280x720"}
                              options={[
                                { value: "1280x720", label: "1280 × 720" },
                                { value: "1366x768", label: "1366 × 768" },
                                { value: "1600x900", label: "1600 × 900" },
                                { value: "1920x1080", label: "1920 × 1080" },
                                { value: "2560x1440", label: "2560 × 1440" },
                                { value: "3840x2160", label: "3840 × 2160" },
                              ]}
                              onChange={(val) => {
                                const [w, h] = val.split("x").map(Number);
                                updateVideoSettings({ window_width: w, window_height: h });
                              }}
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Maximized toggle */}
                      <Show when={isInstancesSection() || matches("maximized", "start maximized", "fullscreen", "monitor")}>
                        <div
                          class="setting-row setting-row--clickable"
                          onClick={() => updateVideoSettings({ start_maximized: !vs().start_maximized })}
                        >
                          <div class="setting-info">
                            <span class="setting-name">Maximized</span>
                            <span class="setting-desc">Launch filled to monitor</span>
                          </div>
                          <div class="setting-control">
                            <TactileSwitch
                              checked={!!vs().start_maximized}
                              onChange={(val) => updateVideoSettings({ start_maximized: val })}
                              aria-label="Maximized"
                            />
                          </div>
                        </div>
                      </Show>

                      {/* Maximum RAM cap */}
                      <Show when={isInstancesSection() || matches("maximum ram", "ram", "memory", "adaptive ceiling", "heap", "mb", "gb")}>
                        <div class="setting-row setting-row--span-2">
                          <div class="setting-info">
                            <span class="setting-name">Maximum RAM</span>
                            <span class="setting-desc">Adaptive ceiling</span>
                          </div>
                          <div class="setting-control">
                            <Dropdown
                              value={String(settings()!.adaptive_ram_max_mb || 0)}
                              options={(() => {
                                const sysMb = systemMemoryMb() || 0;
                                const auto = adaptiveDefaultMax(sysMb);
                                return [
                                  { value: "0", label: `Auto (${formatMemoryGb(auto)})` },
                                  { value: "2048", label: "2 GB" },
                                  { value: "3072", label: "3 GB" },
                                  { value: "4096", label: "4 GB" },
                                  { value: "6144", label: "6 GB" },
                                  { value: "8192", label: "8 GB" },
                                  { value: "10240", label: "10 GB" },
                                  { value: "12288", label: "12 GB" },
                                  { value: "14336", label: "14 GB" },
                                  { value: "16384", label: "16 GB" },
                                ];
                              })()}
                              onChange={(val) => {
                                updateSetting("adaptive_ram_max_mb", parseInt(val) || 0);
                              }}
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Instances Panel */}
              <Show when={!isSearching() || isInstancesSection() || (instances() || []).some(i => matches(i.name, i.game_version, i.loader.type))}>
                <div class="card-gamemode-section bento-col-12">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconLayers />
                      <span>Configure Instances</span>
                    </div>
                    <span class="bento-badge">INSTANCE OVERRIDES</span>
                  </div>
                  <div class="card-section-body">
                    <div class="card-grid">
                      <For each={instances() || []}>
                        {(inst) => {
                          const iconUrl = resolveAssetUrl(inst.icon);
                          const colorClass = (() => {
                            switch (inst.loader.type) {
                              case "fabric": return "fabric";
                              case "quilt": return "quilt";
                              case "neoforge": return "blue";
                              case "forge": return "orange";
                              default: return "green";
                            }
                          })();
                          return (
                            <Show when={!isSearching() || isInstancesSection() || matches(inst.name, inst.game_version, inst.loader.type)}>
                              <div class="card card--inst" style="cursor:pointer" onClick={() => openInstanceOptions(inst.id)}>
                                <div class={`inst-card-thumb inst-card-icon ${colorClass}`}>
                                  <Show when={iconUrl} fallback={
                                    <span class="inst-card-thumb-letter">{inst.name.trim().charAt(0).toUpperCase() || "?"}</span>
                                  }>
                                    <img
                                      src={iconUrl!}
                                      alt=""
                                      draggable={false}
                                      onError={(e) => {
                                        e.currentTarget.style.display = "none";
                                      }}
                                    />
                                  </Show>
                                </div>
                                <div class="inst-card-body">
                                  <div class="inst-card-title">{inst.name}</div>
                                  <div class="inst-card-sub">
                                    {inst.game_version} · {inst.mod_count} {inst.mod_count === 1 ? "mod" : "mods"} · {inst.window.width}x{inst.window.height}
                                  </div>
                                  <div class="inst-card-badges">
                                    <div class="inst-card-badges-track">
                                      <span class={`badge badge--loader ${loaderBadgeClass(inst.loader.type)}`}>{loaderLabel(inst.loader.type)}</span>
                                      <Show when={(inst.source_platforms || []).includes("modrinth")}>
                                        <span class="badge badge--source badge--modrinth tip-below" data-tip="Available on Modrinth"><IconModrinth /></span>
                                      </Show>
                                      <Show when={(inst.source_platforms || []).includes("curseforge")}>
                                        <span class="badge badge--source badge--curseforge tip-below" data-tip="Available on CurseForge"><IconCurseForge /></span>
                                      </Show>
                                      <Show when={inst.ingame_cape_supported}>
                                        <span class="badge badge--companion tip-below" data-tip="Vermeil companion mod supported">
                                          <img src="/logo.png" alt="Vermeil" draggable={false} />
                                        </span>
                                      </Show>
                                    </div>
                                  </div>
                                </div>
                                <div class="inst-card-arrow">
                                  <IconChevronRight />
                                </div>
                              </div>
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            </div>{/* .cards-container */}
          </div>{/* .settings-category */}
        </Show>

        {/* ═══ KEYBINDS ═══ */}
        <Show when={isSearching() ? matchesKeybinds() : (tab() === "all" || tab() === "keybinds")}>
          <div class="settings-category">
            <div class="page-header">
              <div class="page-title-group">
                <div class="page-title">Keybinds</div>
                <div class="page-subtitle">Global keyboard shortcuts and in-app navigation hotkeys</div>
              </div>
              <button class="btn btn--sm" onClick={() => updateSetting("keybinds", {})}>Reset to Defaults</button>
            </div>

            <div class="cards-container">
              <div class="card-gamemode-section bento-col-12">
                <div class="card-section-header">
                  <div class="bento-card-title">
                    <IconBolt />
                    <span>Global Launcher Hotkeys</span>
                  </div>
                  <span class="bento-badge">RECORDABLE</span>
                </div>

                <div class="card-section-body">
                  <div class="setting-card-grid setting-card-grid--2col">
                    <For each={KEYBINDS}>
                      {(action) => (
                        <Show when={isKeybindsSection() || matches(action.label, action.description, action.default)}>
                          <div class="setting-row">
                            <div class="setting-info">
                              <span class="setting-name">{action.label}</span>
                              <Show when={action.description}>
                                <span class="setting-desc">{action.description}</span>
                              </Show>
                            </div>
                            <div class="setting-control">
                              <KeybindCapture
                                binding={resolveBinding(action.id, settings()?.keybinds)}
                                defaultBinding={action.default}
                                onChange={(newBinding) => {
                                  const current = { ...(settings()?.keybinds ?? {}) };
                                  if (!newBinding) {
                                    // Reset → remove override so default kicks in
                                    delete current[action.id];
                                  } else {
                                    current[action.id] = newBinding;
                                  }
                                  updateSetting("keybinds", current);
                                }}
                              />
                            </div>
                          </div>
                        </Show>
                      )}
                    </For>
                  </div>

                  <div class="card-section-hint" style="margin-top:4px">
                    Click a binding and press the new key combination. Escape cancels capture. The reset arrow restores default.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* ═══ ABOUT ═══ */}
        <Show when={isSearching() ? matchesAbout() : (tab() === "all" || tab() === "about")}>
          <div class="settings-category">
            <div class="page-header">
              <div class="page-title-group">
                <div class="page-title">About</div>
                <div class="page-subtitle">Version info, release channels, and community links</div>
              </div>
            </div>

            <div class="cards-container">
              {/* Card 1: Software Version & Release Channel (bento-col-6) */}
              <div class="card-gamemode-section bento-col-6">
                <div class="card-section-header">
                  <div class="bento-card-title">
                    <IconRefresh />
                    <span>Software & Release Channel</span>
                  </div>
                  <span class="bento-badge">v{appVersion() ?? "1.0.0"} LATEST</span>
                </div>

                <div class="card-section-body">
                  <div class="setting-card-stack">
                    <Show when={isAboutSection() || matches("Vermeil", "Version", appVersion())}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="setting-name">Vermeil Launcher</span>
                            <span
                              class="card-section-tag"
                              style={`font-size: 10px; font-weight: 700; padding: 2px 6px; letter-spacing: 0.5px; background: ${isCurrentExperimental() ? "rgba(234, 179, 8, 0.15)" : "rgba(16, 185, 129, 0.15)"}; color: ${isCurrentExperimental() ? "#eab308" : "#10b981"}; border: 1px solid ${isCurrentExperimental() ? "rgba(234, 179, 8, 0.3)" : "rgba(16, 185, 129, 0.3)"};`}
                            >
                              {isCurrentExperimental() ? "EXPERIMENTAL" : "STABLE"}
                            </span>
                          </div>
                          <span class="setting-desc">Version {appVersion() || "..."} (Tauri v2 · SolidJS)</span>
                        </div>
                        <div class="setting-control">
                          <span class="bento-badge">v{appVersion() ?? "1.0.0"}</span>
                        </div>
                      </div>
                    </Show>

                    {/* Release Channel Selector */}
                    <Show when={isAboutSection() || matches("Release Channel", "Update channel", "channel", "stable", "experimental")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Release Channel</span>
                          <span class="setting-desc">
                            {activeChannel() === "experimental"
                              ? "Opted in to bleeding-edge test builds"
                              : "Standard verified production releases"}
                          </span>
                        </div>
                        <div class="setting-control">
                          <div class="update-channel-pills">
                            <button
                              type="button"
                              class={`update-channel-pill ${activeChannel() === "stable" ? "active" : ""}`}
                              onClick={() => handleChannelSwitch("stable")}
                            >
                              Stable
                            </button>
                            <button
                              type="button"
                              class={`update-channel-pill ${activeChannel() === "experimental" ? "active" : ""}`}
                              onClick={() => handleChannelSwitch("experimental")}
                            >
                              Experimental
                            </button>
                          </div>
                        </div>
                      </div>
                    </Show>

                    {/* Auto-update launcher */}
                    <Show when={isAboutSection() || matches("Auto-update launcher", "Automatically checks for updates", "update", "updates", "updater")}>
                      <div
                        class="setting-row setting-row--clickable"
                        onClick={() => updateSetting("auto_update", !settings()!.auto_update)}
                      >
                        <div class="setting-info">
                          <span class="setting-name">Auto-update launcher</span>
                          <span class="setting-desc">Silently check for new versions on startup</span>
                        </div>
                        <div class="setting-control">
                          <TactileSwitch
                            checked={settings()!.auto_update}
                            onChange={(val) => updateSetting("auto_update", val)}
                            aria-label="Auto-update launcher"
                          />
                        </div>
                      </div>
                    </Show>

                    {/* Check for updates */}
                    <Show when={isAboutSection() || matches("Check for updates", "Manually check for a new version", "update")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Manual update check</span>
                          <span class="setting-desc">
                            Query releases on the {activeChannel() === "experimental" ? "Experimental" : "Stable"} channel
                          </span>
                        </div>
                        <div class="setting-control">
                          <button
                            class="btn btn--sm"
                            onClick={() => checkForUpdates(false, activeChannel() === "experimental" || (activeChannel() === "stable" && isCurrentExperimental()))}
                          >
                            Check now
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>

                <div class="card-section-footer">
                  <span>CHANNEL: {activeChannel().toUpperCase()}</span>
                  <span>AUTO-UPDATE {settings()?.auto_update ? "ON" : "OFF"}</span>
                </div>
              </div>

              {/* Card 2: Project, Community & Legal (bento-col-6) */}
              <div class="card-gamemode-section bento-col-6">
                <div class="card-section-header">
                  <div class="bento-card-title">
                    <IconGlobe />
                    <span>Project & Community</span>
                  </div>
                  <span class="bento-badge">OPEN SOURCE</span>
                </div>

                <div class="card-section-body">
                  <div class="setting-card-stack">
                    {/* Website */}
                    <Show when={isAboutSection() || matches("Website", "vermeillauncher.app")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Official Website</span>
                          <span class="setting-desc">vermeillauncher.app</span>
                        </div>
                        <div class="setting-control">
                          <button class="btn btn--sm" onClick={() => openUrl("https://vermeillauncher.app/")}>
                            <IconGlobe />
                            Visit
                          </button>
                        </div>
                      </div>
                    </Show>

                    {/* GitHub */}
                    <Show when={isAboutSection() || matches("GitHub", "Repository", "Source code")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">GitHub Repository</span>
                          <span class="setting-desc">Source code, issues, and discussions</span>
                        </div>
                        <div class="setting-control">
                          <button class="btn btn--sm tip-right" onClick={() => openUrl("https://github.com/VermeilDev/Vermeil-Launcher")} data-tip="GitHub Repository" aria-label="GitHub Repository">
                            <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                          </button>
                        </div>
                      </div>
                    </Show>

                    {/* Privacy */}
                    <Show when={isAboutSection() || matches("Privacy", "No data is collected")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Privacy Policy</span>
                          <span class="setting-desc">Zero telemetry, local device storage only</span>
                        </div>
                        <div class="setting-control">
                          <button class="btn btn--sm" onClick={() => openUrl("https://github.com/VermeilDev/Vermeil-Launcher/blob/main/PRIVACY.md")}>
                            Read policy
                          </button>
                        </div>
                      </div>
                    </Show>

                    {/* License */}
                    <Show when={isAboutSection() || matches("License", "GPLv3", "Open source")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Open Source License</span>
                          <span class="setting-desc">GNU General Public License v3.0 (or later)</span>
                        </div>
                        <div class="setting-control">
                          <button class="btn btn--sm" onClick={() => openUrl("https://github.com/VermeilDev/Vermeil-Launcher/blob/main/LICENSE")}>
                            View license
                          </button>
                        </div>
                      </div>
                    </Show>

                    {/* Disclaimer */}
                    <Show when={isAboutSection() || matches("Disclaimer", "unofficial Minecraft launcher")}>
                      <div class="setting-row">
                        <div class="setting-info">
                          <span class="setting-name">Disclaimer</span>
                          <span class="setting-desc" style="line-height:1.4">
                            Unofficial launcher. Not affiliated with or endorsed by Mojang or Microsoft.
                          </span>
                        </div>
                        <div class="setting-control">
                          <span class="bento-badge">GPLv3</span>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>

                <div class="card-section-footer">
                  <span>VERMEIL LAUNCHER</span>
                  <span>ZERO TELEMETRY</span>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* Empty state when search has no results */}
        <Show when={!hasAnyMatches()}>
          <div class="settings-no-results">
            No settings found matching "{search()}"
          </div>
        </Show>
        </Show>
        </div>{/* .settings-content */}

      {/* Chooser modal — rendered at the screen root so it overlays the
          Settings tabs when the Detect action returns multiple matches. The
          single-match path bypasses this entirely (auto-applied in
          `runDetect`). */}
      <Show when={chooser()}>
        <JavaChooserModal
          major={chooser()!.major}
          options={chooser()!.options}
          onCancel={() => setChooser(null)}
          onPick={async (install) => {
            const major = chooser()!.major;
            setChooser(null);
            await applyDetection(major, install);
          }}
        />
      </Show>

      {/* Rollback confirmation modal */}
      <Show when={showRollbackConfirmModal()}>
        <div class="modal-overlay" onClick={() => setShowRollbackConfirmModal(false)}>
          <div
            class="modal"
            style="width: 480px; max-width: 95vw;"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-header">
              <div class="modal-header-left">
                <span class="card-section-tag tag-settings-general">CHANNEL ROLLBACK</span>
                <div>
                  <div class="modal-title">Switch to Stable Channel?</div>
                  <div style="font-size: 11px; color: var(--muted); margin-top: 2px">
                    Current build: v{appVersion()} (Experimental)
                  </div>
                </div>
              </div>
            </div>

            <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3); font-size: 13px; line-height: 1.5; color: var(--text-muted);">
              <p>
                You are currently running an experimental pre-release. Switching to the <strong>Stable</strong> channel will check for the latest verified production milestone and offer a safe rollback.
              </p>
              <div style="background: var(--surface-sunken); border: 1px solid var(--border); border-left: 3px solid var(--accent); padding: 12px 14px; font-size: 12px; color: var(--text); line-height: 1.5;">
                <strong style="color: var(--accent);">Data Safety:</strong> All your Minecraft instances, worlds, saves, screenshots, shaderpacks, and accounts will be completely preserved.
              </div>
            </div>

            <div class="modal-footer">
              <button
                class="btn btn--subtle"
                onClick={() => setShowRollbackConfirmModal(false)}
              >
                Cancel
              </button>
              <button
                class="btn btn--primary"
                onClick={confirmRollbackToStable}
              >
                Rollback to Stable
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Settings;
