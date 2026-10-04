// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createMemo, createSignal } from "solid-js";
import {
  downloads,
  clearDownloadHistory,
  failDownload,
  DownloadEntry,
  isBulkInstall,
  bulkBatchSize,
  bulkDone,
  bulkProgress,
  instances,
} from "../App";
import { activeInstall, cancelActiveInstall } from "../services/installProgress";
import { activeInstallTask, queuedInstallTasks, cancelQueuedTask } from "../services/modpackQueue";
import { IconCheck, IconX, IconDownload, IconCoffee } from "../components/Icons";
import { resolveAssetUrl } from "../lib/assets";
import { javaVendorOwner } from "../lib/java";

function getCategoryLabel(category: string): string {
  switch (category) {
    case "instance": return "Instance";
    case "mod": return "Mod";
    case "resourcepack": return "Resource Pack";
    case "shader": return "Shader";
    case "datapack": return "Datapack";
    case "modpack": return "Modpack";
    case "java": return "Java Runtime";
    default: return "Download";
  }
}

const Downloads: Component = () => {
  const activeDownloads = () => downloads().filter(d => d.status === "downloading");
  const history = () => downloads().filter(d => d.status !== "downloading").slice(0, 100);

  // The active orchestrator install (e.g. modpack from installQueue)
  const activeInstallEntry = () => {
    if (!activeInstall().active) return null;
    const task = activeInstallTask();
    if (task) {
      const found = downloads().find((d) => d.id === task.id);
      if (found) return found;
    }
    const list = activeDownloads();
    if (list.length === 0) return null;

    const activeTitle = activeInstall().title.trim().toLowerCase();
    if (activeTitle) {
      const match = list.find((dl) => {
        const dlName = dl.name.trim().toLowerCase();
        return dlName === activeTitle || activeTitle.includes(dlName) || dlName.includes(activeTitle);
      });
      if (match) return match;
    }

    return null;
  };

  // Active content download (when not orchestrated by activeInstall)
  const activeContentItem = () => {
    if (activeInstall().active) return null;
    const task = activeInstallTask();
    if (task && !task.isOrchestrator) {
      const found = downloads().find((d) => d.id === task.id);
      if (found) return found;
    }
    const list = activeDownloads();
    if (list.length === 0) return null;
    return list[list.length - 1];
  };

  const queuedDownloads = () => {
    const qTasks = queuedInstallTasks();
    if (qTasks.length > 0) {
      return qTasks.map((task) => {
        const found = downloads().find((d) => d.id === task.id);
        if (found) return found;
        const synthetic: DownloadEntry = {
          id: task.id,
          name: task.title,
          category: task.category,
          status: "downloading",
          timestamp: Date.now(),
          iconUrl: task.meta?.iconUrl ?? undefined,
          loader: task.meta?.loader,
          gameVersion: task.meta?.gameVersion,
          versionNumber: task.meta?.versionNumber ?? undefined,
          author: task.meta?.author ?? undefined,
        };
        return synthetic;
      });
    }

    const list = activeDownloads();
    if (activeInstall().active) {
      const currentModpack = activeInstallEntry();
      return currentModpack ? list.filter((dl) => dl.id !== currentModpack.id) : list;
    }
    const currentContent = activeContentItem();
    return currentContent ? list.filter((dl) => dl.id !== currentContent.id) : [];
  };

  const QUEUE_LIMIT = 5;
  const [showAllQueued, setShowAllQueued] = createSignal(false);

  const visibleQueuedDownloads = () => {
    const all = queuedDownloads();
    if (showAllQueued() || all.length <= QUEUE_LIMIT) {
      return all;
    }
    return all.slice(0, QUEUE_LIMIT);
  };

  const hiddenQueueCount = () => {
    const total = queuedDownloads().length;
    return total > QUEUE_LIMIT && !showAllQueued() ? total - QUEUE_LIMIT : 0;
  };

  const totalActiveCount = () => {
    const qCount = queuedDownloads().length;
    const hasActive = activeInstall().active || Boolean(activeContentItem());
    return qCount + (hasActive ? 1 : 0);
  };

  const hasAnyActive = () => activeInstall().active || Boolean(activeInstallTask()) || activeDownloads().length > 0;

  const timeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  const activeIcon = () => {
    const entry = activeInstallEntry();
    const instList = instances() ?? [];
    const activeTitle = (entry?.name || activeInstall().title).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (activeTitle.length > 0) {
      const inst = instList.find((i) => {
        const instNorm = i.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        return instNorm.length > 0 && (activeTitle.includes(instNorm) || instNorm.includes(activeTitle));
      });
      if (inst && inst.icon && inst.icon !== "cube") return resolveAssetUrl(inst.icon);
    }
    const url = entry?.iconUrl;
    if (url) {
      if (url.includes("cache\\icons") || url.includes("cache/icons")) return undefined;
      return resolveAssetUrl(url);
    }
    return undefined;
  };

  return (
    <div class="screen-enter">
      {/* ── Section 1: Current Downloads ── */}
      <div class="section-label section-label--row">
        <span>Current Downloads</span>
        <Show when={hasAnyActive()}>
          <span class="badge" style="font-family:var(--font-mono)">
            {totalActiveCount()} active
          </span>
        </Show>
      </div>

      <Show when={hasAnyActive()} fallback={
        <div class="dl-empty-well">
          No active downloads in progress.
        </div>
      }>
        {/* Orchestrator install (modpack, instance prep, loader install) */}
        <Show when={activeInstall().active}>
          <div
            class="dl-active-card"
            classList={{
              "dl-active-done": activeInstall().done,
              "dl-active-cancelling": activeInstall().cancelling,
            }}
          >
            <div class="dl-active-header">
              <div class="dl-active-title-row">
                <div class="dl-active-icon-badge">
                  <Show when={activeInstall().done} fallback={
                    <Show when={activeIcon()} fallback={
                      activeInstallEntry()?.category === "java" ? <IconCoffee /> : <IconDownload />
                    }>
                      <img src={activeIcon()!} alt="" draggable={false} />
                    </Show>
                  }>
                    <IconCheck />
                  </Show>
                </div>
                <div class="dl-active-title-group">
                  <span class="dl-active-name">{activeInstall().title}</span>
                  <Show when={activeInstallEntry()?.author}>
                    <span class="dl-card-author">
                      by {activeInstallEntry()?.category === "java" ? javaVendorOwner(activeInstallEntry()!.author || "") : activeInstallEntry()!.author}
                    </span>
                  </Show>
                  <Show when={activeInstallEntry()?.category}>
                    <span class="badge">{getCategoryLabel(activeInstallEntry()!.category)}</span>
                  </Show>
                  <Show when={activeInstallEntry()?.loader}>
                    <span class={`badge badge--loader badge--${activeInstallEntry()!.loader}`}>
                      {activeInstallEntry()!.loader}
                    </span>
                  </Show>
                  <Show when={activeInstallEntry()?.gameVersion && activeInstallEntry()?.category !== "java"}>
                    <span class="badge badge--version">{activeInstallEntry()!.gameVersion}</span>
                  </Show>
                  <span class="badge">Installing</span>
                </div>
              </div>

              <Show when={!activeInstall().done}>
                <Show
                  when={!activeInstall().cancelling}
                  fallback={<span class="dl-cancelling-tag">Cancelling...</span>}
                >
                  <button
                    class="dl-active-cancel"
                    onClick={cancelActiveInstall}
                  >
                    Cancel
                  </button>
                </Show>
              </Show>
              <Show when={activeInstall().done}>
                <span class="dl-done-tag">Complete</span>
              </Show>
            </div>

            <div class="dl-active-stage-row">
              <span class="dl-active-stage">
                {activeInstall().done
                  ? (activeInstall().message || (activeInstallEntry()?.category === "java" ? "Installed" : "Ready to play"))
                  : activeInstall().message}
              </span>
              <span class="dl-active-pct">
                {activeInstall().done ? "100%" : `${Math.round(activeInstall().fraction * 100)}%`}
              </span>
            </div>

            <div class="install-progress-bar-track">
              <div
                class="install-progress-bar-fill"
                classList={{ done: activeInstall().done }}
                style={{ width: `${Math.min(activeInstall().fraction * 100, 100)}%` }}
              />
            </div>
          </div>
        </Show>

        {/* Content download (single mod, update, bulk mod install) */}
        <Show when={!activeInstall().active && Boolean(activeContentItem())}>
          <div class="dl-active-card">
            <div class="dl-active-header">
              <div class="dl-active-title-row">
                <div class="dl-active-icon-badge">
                  <Show
                    when={activeContentItem()?.iconUrl}
                    fallback={
                      activeContentItem()?.category === "java" ? <IconCoffee /> : <IconDownload />
                    }
                  >
                    <img
                      src={activeContentItem()!.iconUrl!}
                      alt=""
                      draggable={false}
                    />
                  </Show>
                </div>
                <div class="dl-active-title-group">
                  <span class="dl-active-name">
                    {activeContentItem()?.name}
                  </span>
                  <Show when={activeContentItem()?.author}>
                    <span class="dl-card-author">by {activeContentItem()?.author}</span>
                  </Show>
                  <span class="badge">{getCategoryLabel(activeContentItem()?.category || "")}</span>
                  <Show when={activeContentItem()?.loader}>
                    <span class={`badge badge--loader badge--${activeContentItem()!.loader}`}>
                      {activeContentItem()!.loader}
                    </span>
                  </Show>
                  <Show when={activeContentItem()?.gameVersion}>
                    <span class="badge badge--version">{activeContentItem()!.gameVersion}</span>
                  </Show>
                  <Show when={activeContentItem()?.versionNumber}>
                    <span class="badge badge--vnum">
                      {activeContentItem()!.versionNumber}
                    </span>
                  </Show>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0;">
                <Show when={isBulkInstall()}>
                  <span class="badge" style="font-family: var(--font-mono); font-size: var(--fs-xs);">
                    {bulkDone()} / {bulkBatchSize()}
                  </span>
                </Show>
                <span class="badge" style="color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent);">
                  Installing
                </span>
              </div>
            </div>

            <div class="dl-active-stage-row">
              <span class="dl-active-stage">
                {isBulkInstall()
                  ? `Installing ${activeContentItem()?.name} (${bulkDone()} of ${bulkBatchSize()} completed)`
                  : `Downloading and installing ${activeContentItem()?.name}...`}
              </span>
              <Show when={isBulkInstall()}>
                <span class="dl-active-pct">
                  {`${Math.round(bulkProgress() * 100)}%`}
                </span>
              </Show>
            </div>

            <div class="install-progress-bar-track">
              <div
                class="install-progress-bar-fill"
                classList={{ indeterminate: !isBulkInstall() }}
                style={isBulkInstall() ? { width: `${Math.min(bulkProgress() * 100, 100)}%` } : undefined}
              />
            </div>
          </div>
        </Show>

        {/* Queued / other active downloads from downloads() */}
        <Show when={queuedDownloads().length > 0}>
          <div class="dl-queue-section-header">
            <span>Next in queue</span>
            <span class="badge" style="font-family:var(--font-mono)">
              {queuedDownloads().length}
            </span>
            <Show when={queuedDownloads().length > QUEUE_LIMIT}>
              <span class="badge" style="font-size: 10px; margin-left: auto; color: var(--text-muted);">
                {showAllQueued()
                  ? `Showing all ${queuedDownloads().length}`
                  : `Showing ${QUEUE_LIMIT} of ${queuedDownloads().length}`}
              </span>
            </Show>
          </div>
          <div class="dl-queue-list">
            <For each={visibleQueuedDownloads()}>
              {(dl, index) => <ActiveDownloadCard entry={dl} position={index() + 1} />}
            </For>
            <Show when={queuedDownloads().length > QUEUE_LIMIT}>
              <div class="dl-queue-overflow-plate">
                <div class="dl-queue-overflow-info">
                  <Show
                    when={!showAllQueued()}
                    fallback={
                      <span>Showing all {queuedDownloads().length} queued downloads</span>
                    }
                  >
                    <span class="badge dl-queue-overflow-count">
                      +{hiddenQueueCount()}
                    </span>
                    <span>
                      {hiddenQueueCount() === 1
                        ? "1 more download waiting in queue"
                        : `${hiddenQueueCount()} more downloads waiting in queue`}
                    </span>
                  </Show>
                </div>
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => setShowAllQueued(!showAllQueued())}
                >
                  {showAllQueued() ? `Show top ${QUEUE_LIMIT}` : `Show all (${queuedDownloads().length})`}
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      {/* ── Section 2: Download History ── */}
      <div class="section-label section-label--row" style="margin-top: var(--space-5);">
        <span>Download History</span>
        <Show when={history().length > 0}>
          <button class="btn btn--sm" onClick={clearDownloadHistory}>Clear</button>
        </Show>
      </div>

      <Show when={history().length > 0} fallback={
        <div class="dl-empty-well">
          Download history will appear here.
        </div>
      }>
        <div class="dl-grid">
          <For each={history()}>
            {(dl) => <DownloadCard entry={dl} timeAgo={timeAgo} />}
          </For>
        </div>
      </Show>
    </div>
  );
};

/** Card for queued items waiting in the download queue. */
const ActiveDownloadCard: Component<{ entry: DownloadEntry; position?: number }> = (props) => {
  const dl = () => props.entry;

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation();
    const handled = cancelQueuedTask(dl().id);
    if (!handled) {
      failDownload(dl().id, "Install cancelled");
    }
  };

  const matchingInstance = createMemo(() => {
    if (dl().category !== "modpack") return undefined;
    const instList = instances() ?? [];
    if (dl().instanceId) {
      const found = instList.find((i) => i.id === dl().instanceId);
      if (found) return found;
    }
    const dlNorm = dl().name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (dlNorm.length === 0) return undefined;
    return instList.find((i) => {
      const instNorm = i.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return instNorm.length > 0 && (dlNorm.includes(instNorm) || instNorm.includes(dlNorm));
    });
  });

  const cardIcon = () => {
    const inst = matchingInstance();
    if (inst && inst.icon && inst.icon !== "cube") return resolveAssetUrl(inst.icon);
    const url = dl().iconUrl;
    if (url) {
      if (url.includes("cache\\icons") || url.includes("cache/icons")) return undefined;
      return resolveAssetUrl(url);
    }
    return undefined;
  };

  const cardName = () => {
    const inst = matchingInstance();
    return inst?.name || dl().name;
  };

  const cardLoader = () => {
    if (dl().loader && dl().loader !== "modrinth" && dl().loader !== "curseforge") return dl().loader;
    const inst = matchingInstance();
    return inst?.loader?.type ?? dl().loader;
  };

  const cardGameVersion = () => {
    if (dl().gameVersion) return dl().gameVersion;
    const inst = matchingInstance();
    return inst?.game_version;
  };

  const cardVersionNumber = () => {
    if (dl().versionNumber) return dl().versionNumber;
    const inst = matchingInstance();
    return inst?.source_version ?? undefined;
  };

  return (
    <div class="dl-queue-card">
      <div class="dl-queue-main">
        <div class="dl-queue-icon">
          <Show when={cardIcon()} fallback={
            dl().category === "java" ? (
              <span class="dl-queue-icon-fallback" style="display:flex;align-items:center;justify-content:center;color:var(--accent);">
                <IconCoffee />
              </span>
            ) : (
              <span class="dl-queue-icon-fallback">{cardName().charAt(0).toUpperCase()}</span>
            )
          }>
            <img
              src={cardIcon()!}
              alt=""
              draggable={false}
              onError={(e) => {
                const fallback = dl().iconUrl?.startsWith("http") ? dl().iconUrl : undefined;
                if (fallback && e.currentTarget.src !== fallback) {
                  e.currentTarget.src = fallback;
                } else {
                  e.currentTarget.style.display = "none";
                }
              }}
            />
          </Show>
        </div>
        <div class="dl-queue-info">
          <div class="dl-queue-title-row">
            <span class="dl-queue-name">{cardName()}</span>
            <Show when={dl().author}>
              <span class="dl-queue-author">
                by {dl().category === "java" ? javaVendorOwner(dl().author || "") : dl().author}
              </span>
            </Show>
          </div>
          <div class="dl-queue-meta-row">
            <span class="badge">{getCategoryLabel(dl().category)}</span>
            <Show when={cardLoader()}>
              <span class={`badge badge--loader badge--${cardLoader()}`}>{cardLoader()}</span>
            </Show>
            <Show when={cardGameVersion() && dl().category !== "java"}>
              <span class="badge badge--version">{cardGameVersion()}</span>
            </Show>
            <Show when={cardVersionNumber()}>
              <span class="badge badge--vnum">{cardVersionNumber()}</span>
            </Show>
          </div>
        </div>
      </div>

      <div class="dl-queue-actions">
        <span class="dl-queue-badge">
          <span class="dl-queue-badge-dot" />
          {props.position !== undefined ? `Queued #${props.position}` : "In Queue"}
        </span>
        <button
          type="button"
          class="dl-queue-cancel"
          onClick={handleCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/** Individual download history card with icon, metadata pills, and status. */
const DownloadCard: Component<{ entry: DownloadEntry; timeAgo: (ts: number) => string }> = (props) => {
  const dl = () => props.entry;
  const failed = () => dl().status === "failed";

  const matchingInstance = createMemo(() => {
    if (dl().category !== "modpack") return undefined;
    const instList = instances() ?? [];
    if (dl().instanceId) {
      const found = instList.find((i) => i.id === dl().instanceId);
      if (found) return found;
    }
    const dlNorm = dl().name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (dlNorm.length === 0) return undefined;
    return instList.find((i) => {
      const instNorm = i.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return instNorm.length > 0 && (dlNorm.includes(instNorm) || instNorm.includes(dlNorm));
    });
  });

  const cardIcon = () => {
    const inst = matchingInstance();
    if (inst && inst.icon && inst.icon !== "cube") return resolveAssetUrl(inst.icon);
    const url = dl().iconUrl;
    if (url) {
      if (url.includes("cache\\icons") || url.includes("cache/icons")) return undefined;
      return resolveAssetUrl(url);
    }
    return undefined;
  };

  const cardName = () => {
    const inst = matchingInstance();
    return inst?.name || dl().name;
  };

  const cardLoader = () => {
    if (dl().loader && dl().loader !== "modrinth" && dl().loader !== "curseforge") return dl().loader;
    const inst = matchingInstance();
    return inst?.loader?.type ?? dl().loader;
  };

  const cardGameVersion = () => {
    if (dl().gameVersion) return dl().gameVersion;
    const inst = matchingInstance();
    return inst?.game_version;
  };

  const cardVersionNumber = () => {
    if (dl().versionNumber) return dl().versionNumber;
    const inst = matchingInstance();
    return inst?.source_version ?? undefined;
  };

  return (
    <div class="card card--inst dl-card" classList={{ "dl-card-failed": failed() }}>
      <div class="card-body">
        <div class="dl-card-icon">
          <Show when={cardIcon()} fallback={
            dl().category === "java" ? (
              <span class="dl-card-icon-fallback" style="display:flex;align-items:center;justify-content:center;color:var(--accent);">
                <IconCoffee />
              </span>
            ) : (
              <span class="dl-card-icon-fallback">{cardName().charAt(0).toUpperCase()}</span>
            )
          }>
            <img
              src={cardIcon()!}
              alt=""
              draggable={false}
              onError={(e) => {
                const fallback = dl().iconUrl?.startsWith("http") ? dl().iconUrl : undefined;
                if (fallback && e.currentTarget.src !== fallback) {
                  e.currentTarget.src = fallback;
                } else {
                  e.currentTarget.style.display = "none";
                }
              }}
            />
          </Show>
        </div>
        <div class="dl-card-body">
          <div class="dl-card-header">
            <div class="dl-card-title-group">
              <span class="dl-card-name">{cardName()}</span>
              <Show when={dl().author}>
                <span class="dl-card-author">
                  by {dl().category === "java" ? javaVendorOwner(dl().author || "") : dl().author}
                </span>
              </Show>
            </div>
            <span class={`dl-card-status side-icon ${failed() ? "failed" : "success"}`}>
              {failed() ? <IconX /> : <IconCheck />}
            </span>
          </div>
          <div class="dl-card-meta">
            <span class="badge">{getCategoryLabel(dl().category)}</span>
            <Show when={cardLoader()}>
              <span class={`badge badge--loader badge--${cardLoader()}`}>{cardLoader()}</span>
            </Show>
            <Show when={cardGameVersion() && dl().category !== "java"}>
              <span class="badge badge--version">{cardGameVersion()}</span>
            </Show>
            <Show when={cardVersionNumber()}>
              <span class="badge badge--vnum">{cardVersionNumber()}</span>
            </Show>
            <span class="dl-card-time">{props.timeAgo(dl().timestamp)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Downloads;
