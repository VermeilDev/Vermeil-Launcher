// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  checkForAppUpdates,
  startUpdateDownload,
  applyPendingUpdate,
  clearPendingUpdate,
  getSettings,
  type UpdateMetadata,
} from "../ipc/commands";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";

import {
  setUpdateAvailable,
  setUpdateDownloading,
  setUpdateProgress,
  setUpdateInstalling,
  setUpdateDownloaded,
  showToast,
} from "../App";

/**
 * Auto-updater glue.
 *
 * Checks for updates dynamically routed to the user's selected channel
 * (Stable or Experimental) and delegates downloading / applying to Rust.
 */

let cachedUpdate: UpdateMetadata | null = null;
let unlistenProgress: UnlistenFn | null = null;

interface UpdateProgressPayload {
  phase: "downloading" | "installing" | "done" | "error";
  bytes_done: number;
  bytes_total: number;
  fraction: number;
  message: string;
}

/**
 * Subscribe to update-progress events from the Rust side. Idempotent — calling
 * it twice does not double-subscribe. Caller is responsible for unlistening
 * (we do this when the popup is dismissed).
 */
async function ensureProgressListener() {
  if (unlistenProgress) return;
  unlistenProgress = await listen<UpdateProgressPayload>("update-progress", (e) => {
    const p = e.payload;
    setUpdateProgress(p.fraction);
    if (p.phase === "downloading") {
      setUpdateDownloading(true);
      setUpdateInstalling(false);
    } else if (p.phase === "installing") {
      setUpdateDownloading(false);
      setUpdateInstalling(true);
    } else if (p.phase === "done") {
      setUpdateDownloading(false);
      setUpdateInstalling(false);
      setUpdateDownloaded(true);
    } else if (p.phase === "error") {
      setUpdateDownloading(false);
      setUpdateInstalling(false);
      showToast({
        title: "Update failed",
        message: p.message,
        type: "error",
        autoCloseMs: 8000,
      });
    }
  });
}

/**
 * Poll for an update and surface one in the global update banner if found.
 * This does NOT auto-download; the user always opts in via
 * the UpdateBanner component.
 *
 * @param silent When true, suppresses info toasts when no updates are found.
 * @param allowDowngrades When true, versions different from current are accepted (for channel rollbacks).
 * @param channelOverride Optional channel override ("stable" | "experimental").
 * Returns true when a new update is available, false otherwise.
 */
export async function checkForUpdates(
  silent = false,
  allowDowngrades = false,
  channelOverride?: "stable" | "experimental",
): Promise<boolean> {
  try {
    const settings = await getSettings().catch(() => null);
    let fallbackChannel: "stable" | "experimental" = "stable";
    try {
      const v = await getVersion();
      if (v && (v.includes("-") || v.toLowerCase().includes("exp"))) {
        fallbackChannel = "experimental";
      }
    } catch {
      // ignore
    }
    const channel =
      channelOverride ||
      (settings?.update_channel as "stable" | "experimental") ||
      fallbackChannel;

    const effectiveAllowDowngrades = allowDowngrades || channel === "experimental";
    const update = await checkForAppUpdates(channel, effectiveAllowDowngrades);
    if (!update) {
      if (!silent) {
        showToast({
          title: "Up to date",
          message: `You're running the latest version for the ${channel} channel.`,
          type: "info",
          autoCloseMs: 3000,
        });
      }
      return false;
    }

    // Re-checks (the 5-min interval) shouldn't disrupt the user if we're
    // already showing them this same version. Bail out without touching the
    // banner state — they may be mid-download.
    if (cachedUpdate && cachedUpdate.version === update.version) {
      return true;
    }

    cachedUpdate = update;
    setUpdateAvailable({
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body ?? "",
      date: update.date ?? "",
    });
    return true;
  } catch (e) {
    console.error("Update check failed:", e);
    if (!silent) {
      const raw = typeof e === "string" ? e : (e as Error).message ?? "Unknown error";
      const isBuilding = raw.includes("fallback platforms") || raw.includes("platforms");
      showToast({
        title: isBuilding ? "Update building" : "Update check failed",
        message: isBuilding
          ? "A new release was tagged, but the build for your operating system is still finishing on GitHub. Please check again in a few minutes."
          : raw,
        type: isBuilding ? "info" : "error",
        autoCloseMs: 6000,
      });
    }
    return false;
  }
}

/**
 * Download the previously-detected update into memory. Emits `update-progress`
 * events as it goes; the UI listens via `ensureProgressListener`.
 */
export async function downloadUpdate(): Promise<void> {
  if (!cachedUpdate) {
    throw new Error("No update available — run checkForUpdates first");
  }
  await ensureProgressListener();
  setUpdateDownloading(true);
  setUpdateProgress(0);
  await startUpdateDownload(cachedUpdate.rid);
  setUpdateDownloading(false);
  setUpdateDownloaded(true);
}

/**
 * Apply the buffered update. The Rust side closes the window; install runs
 * at RunEvent::Exit, then the app relaunches.
 */
export async function applyUpdate(): Promise<void> {
  await applyPendingUpdate();
}

/**
 * Drop the buffered update without installing. Used when the user dismisses
 * the "ready to install" prompt.
 */
export async function dismissUpdate(): Promise<void> {
  cachedUpdate = null;
  await clearPendingUpdate();
  setUpdateAvailable(null);
  setUpdateDownloading(false);
  setUpdateDownloaded(false);
  setUpdateInstalling(false);
  setUpdateProgress(0);
  if (unlistenProgress) {
    unlistenProgress();
    unlistenProgress = null;
  }
}
