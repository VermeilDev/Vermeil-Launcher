// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, createResource, createMemo, For, Show, onCleanup, onMount } from "solid-js";
import {
  setActiveScreen,
  setActiveInstanceId,
  setInitialInstanceTab,
  setGameLaunched,
  gameRunning,
  setGameRunning,
  launchingInstanceId,
  setLaunchingInstanceId,
  instances,
  ensureAccountOrPrompt,
  account,
  activeSkinUrl,
  setDockPagination,
  clearGameLogs,
  showToast,
  cloudConnected,
} from "../App";
import {
  launchInstance,
  listInstanceWorlds,
  getJavaNews,
  getArticleBody,
  NewsArticle,
  getSettings,
  getQuickServers,
  saveQuickServer,
  removeQuickServer,
  pingServer,
  QuickServerEntry,
  ServerPingInfo,
} from "../ipc/commands";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";
import { createGridPageSize } from "../lib/gridPageSize";
import {
  IconPlay,
  IconGlobe,
  IconShieldCheck,
  IconPlus,
  IconMicrosoft,
  IconUser,
  IconExternalLink,
  IconServer,
  IconCloud,
  IconCloudSync,
  IconX,
  IconSettings,
} from "../components/Icons";
import CharacterStage from "../components/CharacterStage";
import { openInstancePickerModal } from "../modals/InstancePickerModal";
import { openServerRoutingModal } from "../modals/ServerRoutingModal";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Format the most recent play timestamp as an ISO calendar date (`YYYY-MM-DD`,
 *  e.g. "2026-09-25") in the user's local timezone. Returns null when absent
 *  or unparseable so the telemetry plate renders "None". */
function relativePlayed(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Format total playtime seconds into compact hours/minutes (e.g. "14h 25m", "< 1m", "0m"). */
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

/** Loader-tinted icon-tile background class (mirrors the Library card). */
function bannerColor(loader: string): string {
  switch (loader) {
    case "fabric": return "fabric";
    case "quilt": return "quilt";
    case "forge": return "orange";
    case "neoforge": return "purple";
    default: return "green";
  }
}

interface NewsBadgeInfo {
  label: string;
  tagClass: string;
}

/** Categorize a news article into a distinct tag type for the tactile badge. */
function getNewsCategory(article: NewsArticle): NewsBadgeInfo {
  const v = (article.version || "").toLowerCase();
  const t = (article.title || "").toLowerCase();

  if (v.includes("rc") || t.includes("release candidate")) {
    return { label: article.version || "Release Candidate", tagClass: "tag-rc" };
  }
  if (v.includes("pre") || t.includes("pre-release")) {
    return { label: article.version || "Pre-Release", tagClass: "tag-pre" };
  }
  if (/\d+w\d+[a-z]/.test(v) || t.includes("snapshot")) {
    return { label: article.version || "Snapshot", tagClass: "tag-snapshot" };
  }
  if (v && /^\d+\.\d+(\.\d+)?$/.test(v.trim())) {
    return { label: `Java ${article.version}`, tagClass: "tag-release" };
  }
  if (v) {
    return { label: article.version, tagClass: "tag-release" };
  }
  return { label: "Article", tagClass: "tag-article" };
}

export interface RecentWorldEntry {
  instanceId: string;
  instanceName: string;
  instanceIcon: string;
  loader: string;
  gameVersion: string;
  worldName: string;
  worldFolder: string;
  worldIcon: string | null;
  lastPlayed: string;
  playTimeSeconds: number;
}

// Quick servers deck, dispatch mode, and live server ping cache live at MODULE scope
// so they survive screen remounting on navigation (Home is unmounted when switching screens via <Show>).
// Keeping them at module scope ensures server icons, latency badges, and player counts
// render synchronously with zero flicker when returning to Home.
const [dispatchMode, setDispatchMode] = createSignal<"dual" | "worlds" | "servers">("dual");
export const [quickServers, setQuickServers] = createSignal<QuickServerEntry[]>([]);
export const [serverPings, setServerPings] = createSignal<Record<string, ServerPingInfo>>({});
let quickServersLoaded = false;
let cachedRecentWorlds: RecentWorldEntry[] = [];

/** Ping a server in the background, updating live metrics only if still present in deck. */
function refreshServerPing(address: string) {
  pingServer(address)
    .then((info) => {
      if (quickServers().some((s) => s.address === address)) {
        setServerPings((prev) => ({ ...prev, [address]: info }));
      }
    })
    .catch(() => {});
}

/**
 * Parse and format Minecraft server supported version range (min & max).
 * Handles formatting codes (§), range delimiters (-, /, to), proxy names (Velocity, Paper, BungeeCord),
 * and standard version strings.
 *
 * Examples:
 * - "Requires MC 1.8 / 1.21" -> "1.8 – 1.21"
 * - "We support: 1.20-1.21" -> "1.20 – 1.21"
 * - "Velocity 1.7.2-26.3" -> "1.7.2 – 26.3"
 * - "1.8.x - 1.21.4" -> "1.8 – 1.21.4"
 * - "Paper 1.20.4" -> "1.20.4"
 */
export function formatServerVersion(versionName?: string | null, motd?: string | null): string | null {
  const parse = (text?: string | null): string | null => {
    if (!text) return null;
    const clean = text.replace(/§[0-9a-fk-or]/gi, "").trim();
    if (!clean) return null;
    const versionRegex = /\b(?:\d{1,2}\.\d+(?:\.\d+)?(?:\.x)?|\d{2}\.\d+)\b/gi;
    const matches = clean.match(versionRegex);
    if (!matches || matches.length === 0) {
      const fallback = clean.match(/(?:1\.\d+[\w.+*-]*)/);
      return fallback ? fallback[0] : null;
    }
    if (matches.length === 1) {
      return clean.includes(matches[0] + "+") ? `${matches[0]}+` : matches[0];
    }
    const minVer = matches[0].replace(/\.x$/, "");
    const maxVer = matches[matches.length - 1];
    return minVer === maxVer ? minVer : `${minVer} – ${maxVer}`;
  };

  return parse(versionName) || parse(motd);
}

export function cleanMotd(text?: string | null): string {
  if (!text) return "Minecraft Multiplayer Server";
  const clean = text.replace(/§[0-9a-fk-or]/gi, "").replace(/\s+/g, " ").trim();
  return clean || "Minecraft Multiplayer Server";
}

const Home: Component = () => {
  const [newServerAddress, setNewServerAddress] = createSignal("");

  const [news] = createResource(getJavaNews);
  const [newsFilter, setNewsFilter] = createSignal<"all" | "releases" | "snapshots" | "articles">("all");
  const [newsPage, setNewsPage] = createSignal(1);

  // Fixed 4x3 (12 cards) on maximized/large windows (> 800px) and 4x2 (8 cards)
  // on standard small windows (720px). Adapts column count downwards if window narrows.
  const newsPageSize = createGridPageSize({
    track: 230,
    gap: 14,
    rowHeight: 220,
    maxRows: () => (window.innerHeight > 800 ? 3 : 2),
    maxCols: 4,
    fixedRows: true,
    debounceMs: 0,
  });

  const [selectedArticle, setSelectedArticle] = createSignal<NewsArticle | null>(null);
  const [articleBody, setArticleBody] = createSignal<string>("");
  const [loadingArticle, setLoadingArticle] = createSignal(false);

  // Load Quick Servers from backend on initial mount & background refresh pings
  onMount(async () => {
    let list = quickServers();
    if (!quickServersLoaded) {
      try {
        list = await getQuickServers();
        setQuickServers(list);
        quickServersLoaded = true;
      } catch (err) {
        console.error("Failed to load quick servers:", err);
      }
    }
    for (const s of list) refreshServerPing(s.address);
  });

  // Close the article modal on Escape without triggering parent navigation
  createEffect(() => {
    if (!selectedArticle()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setSelectedArticle(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  // Intercept links inside sanitized article HTML to open via Tauri opener
  const handleModalClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest("a") as HTMLAnchorElement | null;
    if (anchor && anchor.href) {
      e.preventDefault();
      openUrl(anchor.href);
    }
  };

  const openArticle = async (article: NewsArticle) => {
    setSelectedArticle(article);
    setArticleBody("");
    if (!article.body) return;
    setLoadingArticle(true);
    try {
      const body = await getArticleBody(article.body);
      setArticleBody(body);
    } catch {
      setArticleBody("");
    } finally {
      setLoadingArticle(false);
    }
  };

  /** Format an ISO-8601 date to a short, locale-aware label (e.g. "May 19, 2026").
   *  Returns "" for missing/unparseable dates so the caller can omit it. */
  const formatArticleDate = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const filteredNews = createMemo(() => {
    const all = news() || [];
    const filter = newsFilter();
    if (filter === "all") return all;
    return all.filter((a) => {
      const cat = getNewsCategory(a);
      if (filter === "releases") {
        return cat.tagClass === "tag-release" || cat.tagClass === "tag-rc" || cat.tagClass === "tag-pre";
      }
      if (filter === "snapshots") {
        return cat.tagClass === "tag-snapshot";
      }
      if (filter === "articles") {
        return cat.tagClass === "tag-article";
      }
      return true;
    });
  });

  const totalNewsPages = () => Math.ceil((filteredNews()?.length || 0) / newsPageSize.size());
  const visibleNews = () => {
    const all = filteredNews();
    const start = (newsPage() - 1) * newsPageSize.size();
    return all.slice(start, start + newsPageSize.size());
  };

  // Reset page when filter changes or size grows
  createEffect(() => {
    newsFilter();
    setNewsPage(1);
  });

  createEffect(() => {
    const total = totalNewsPages();
    if (newsPage() > total) setNewsPage(Math.max(1, total));
  });

  // Push news pagination into the floating dock when there are multiple pages
  createEffect(() => {
    if (totalNewsPages() > 1) {
      setDockPagination({ current: newsPage(), total: totalNewsPages(), onPageChange: setNewsPage });
    } else {
      setDockPagination(null);
    }
  });
  onCleanup(() => setDockPagination(null));

  const [settings, { refetch: refetchSettings }] = createResource(getSettings);
  createEffect(() => {
    instances();
    refetchSettings();
  });
  createEffect(() => {
    const onSettingsChanged = () => refetchSettings();
    window.addEventListener("vermeil-settings-changed", onSettingsChanged);
    onCleanup(() => window.removeEventListener("vermeil-settings-changed", onSettingsChanged));
  });

  const [recentWorlds] = createResource(
    instances,
    async (insts) => {
      if (!insts || insts.length === 0) return [];

      const topInsts = insts.slice(0, 10);
      const results = await Promise.allSettled(
        topInsts.map(async (inst) => {
          const worlds = await listInstanceWorlds(inst.id);
          return worlds.map((w) => ({
            instanceId: inst.id,
            instanceName: inst.name,
            instanceIcon: inst.icon,
            loader: inst.loader.type,
            gameVersion: inst.game_version,
            worldName: w.name,
            worldFolder: w.folder_name,
            worldIcon: w.icon,
            lastPlayed: w.last_played,
            playTimeSeconds: w.play_time_seconds,
          }));
        })
      );

      const allWorlds = results.flatMap((res) => (res.status === "fulfilled" ? res.value : []));
      allWorlds.sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));
      const top6 = allWorlds.slice(0, 6);
      cachedRecentWorlds = top6;
      return top6;
    },
    { initialValue: cachedRecentWorlds }
  );

  const onlineServersCount = createMemo(() => {
    const pings = serverPings();
    return Object.values(pings).filter((p) => p.is_online).length;
  });

  const handlePlayWorld = async (
    instanceId: string,
    worldFolder?: string,
    worldName?: string,
    gameVersion?: string
  ) => {
    if (!ensureAccountOrPrompt()) return;
    if (launchingInstanceId()) {
      showToast({ title: "Launching in progress", message: "Please wait for the current launch to finish.", type: "info" });
      return;
    }
    if (gameRunning()) {
      showToast({ title: "Game already running", message: "Another game instance is currently active. Please close it first.", type: "info" });
      return;
    }
    setActiveInstanceId(instanceId);
    setLaunchingInstanceId(instanceId);
    setGameRunning(true);
    setInitialInstanceTab("logs");
    setGameLaunched(true);
    setActiveScreen("mods");
    clearGameLogs(instanceId);

    if (worldName) {
      // Check version support for native Quick Play (Minecraft 1.20+)
      const isModern = (() => {
        if (!gameVersion) return true;
        const match = gameVersion.match(/^(\d+)\.(\d+)/);
        if (!match) return true;
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        return major > 1 || (major === 1 && minor >= 20);
      })();

      if (!isModern) {
        showToast({
          title: "Direct Join: MC 1.20+ Required",
          message: `MC ${gameVersion} doesn't support quick play. Opening to title screen.`,
          type: "info",
        });
      } else {
        showToast({
          title: "Resuming World",
          message: `Launching into ${worldName}...`,
          type: "info",
        });
      }
    }

    try {
      await launchInstance(instanceId, worldFolder);
    } catch (e) {
      setGameRunning(false);
      console.error("Failed to launch instance for world:", e);
      showToast({
        title: "Launch Failed",
        message: String(e),
        type: "error",
      });
    } finally {
      setLaunchingInstanceId(null);
    }
  };

  const launchServerWithInstance = async (instanceId: string, serverAddress: string, serverName: string) => {
    if (!ensureAccountOrPrompt()) return;
    if (launchingInstanceId()) {
      showToast({ title: "Launching in progress", message: "Please wait for the current launch to finish.", type: "info" });
      return;
    }
    if (gameRunning()) {
      showToast({ title: "Game already running", message: "Another game instance is currently active. Please close it first.", type: "info" });
      return;
    }

    const inst = (instances() ?? []).find((i) => i.id === instanceId);
    const gameVersion = inst?.game_version;

    const isModern = (() => {
      if (!gameVersion) return true;
      const match = gameVersion.match(/^(\d+)\.(\d+)/);
      if (!match) return true;
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 1 || (major === 1 && minor >= 20);
    })();

    if (!isModern) {
      showToast({
        title: "Direct Join: MC 1.20+ Required",
        message: `MC ${gameVersion || "older"} doesn't support quick play. Opening to title screen.`,
        type: "info",
      });
    } else {
      showToast({
        title: "Quick Joining Server",
        message: `Connecting to ${serverName} (${serverAddress})...`,
        type: "info",
      });
    }

    setActiveInstanceId(instanceId);
    setLaunchingInstanceId(instanceId);
    setGameRunning(true);
    setInitialInstanceTab("logs");
    setGameLaunched(true);
    setActiveScreen("mods");
    clearGameLogs(instanceId);

    try {
      await launchInstance(instanceId, undefined, serverAddress);
    } catch (e) {
      setGameRunning(false);
      console.error("Failed to launch instance for server quick join:", e);
      showToast({
        title: "Launch Failed",
        message: String(e),
        type: "error",
      });
    } finally {
      setLaunchingInstanceId(null);
    }
  };

  const handleJoinServer = async (server: QuickServerEntry) => {
    if (!ensureAccountOrPrompt()) return;
    if (launchingInstanceId()) {
      showToast({ title: "Launching in progress", message: "Please wait for the current launch to finish.", type: "info" });
      return;
    }
    if (gameRunning()) {
      showToast({ title: "Game already running", message: "Another game instance is currently active. Please close it first.", type: "info" });
      return;
    }

    const allInst = instances() ?? [];
    if (allInst.length === 0) {
      showToast({ title: "No instances found", message: "Please create a Minecraft instance first.", type: "warning" });
      return;
    }

    // If this server has a remembered linked instance that still exists, boot immediately
    if (server.linked_instance_id && allInst.some((i) => i.id === server.linked_instance_id)) {
      await launchServerWithInstance(server.linked_instance_id, server.address, server.name);
      return;
    }

    // Otherwise, open the tactile InstancePickerModal so the user can choose which instance to connect with
    openInstancePickerModal(
      {
        name: server.name,
        address: server.address,
        versionRange: formatServerVersion(
          serverPings()[server.address]?.version_name || server.last_ping_version,
          serverPings()[server.address]?.motd || server.last_ping_motd
        ),
        onConfirm: async (chosenInstId: string, remember: boolean) => {
          if (remember) {
            const updated: QuickServerEntry = {
              ...server,
              linked_instance_id: chosenInstId,
            };
            try {
              await saveQuickServer(updated);
              setQuickServers((prev) => prev.map((s) => (s.address === server.address ? updated : s)));
            } catch (err) {
              console.error("Failed to save remembered instance for server:", err);
            }
          }
          await launchServerWithInstance(chosenInstId, server.address, server.name);
        },
      },
      server.linked_instance_id
    );
  };

  const handleAddServer = async () => {
    const addr = newServerAddress().trim();
    if (!addr) return;
    if (quickServers().length >= 6) {
      showToast({
        title: "Server Limit Reached",
        message: "You can have up to 6 servers in your Quick Join deck. Remove one to add another.",
        type: "warning",
      });
      return;
    }
    // Strict validation: max 253 chars, valid hostname / IP characters
    const isSafe = addr.length <= 253 && /^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$/.test(addr);
    if (!isSafe) {
      showToast({
        title: "Invalid Server Address",
        message: "Please enter a valid hostname or IP address (e.g. play.cubecraft.net).",
        type: "warning",
      });
      return;
    }

    const newEntry: QuickServerEntry = {
      name: addr,
      address: addr,
      linked_instance_id: null,
    };

    try {
      const updated = await saveQuickServer(newEntry);
      setQuickServers(updated);
      setNewServerAddress("");
      showToast({
        title: "Server Added",
        message: `Added ${addr} to your Quick Join deck.`,
        type: "success",
      });
      refreshServerPing(addr);
    } catch (err) {
      console.error("Failed to save quick server:", err);
      showToast({
        title: "Failed to Add Server",
        message: String(err),
        type: "error",
      });
    }
  };

  const handleRemoveServer = async (address: string) => {
    try {
      const updated = await removeQuickServer(address);
      setQuickServers(updated);
      setServerPings((prev) => {
        const next = { ...prev };
        delete next[address];
        return next;
      });
      showToast({
        title: "Server Removed",
        message: `Removed ${address} from Quick Join deck.`,
        type: "info",
      });
    } catch (err) {
      console.error("Failed to remove server:", err);
      showToast({
        title: "Failed to Remove Server",
        message: String(err),
        type: "error",
      });
    }
  };

  // Header summary across all instances
  const headerSummary = createMemo(() => {
    const list = instances() ?? [];
    const sett = settings();
    const instRecent = list
      .map((i) => i.last_played)
      .filter((d): d is string => Boolean(d))
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .pop();

    const globalLast = sett?.last_active_at ?? null;
    let mostRecent: string | null = null;
    if (instRecent && globalLast) {
      mostRecent = new Date(instRecent).getTime() > new Date(globalLast).getTime() ? instRecent : globalLast;
    } else {
      mostRecent = instRecent ?? globalLast;
    }

    const currentInstPlaySeconds = list.reduce((acc, i) => acc + (i.total_play_seconds || 0), 0);
    const globalPlaySeconds = sett?.lifetime_play_seconds ?? 0;
    const totalPlaySeconds = Math.max(currentInstPlaySeconds, globalPlaySeconds);

    return {
      count: list.length,
      relative: relativePlayed(mostRecent),
      totalPlaytime: formatPlaytime(totalPlaySeconds),
      hasPlaytime: totalPlaySeconds > 0,
    };
  });

  const displayName = () => account()?.name ?? "Player";

  return (
    <div class="screen-enter">
      {/* ═══ TOP CONTEXT BAR: TITLE & LIVE TELEMETRY / AUTH PILLS ═══ */}
      <div class="home-header">
        <div class="home-header-titles">
          <h1>Home</h1>
          <div class="subtext">// OPERATOR HUB &amp; MOJANG TRANSMISSION FEED</div>
        </div>
        <div class="home-header-meta">
          <div
            class="header-meta-pill tip-below"
            style="cursor: pointer;"
            onClick={() => setActiveScreen("account")}
            data-tip="Manage account and identity"
          >
            <Show
              when={account()}
              fallback={
                <>
                  <IconUser class="header-pill-icon" />
                  <span>Account: <strong>Not Signed In</strong></span>
                </>
              }
            >
              <IconMicrosoft class="header-pill-icon" />
              <span>Microsoft: <strong>{displayName()}</strong></span>
            </Show>
          </div>

          <div
            class="header-meta-pill tip-below tip-right"
            style="cursor: pointer;"
            onClick={() => setActiveScreen("account")}
            data-tip="Google Cloud Settings Sync"
          >
            <Show
              when={cloudConnected()}
              fallback={
                <>
                  <span style="opacity: 0.6; display: inline-flex;"><IconCloud class="header-pill-icon" /></span>
                  <span>Cloud: <strong>Off</strong></span>
                </>
              }
            >
              <span style="color: #34d399; display: inline-flex;"><IconCloudSync class="header-pill-icon" /></span>
              <span>Cloud: <strong style="color: #34d399;">Synced</strong></span>
            </Show>
          </div>
        </div>
      </div>

      {/* ═══ BENTO ROW 1: OPERATOR PERSONA + QUICK-RESUME DISPATCH STATION ═══ */}
      <div class="home-bento-hero">
        {/* Bento 1: Operator Persona (Slim & Focused 3D Stage) */}
        <div class="bento-card">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconUser />
              <span>Operator</span>
            </div>
          </div>

          {/* Elevated Character 3D Stage with Hexagonal Pedestal */}
          <div class="operator-stage-area">
            <CharacterStage skinUrl={activeSkinUrl()} />
          </div>

          {/* Operator Integrated Footer: Live Stats Ticker */}
          <div class="operator-footer-bar">
            <div class="operator-ticker">
              <span><strong>{headerSummary()?.count ?? 0}</strong> Inst</span>
              <span class="ticker-dot">·</span>
              <span><strong>{headerSummary()?.totalPlaytime ?? "0m"}</strong> Played</span>
              <span class="ticker-dot">·</span>
              <span>{headerSummary()?.relative ? headerSummary()!.relative : "No Activity"}</span>
            </div>
          </div>
        </div>

        {/* Bento 2: Quick-Resume & Server Dispatch Station */}
        <div class="bento-card">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconPlay />
              <span>Dispatch Station</span>
              <span class="bento-card-sub">// QUICK LAUNCH</span>
            </div>
            <div class="card-segmented-tabs">
              <button
                type="button"
                class={`card-tab-btn ${dispatchMode() === "dual" ? "active" : ""}`}
                onClick={() => setDispatchMode("dual")}
              >
                Dual Deck
              </button>
              <button
                type="button"
                class={`card-tab-btn ${dispatchMode() === "worlds" ? "active" : ""}`}
                onClick={() => setDispatchMode("worlds")}
              >
                Worlds ({(recentWorlds() ?? []).length})
              </button>
              <button
                type="button"
                class={`card-tab-btn ${dispatchMode() === "servers" ? "active" : ""}`}
                onClick={() => setDispatchMode("servers")}
              >
                Servers ({quickServers().length})
              </button>
            </div>
          </div>

          <div class="dispatch-station-body">
            {/* VIEW 1: DUAL DECK (Worlds + Servers Equal 50/50 Symmetry, 148px Invariant) */}
            <Show when={dispatchMode() === "dual"}>
              <div class="dispatch-sym-grid">
                {/* Left Column: Recent Singleplayer Worlds */}
                <div class="sym-col">
                  <div class="sym-col-header">
                    <span>Recent Worlds</span>
                    <span class="bento-badge">{(recentWorlds() ?? []).length} LOCAL</span>
                  </div>

                    {/* Hero World (Slot 0) */}
                    <Show
                      when={(recentWorlds() ?? []).length > 0}
                      fallback={
                        <div
                          class="sym-hero-tile tile--world"
                          style="opacity: 0.8;"
                          onClick={() => setActiveScreen("library")}
                        >
                          <div class="sym-thumb">
                            <IconPlus />
                          </div>
                          <div class="sym-meta">
                            <div class="sym-title">No recent worlds</div>
                            <div class="sym-sub">Launch an instance in Library to play</div>
                          </div>
                        </div>
                      }
                    >
                      {(() => {
                        const hero = () => recentWorlds()![0];
                        return (
                          <div
                            class="sym-hero-tile tile--world"
                            onClick={() => {
                              setActiveInstanceId(hero().instanceId);
                              setInitialInstanceTab("content");
                              setActiveScreen("mods");
                            }}
                          >
                            <div class={`sym-thumb ${bannerColor(hero().loader)}`}>
                              <Show when={hero().worldIcon} fallback={<IconGlobe />}>
                                <img src={hero().worldIcon!} alt="" draggable={false} />
                              </Show>
                            </div>
                            <div class="sym-meta">
                              <div class="sym-tags">
                                <span class={`sym-tag ${loaderBadgeClass(hero().loader)}`}>
                                  {loaderLabel(hero().loader)}
                                </span>
                                <span class="sym-tag">{hero().gameVersion}</span>
                                <Show when={hero().playTimeSeconds && hero().playTimeSeconds > 0}>
                                  <span class="sym-tag">{formatPlaytime(hero().playTimeSeconds)}</span>
                                </Show>
                              </div>
                              <div class="sym-title">{hero().worldName}</div>
                              <div class="sym-sub">{hero().instanceName} · {relativePlayed(hero().lastPlayed) ?? "Recently"}</div>
                            </div>
                            <button
                              type="button"
                              class="sym-cta-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayWorld(
                                  hero().instanceId,
                                  hero().worldFolder,
                                  hero().worldName,
                                  hero().gameVersion
                                );
                              }}
                            >
                              <IconPlay />
                              <span>Play</span>
                            </button>
                          </div>
                        );
                      })()}
                    </Show>

                    {/* Secondary World 1 (Slot 1) */}
                    <Show
                      when={(recentWorlds() ?? []).length > 1}
                      fallback={
                        <div
                          class="sym-sub-tile"
                          style="opacity: 0.6;"
                          onClick={() => setActiveScreen("library")}
                          data-tip="Launch an instance in your Library to play a world"
                        >
                          <div class="sym-sub-left">
                            <div class="sym-sub-thumb"><IconPlus /></div>
                            <div class="sym-sub-meta">
                              <div class="sym-sub-name">Empty Slot</div>
                              <div class="sym-sub-sub">Create or play a world</div>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      {(() => {
                        const w = () => recentWorlds()![1];
                        return (
                          <div
                            class="sym-sub-tile"
                            onClick={() => {
                              setActiveInstanceId(w().instanceId);
                              setInitialInstanceTab("content");
                              setActiveScreen("mods");
                            }}
                          >
                            <div class="sym-sub-left">
                              <div class={`sym-sub-thumb ${bannerColor(w().loader)}`}>
                                <Show when={w().worldIcon} fallback={<IconGlobe />}>
                                  <img src={w().worldIcon!} alt="" draggable={false} />
                                </Show>
                              </div>
                              <div class="sym-sub-meta">
                                <div class="sym-tags">
                                  <span class={`sym-tag ${loaderBadgeClass(w().loader)}`}>
                                    {loaderLabel(w().loader)}
                                  </span>
                                  <span class="sym-tag">{w().gameVersion}</span>
                                </div>
                                <div class="sym-sub-name">{w().worldName}</div>
                                <div class="sym-sub-sub">{w().instanceName} · {formatPlaytime(w().playTimeSeconds)}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              class="sym-sub-btn"
                              aria-label={`Play ${w().worldName}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayWorld(w().instanceId, w().worldFolder, w().worldName, w().gameVersion);
                              }}
                            >
                              <IconPlay />
                            </button>
                          </div>
                        );
                      })()}
                    </Show>

                    {/* Secondary World 2 (Height 38px) */}
                    <Show
                      when={(recentWorlds() ?? []).length > 2}
                      fallback={
                        <div
                          class="sym-sub-tile"
                          style="opacity: 0.6;"
                          onClick={() => setActiveScreen("library")}
                          data-tip="Launch an instance in your Library to play a world"
                        >
                          <div class="sym-sub-left">
                            <div class="sym-sub-thumb"><IconPlus /></div>
                            <div class="sym-sub-meta">
                              <div class="sym-sub-name">Empty Slot</div>
                              <div class="sym-sub-sub">Create or play a world</div>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      {(() => {
                        const w = () => recentWorlds()![2];
                        return (
                          <div
                            class="sym-sub-tile"
                            onClick={() => {
                              setActiveInstanceId(w().instanceId);
                              setInitialInstanceTab("content");
                              setActiveScreen("mods");
                            }}
                          >
                            <div class="sym-sub-left">
                              <div class={`sym-sub-thumb ${bannerColor(w().loader)}`}>
                                <Show when={w().worldIcon} fallback={<IconGlobe />}>
                                  <img src={w().worldIcon!} alt="" draggable={false} />
                                </Show>
                              </div>
                              <div class="sym-sub-meta">
                                <div class="sym-tags">
                                  <span class={`sym-tag ${loaderBadgeClass(w().loader)}`}>
                                    {loaderLabel(w().loader)}
                                  </span>
                                  <span class="sym-tag">{w().gameVersion}</span>
                                </div>
                                <div class="sym-sub-name">{w().worldName}</div>
                                <div class="sym-sub-sub">{w().instanceName} · {formatPlaytime(w().playTimeSeconds)}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              class="sym-sub-btn"
                              aria-label={`Play ${w().worldName}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayWorld(w().instanceId, w().worldFolder, w().worldName, w().gameVersion);
                              }}
                            >
                              <IconPlay />
                            </button>
                          </div>
                        );
                      })()}
                    </Show>
                </div>

                {/* Right Column: Multiplayer Servers (Quick Join) */}
                <div class="sym-col">
                  <div class="sym-col-header">
                    <span>Quick Join Servers</span>
                    <span class="bento-badge bento-badge-live">
                      <span class="status-dot" />
                      {onlineServersCount()} ONLINE
                    </span>
                  </div>

                  <Show
                    when={quickServers().length > 0}
                    fallback={
                      <div class="sym-hero-tile tile--server" style="opacity: 0.8;">
                        <div class="sym-thumb">
                          <IconServer />
                        </div>
                        <div class="sym-meta">
                          <div class="sym-title">No servers added</div>
                          <div class="sym-sub">Use the bar below to add a server</div>
                        </div>
                      </div>
                    }
                  >
                    {/* Featured Server (Height 60px) */}
                    {(() => {
                      const srv = () => quickServers()[0];
                      const ping = () => serverPings()[srv().address];
                      return (
                        <div class="sym-hero-tile tile--server">
                          <div class="sym-thumb">
                            <Show when={ping()?.favicon || srv().favicon} fallback={<IconServer />}>
                              {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                            </Show>
                          </div>
                          <div class="sym-meta">
                            <div class="sym-tags">
                              <Show when={ping()?.ping_ms != null}>
                                <span class="ping-badge">{ping()!.ping_ms}ms</span>
                              </Show>
                              <Show when={formatServerVersion(ping()?.version_name || srv().last_ping_version, ping()?.motd || srv().last_ping_motd)}>
                                {(ver) => (
                                  <span class="sym-tag sym-tag-version">
                                    MC {ver()}
                                  </span>
                                )}
                              </Show>
                            </div>
                            <div class="sym-title">{srv().name}</div>
                            <div class="sym-sub">
                              {srv().name.toLowerCase() !== srv().address.toLowerCase() ? `${srv().address} · ` : ""}
                              <Show
                                when={ping()?.players_online != null}
                                fallback={<span>Multiplayer Server</span>}
                              >
                                <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                <span> Online</span>
                              </Show>
                            </div>
                          </div>
                          <div class="sym-actions">
                            <button
                              type="button"
                              class="sym-hero-delete-btn tip-below tip-right"
                              data-tip="Remove"
                              aria-label={`Remove ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveServer(srv().address);
                              }}
                            >
                              <IconX />
                            </button>
                            <button
                              type="button"
                              class="sym-cta-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJoinServer(srv());
                              }}
                            >
                              <IconPlay />
                              <span>Join</span>
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>

                  {/* Secondary Server 1 (Height 38px) */}
                    <Show
                      when={quickServers().length > 1}
                      fallback={
                        <div
                          class="sym-sub-tile"
                          style="opacity: 0.6;"
                          data-tip="Use the input below to add servers"
                        >
                          <div class="sym-sub-left">
                            <div class="sym-sub-thumb"><IconPlus /></div>
                            <div class="sym-sub-meta">
                              <div class="sym-sub-name">Empty Slot</div>
                              <div class="sym-sub-sub">Add server in footer</div>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      {(() => {
                        const srv = () => quickServers()[1];
                        const ping = () => serverPings()[srv().address];
                        return (
                          <div class="sym-sub-tile tile--server">
                            <div class="sym-sub-left">
                              <div class="sym-sub-thumb">
                                <Show when={ping()?.favicon || srv().favicon} fallback={<IconServer />}>
                                  {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                                </Show>
                              </div>
                              <div class="sym-sub-meta">
                                <div class="sym-tags">
                                  <Show when={ping()?.ping_ms != null}>
                                    <span class="ping-badge">{ping()!.ping_ms}ms</span>
                                  </Show>
                                  <Show when={formatServerVersion(ping()?.version_name || srv().last_ping_version, ping()?.motd || srv().last_ping_motd)}>
                                    {(ver) => (
                                      <span class="sym-tag sym-tag-version">
                                        MC {ver()}
                                      </span>
                                    )}
                                  </Show>
                                </div>
                                <div class="sym-sub-name">{srv().name}</div>
                                <div class="sym-sub-sub">
                                  {srv().name.toLowerCase() !== srv().address.toLowerCase() ? `${srv().address} · ` : ""}
                                  <Show
                                    when={ping()?.players_online != null}
                                    fallback={<span>Multiplayer Server</span>}
                                  >
                                    <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                    <span> Online</span>
                                  </Show>
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              class="sym-sub-delete-btn tip-right"
                              data-tip="Remove"
                              aria-label={`Remove ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveServer(srv().address);
                              }}
                            >
                              <IconX />
                            </button>
                            <button
                              type="button"
                              class="sym-sub-btn"
                              aria-label={`Join ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJoinServer(srv());
                              }}
                            >
                              <IconPlay />
                            </button>
                          </div>
                        );
                      })()}
                    </Show>

                    {/* Secondary Server 2 (Height 38px) */}
                    <Show
                      when={quickServers().length > 2}
                      fallback={
                        <div
                          class="sym-sub-tile"
                          style="opacity: 0.6;"
                          data-tip="Use the input below to add servers"
                        >
                          <div class="sym-sub-left">
                            <div class="sym-sub-thumb"><IconPlus /></div>
                            <div class="sym-sub-meta">
                              <div class="sym-sub-name">Empty Slot</div>
                              <div class="sym-sub-sub">Add server in footer</div>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      {(() => {
                        const srv = () => quickServers()[2];
                        const ping = () => serverPings()[srv().address];
                        return (
                          <div class="sym-sub-tile tile--server">
                            <div class="sym-sub-left">
                              <div class="sym-sub-thumb">
                                <Show when={ping()?.favicon || srv().favicon} fallback={<IconServer />}>
                                  {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                                </Show>
                              </div>
                              <div class="sym-sub-meta">
                                <div class="sym-tags">
                                  <Show when={ping()?.ping_ms != null}>
                                    <span class="ping-badge">{ping()!.ping_ms}ms</span>
                                  </Show>
                                  <Show when={formatServerVersion(ping()?.version_name || srv().last_ping_version, ping()?.motd || srv().last_ping_motd)}>
                                    {(ver) => (
                                      <span class="sym-tag sym-tag-version">
                                        MC {ver()}
                                      </span>
                                    )}
                                  </Show>
                                </div>
                                <div class="sym-sub-name">{srv().name}</div>
                                <div class="sym-sub-sub">
                                  {srv().name.toLowerCase() !== srv().address.toLowerCase() ? `${srv().address} · ` : ""}
                                  <Show
                                    when={ping()?.players_online != null}
                                    fallback={<span>Multiplayer Server</span>}
                                  >
                                    <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                    <span> Online</span>
                                  </Show>
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              class="sym-sub-delete-btn tip-right"
                              data-tip="Remove"
                              aria-label={`Remove ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveServer(srv().address);
                              }}
                            >
                              <IconX />
                            </button>
                            <button
                              type="button"
                              class="sym-sub-btn"
                              aria-label={`Join ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJoinServer(srv());
                              }}
                            >
                              <IconPlay />
                            </button>
                          </div>
                        );
                      })()}
                    </Show>
                </div>
              </div>
            </Show>

            {/* VIEW 2: WORLDS ONLY (2 Heroes + 4 Sub-Tiles in 2x2 Grid = 6 Worlds, 246px Invariant) */}
            <Show when={dispatchMode() === "worlds"}>
              <div class="deck-full-layout">
                <div class="sym-col-header">
                  <span>Recent Singleplayer Worlds</span>
                  <span class="bento-badge">{(recentWorlds() ?? []).length} / 6 LOCAL</span>
                </div>

                <div class="deck-hero-grid">
                  {/* Hero Slot 1 */}
                  <Show
                    when={(recentWorlds() ?? []).length > 0}
                    fallback={
                      <div class="sym-hero-tile tile--world" onClick={() => setActiveScreen("library")}>
                        <div class="sym-thumb"><IconPlus /></div>
                        <div class="sym-meta">
                          <div class="sym-title">No recent worlds</div>
                          <div class="sym-sub">Launch an instance in Library to play</div>
                        </div>
                      </div>
                    }
                  >
                    {(() => {
                      const hero = () => recentWorlds()![0];
                      return (
                        <div
                          class="sym-hero-tile tile--world"
                          onClick={() => {
                            setActiveInstanceId(hero().instanceId);
                            setInitialInstanceTab("content");
                            setActiveScreen("mods");
                          }}
                        >
                          <div class={`sym-thumb ${bannerColor(hero().loader)}`}>
                            <Show when={hero().worldIcon} fallback={<IconGlobe />}>
                              <img src={hero().worldIcon!} alt="" draggable={false} />
                            </Show>
                          </div>
                          <div class="sym-meta">
                            <div class="sym-tags">
                              <span class={`sym-tag ${loaderBadgeClass(hero().loader)}`}>
                                {loaderLabel(hero().loader)}
                              </span>
                              <span class="sym-tag">{hero().gameVersion}</span>
                              <Show when={hero().playTimeSeconds && hero().playTimeSeconds > 0}>
                                <span class="sym-tag">{formatPlaytime(hero().playTimeSeconds)}</span>
                              </Show>
                            </div>
                            <div class="sym-title">{hero().worldName}</div>
                            <div class="sym-sub">{hero().instanceName} · {relativePlayed(hero().lastPlayed) ?? "Recently"}</div>
                          </div>
                          <button
                            type="button"
                            class="sym-cta-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlayWorld(hero().instanceId, hero().worldFolder, hero().worldName, hero().gameVersion);
                            }}
                          >
                            <IconPlay />
                            <span>Play</span>
                          </button>
                        </div>
                      );
                    })()}
                  </Show>

                  {/* Hero Slot 2 */}
                  <Show
                    when={(recentWorlds() ?? []).length > 1}
                    fallback={
                      <div
                        class="sym-hero-tile tile--world"
                        style="opacity: 0.6;"
                        onClick={() => setActiveScreen("library")}
                        data-tip="Launch an instance in your Library to play a world"
                      >
                        <div class="sym-thumb"><IconPlus /></div>
                        <div class="sym-meta">
                          <div class="sym-title">Empty Slot</div>
                          <div class="sym-sub">Create or play a world</div>
                        </div>
                      </div>
                    }
                  >
                    {(() => {
                      const hero = () => recentWorlds()![1];
                      return (
                        <div
                          class="sym-hero-tile tile--world"
                          onClick={() => {
                            setActiveInstanceId(hero().instanceId);
                            setInitialInstanceTab("content");
                            setActiveScreen("mods");
                          }}
                        >
                          <div class={`sym-thumb ${bannerColor(hero().loader)}`}>
                            <Show when={hero().worldIcon} fallback={<IconGlobe />}>
                              <img src={hero().worldIcon!} alt="" draggable={false} />
                            </Show>
                          </div>
                          <div class="sym-meta">
                            <div class="sym-tags">
                              <span class={`sym-tag ${loaderBadgeClass(hero().loader)}`}>
                                {loaderLabel(hero().loader)}
                              </span>
                              <span class="sym-tag">{hero().gameVersion}</span>
                              <Show when={hero().playTimeSeconds && hero().playTimeSeconds > 0}>
                                <span class="sym-tag">{formatPlaytime(hero().playTimeSeconds)}</span>
                              </Show>
                            </div>
                            <div class="sym-title">{hero().worldName}</div>
                            <div class="sym-sub">{hero().instanceName} · {relativePlayed(hero().lastPlayed) ?? "Recently"}</div>
                          </div>
                          <button
                            type="button"
                            class="sym-cta-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlayWorld(hero().instanceId, hero().worldFolder, hero().worldName, hero().gameVersion);
                            }}
                          >
                            <IconPlay />
                            <span>Play</span>
                          </button>
                        </div>
                      );
                    })()}
                  </Show>
                </div>

                <div class="deck-full-grid">
                  <For each={recentWorlds()!.slice(2, 6)}>
                    {(w) => (
                      <div
                        class="sym-sub-tile"
                        onClick={() => {
                          setActiveInstanceId(w.instanceId);
                          setInitialInstanceTab("content");
                          setActiveScreen("mods");
                        }}
                      >
                        <div class="sym-sub-left">
                          <div class={`sym-sub-thumb ${bannerColor(w.loader)}`}>
                            <Show when={w.worldIcon} fallback={<IconGlobe />}>
                              <img src={w.worldIcon!} alt="" draggable={false} />
                            </Show>
                          </div>
                          <div class="sym-sub-meta">
                            <div class="sym-tags">
                              <span class={`sym-tag ${loaderBadgeClass(w.loader)}`}>
                                {loaderLabel(w.loader)}
                              </span>
                              <span class="sym-tag">{w.gameVersion}</span>
                            </div>
                            <div class="sym-sub-name">{w.worldName}</div>
                            <div class="sym-sub-sub">{w.instanceName} · {formatPlaytime(w.playTimeSeconds)}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          class="sym-sub-btn"
                          aria-label={`Play ${w.worldName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePlayWorld(w.instanceId, w.worldFolder, w.worldName, w.gameVersion);
                          }}
                        >
                          <IconPlay />
                        </button>
                      </div>
                    )}
                  </For>

                  {/* Empty slots if fewer than 6 worlds */}
                  <For each={Array.from({ length: Math.max(0, 4 - Math.max(0, (recentWorlds()?.length ?? 0) - 2)) })}>
                    {() => (
                      <div
                        class="sym-sub-tile"
                        style="opacity: 0.6;"
                        onClick={() => setActiveScreen("library")}
                        data-tip="Launch an instance in your Library to play a world"
                      >
                        <div class="sym-sub-left">
                          <div class="sym-sub-thumb"><IconPlus /></div>
                          <div class="sym-sub-meta">
                            <div class="sym-sub-name">Empty Slot</div>
                            <div class="sym-sub-sub">Create or play a world</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* VIEW 3: SERVERS ONLY (2 Heroes + 4 Sub-Tiles in 2x2 Grid = 6 Servers, 246px Invariant) */}
            <Show when={dispatchMode() === "servers"}>
              <div class="deck-full-layout">
                <div class="sym-col-header">
                  <span>Quick Join Multiplayer Servers</span>
                  <span class="bento-badge bento-badge-live">
                    <span class="status-dot" />
                    {onlineServersCount()} ONLINE ({quickServers().length}/6)
                  </span>
                </div>

                <div class="deck-hero-grid">
                  {/* Hero Slot 1 */}
                  <Show
                    when={quickServers().length > 0}
                    fallback={
                      <div class="sym-hero-tile tile--server" style="opacity: 0.8;">
                        <div class="sym-thumb"><IconServer /></div>
                        <div class="sym-meta">
                          <div class="sym-title">No servers added</div>
                          <div class="sym-sub">Use the bar below to add a server</div>
                        </div>
                      </div>
                    }
                  >
                    {(() => {
                      const srv = () => quickServers()[0];
                      const ping = () => serverPings()[srv().address];
                      return (
                        <div class="sym-hero-tile tile--server">
                          <div class="sym-thumb">
                            <Show when={ping()?.favicon || srv().favicon} fallback={<IconServer />}>
                              {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                            </Show>
                          </div>
                          <div class="sym-meta">
                            <div class="sym-tags">
                              <Show when={ping()?.ping_ms != null}>
                                <span class="ping-badge">{ping()!.ping_ms}ms</span>
                              </Show>
                              <Show when={formatServerVersion(ping()?.version_name || srv().last_ping_version, ping()?.motd || srv().last_ping_motd)}>
                                {(ver) => (
                                  <span class="sym-tag sym-tag-version">
                                    MC {ver()}
                                  </span>
                                )}
                              </Show>
                            </div>
                            <div class="sym-title">{srv().name}</div>
                            <div class="sym-sub">
                              {srv().name.toLowerCase() !== srv().address.toLowerCase() ? `${srv().address} · ` : ""}
                              <Show
                                when={ping()?.players_online != null}
                                fallback={<span>Multiplayer Server</span>}
                              >
                                <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                <span> Online</span>
                              </Show>
                            </div>
                          </div>
                          <div class="sym-actions">
                            <button
                              type="button"
                              class="sym-hero-delete-btn tip-below tip-right"
                              data-tip="Remove"
                              aria-label={`Remove ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveServer(srv().address);
                              }}
                            >
                              <IconX />
                            </button>
                            <button
                              type="button"
                              class="sym-cta-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJoinServer(srv());
                              }}
                            >
                              <IconPlay />
                              <span>Join</span>
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>

                  {/* Hero Slot 2 */}
                  <Show
                    when={quickServers().length > 1}
                    fallback={
                      <div
                        class="sym-hero-tile tile--server"
                        style="opacity: 0.6;"
                        data-tip="Use the input below to add servers"
                      >
                        <div class="sym-thumb"><IconPlus /></div>
                        <div class="sym-meta">
                          <div class="sym-title">Empty Slot</div>
                          <div class="sym-sub">Add server in footer</div>
                        </div>
                      </div>
                    }
                  >
                    {(() => {
                      const srv = () => quickServers()[1];
                      const ping = () => serverPings()[srv().address];
                      return (
                        <div class="sym-hero-tile tile--server">
                          <div class="sym-thumb">
                            <Show when={ping()?.favicon || srv().favicon} fallback={<IconServer />}>
                              {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                            </Show>
                          </div>
                          <div class="sym-meta">
                            <div class="sym-tags">
                              <Show when={ping()?.ping_ms != null}>
                                <span class="ping-badge">{ping()!.ping_ms}ms</span>
                              </Show>
                              <Show when={formatServerVersion(ping()?.version_name || srv().last_ping_version, ping()?.motd || srv().last_ping_motd)}>
                                {(ver) => (
                                  <span class="sym-tag sym-tag-version">
                                    MC {ver()}
                                  </span>
                                )}
                              </Show>
                            </div>
                            <div class="sym-title">{srv().name}</div>
                            <div class="sym-sub">
                              {srv().name.toLowerCase() !== srv().address.toLowerCase() ? `${srv().address} · ` : ""}
                              <Show
                                when={ping()?.players_online != null}
                                fallback={<span>Multiplayer Server</span>}
                              >
                                <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                <span> Online</span>
                              </Show>
                            </div>
                          </div>
                          <div class="sym-actions">
                            <button
                              type="button"
                              class="sym-hero-delete-btn tip-below tip-right"
                              data-tip="Remove"
                              aria-label={`Remove ${srv().name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveServer(srv().address);
                              }}
                            >
                              <IconX />
                            </button>
                            <button
                              type="button"
                              class="sym-cta-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJoinServer(srv());
                              }}
                            >
                              <IconPlay />
                              <span>Join</span>
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>
                </div>

                <div class="deck-full-grid">
                  <For each={quickServers().slice(2, 6)}>
                    {(srv) => {
                      const ping = () => serverPings()[srv.address];
                      return (
                        <div class="sym-sub-tile tile--server">
                          <div class="sym-sub-left">
                            <div class="sym-sub-thumb">
                              <Show when={ping()?.favicon || srv.favicon} fallback={<IconServer />}>
                                {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                              </Show>
                            </div>
                            <div class="sym-sub-meta">
                              <div class="sym-tags">
                                <Show when={ping()?.ping_ms != null}>
                                  <span class="ping-badge">{ping()!.ping_ms}ms</span>
                                </Show>
                                <Show when={formatServerVersion(ping()?.version_name || srv.last_ping_version, ping()?.motd || srv.last_ping_motd)}>
                                  {(ver) => (
                                    <span class="sym-tag sym-tag-version">
                                      MC {ver()}
                                    </span>
                                  )}
                                </Show>
                              </div>
                              <div class="sym-sub-name">{srv.name}</div>
                              <div class="sym-sub-sub">
                                {srv.name.toLowerCase() !== srv.address.toLowerCase() ? `${srv.address} · ` : ""}
                                <Show
                                  when={ping()?.players_online != null}
                                  fallback={<span>Multiplayer Server</span>}
                                >
                                  <span style="color: #34d399; font-weight: 600;">● {ping()!.players_online?.toLocaleString()}</span>
                                  <span> Online</span>
                                </Show>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            class="sym-sub-delete-btn tip-right"
                            data-tip="Remove"
                            aria-label={`Remove ${srv.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveServer(srv.address);
                            }}
                          >
                            <IconX />
                          </button>
                          <button
                            type="button"
                            class="sym-sub-btn"
                            aria-label={`Join ${srv.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleJoinServer(srv);
                            }}
                          >
                            <IconPlay />
                          </button>
                        </div>
                      );
                    }}
                  </For>

                  {/* Empty slots if fewer than 6 servers */}
                  <For each={Array.from({ length: Math.max(0, 4 - Math.max(0, quickServers().length - 2)) })}>
                    {() => (
                      <div
                        class="sym-sub-tile"
                        style="opacity: 0.6;"
                        data-tip="Use the input below to add servers"
                      >
                        <div class="sym-sub-left">
                          <div class="sym-sub-thumb"><IconPlus /></div>
                          <div class="sym-sub-meta">
                            <div class="sym-sub-name">Empty Server Slot</div>
                            <div class="sym-sub-sub">Add server in footer</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* BALANCED FOOTER BAR (Quick Join Server Routing & Direct Connect) */}
            <div class="dispatch-footer-bar">
              <div class="dispatch-footer-left">
                <span class="dispatch-deck-hint">
                  <IconServer />
                  <span>Quick Join Deck ({quickServers().length}/6)</span>
                </span>
              </div>

              <div class="dispatch-footer-right">
                <button
                  type="button"
                  class="server-config-btn tip-below tip-left"
                  data-tip="Server settings"
                  aria-label="Server settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    openServerRoutingModal();
                  }}
                >
                  <IconSettings />
                </button>

                <div class="direct-connect-inline">
                  <span class="direct-icon tip-below tip-left" data-tip="Add Server IP">
                    <IconServer />
                  </span>
                  <input
                    type="text"
                    class="direct-input"
                    placeholder={
                      quickServers().length >= 6
                        ? "Quick Join deck full (6/6 servers)"
                        : "Add Server IP..."
                    }
                    disabled={quickServers().length >= 6}
                    value={newServerAddress()}
                    onInput={(e) => setNewServerAddress(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && quickServers().length < 6) handleAddServer();
                    }}
                  />
                  <button
                    type="button"
                    class="direct-btn"
                    disabled={quickServers().length >= 6}
                    data-tip={quickServers().length >= 6 ? "Deck full (6/6)" : "Add Server IP"}
                    onClick={handleAddServer}
                  >
                    <IconPlus />
                    <span>Add</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ BENTO ROW 2: MOJANG NEWS DISPATCH GALLERY ═══ */}
      <div class="news-toolbar-header">
        <div class="news-header-title">
          <IconGlobe />
          <span>Minecraft: Java Edition News</span>
          <span
            class="bento-badge"
            style="color: #10b981; border-color: rgba(16, 185, 129, 0.3); margin-left: 6px;"
          >
            <IconShieldCheck />
            OFFICIAL FEED
          </span>
        </div>

        <div class="news-filters-row">
          <button
            type="button"
            class={`news-filter-pill ${newsFilter() === "all" ? "active" : ""}`}
            onClick={() => setNewsFilter("all")}
          >
            All Feeds
          </button>
          <button
            type="button"
            class={`news-filter-pill ${newsFilter() === "releases" ? "active" : ""}`}
            onClick={() => setNewsFilter("releases")}
          >
            Releases
          </button>
          <button
            type="button"
            class={`news-filter-pill ${newsFilter() === "snapshots" ? "active" : ""}`}
            onClick={() => setNewsFilter("snapshots")}
          >
            Snapshots
          </button>
          <button
            type="button"
            class={`news-filter-pill ${newsFilter() === "articles" ? "active" : ""}`}
            onClick={() => setNewsFilter("articles")}
          >
            Articles
          </button>
        </div>
      </div>

      <Show
        when={news() && news()!.length > 0}
        fallback={
          <div style="color:var(--muted);font-size:12px;padding:14px;background:var(--surface-panel);border:1px solid var(--border)">
            Loading news...
          </div>
        }
      >
        <div class="news-grid" ref={newsPageSize.setEl}>
          <For each={visibleNews()}>
            {(article) => {
              const category = getNewsCategory(article);
              return (
                <div class="news-card" onClick={() => openArticle(article)}>
                  <div class="news-card-thumb-wrap">
                    <img src={article.image_url} alt="" draggable={false} />
                    <span class={`news-card-tag ${category.tagClass}`}>
                      {category.label}
                    </span>
                  </div>
                  <div class="news-card-body">
                    <div class="news-card-title">{article.title}</div>
                    <div class="news-card-meta">
                      <div class="news-card-meta-left">
                        <Show when={formatArticleDate(article.date)}>
                          <span class="news-card-date">{formatArticleDate(article.date)}</span>
                        </Show>
                      </div>
                      <span class="news-card-read">
                        Read
                        <IconExternalLink />
                      </span>
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* News Detail Modal */}
      <Show when={selectedArticle()}>
        <div class="news-modal-overlay" onClick={() => setSelectedArticle(null)}>
          <div class="news-modal" onClick={(e) => e.stopPropagation()}>
            {/* Hero banner with blurred backdrop */}
            <Show
              when={selectedArticle()!.image_url}
              fallback={
                <div style="display:flex;align-items:center;padding:12px 14px 0">
                  <span class={`news-card-tag ${getNewsCategory(selectedArticle()!).tagClass}`} style="position:static">
                    {getNewsCategory(selectedArticle()!).label}
                  </span>
                </div>
              }
            >
              <div class="news-modal-hero">
                <div
                  class="news-modal-hero-bg"
                  style={`background-image:url(${selectedArticle()!.image_url})`}
                />
                <img
                  class="news-modal-hero-img"
                  src={selectedArticle()!.image_url}
                  alt=""
                  draggable={false}
                />
                <span class={`news-card-tag ${getNewsCategory(selectedArticle()!).tagClass}`}>
                  {getNewsCategory(selectedArticle()!).label}
                </span>
              </div>
            </Show>

            {/* Modal Header */}
            <div class="news-modal-header">
              <h2 class="news-modal-title">{selectedArticle()!.title}</h2>
              <Show when={formatArticleDate(selectedArticle()!.date)}>
                <div class="news-modal-badges">
                  <span class="news-card-date">
                    {formatArticleDate(selectedArticle()!.date)}
                  </span>
                </div>
              </Show>
            </div>

            {/* Modal Body */}
            <div class="news-modal-body" onClick={handleModalClick}>
              <Show
                when={selectedArticle()!.body}
                fallback={
                  <p>{selectedArticle()!.excerpt || "Read the full article on minecraft.net."}</p>
                }
              >
                <div
                  innerHTML={
                    articleBody() ||
                    (loadingArticle()
                      ? "<p style='color:var(--muted)'>Loading article...</p>"
                      : "<p style='color:var(--muted)'>No content available.</p>")
                  }
                />
              </Show>
            </div>

            {/* Modal Footer */}
            <div class="news-modal-footer">
              <Show
                when={selectedArticle()!.url}
                fallback={<div />}
              >
                <button
                  type="button"
                  class="btn btn--subtle btn--sm"
                  onClick={() => openUrl(selectedArticle()!.url)}
                >
                  <IconExternalLink />
                  <span>Read on minecraft.net</span>
                </button>
              </Show>
              <button
                type="button"
                class="btn btn--primary btn--sm"
                onClick={() => setSelectedArticle(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Home;
