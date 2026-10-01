// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { createSignal } from "solid-js";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { cancelInstall } from "../ipc/commands";

export interface ActiveInstallState {
  active: boolean;
  title: string;
  message: string;
  fraction: number;
  done: boolean;
  cancelling: boolean;
}

interface ProgressEvent {
  section: string;
  title: string;
  message: string;
  fraction: number;
  skipped: boolean;
}

const [activeInstall, setActiveInstall] = createSignal<ActiveInstallState>({
  active: false,
  title: "",
  message: "",
  fraction: 0,
  done: false,
  cancelling: false,
});

export { activeInstall, setActiveInstall };

export function resetActiveInstall() {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = undefined;
  }
  if (activityTimeout) {
    clearTimeout(activityTimeout);
    activityTimeout = undefined;
  }
  if (pendingMessageTimer) {
    clearTimeout(pendingMessageTimer);
    pendingMessageTimer = undefined;
  }
  suppressUntil = 0;
  phaseLatchUntil = 0;
  installerActive = false;
  lastMessageSetAt = 0;
  setActiveInstall({
    active: false,
    title: "",
    message: "",
    fraction: 0,
    done: false,
    cancelling: false,
  });
}

let hideTimeout: number | undefined;
let activityTimeout: number | undefined;
let suppressUntil = 0;
const SUPPRESS_AFTER_CANCEL_MS = 4000;
let phaseLatchUntil = 0;
const PHASE_LATCH_MS = 2000;
let installerActive = false;

let lastMessageSetAt = 0;
let pendingMessageTimer: number | undefined;
const MESSAGE_THROTTLE_MS = 450;

function setMessageThrottled(text: string, force = false) {
  if (pendingMessageTimer) {
    clearTimeout(pendingMessageTimer);
    pendingMessageTimer = undefined;
  }
  const now = Date.now();
  const elapsed = now - lastMessageSetAt;
  if (force || elapsed >= MESSAGE_THROTTLE_MS) {
    lastMessageSetAt = now;
    setActiveInstall((prev) => ({ ...prev, message: text }));
  } else {
    pendingMessageTimer = window.setTimeout(() => {
      lastMessageSetAt = Date.now();
      setActiveInstall((prev) => ({ ...prev, message: text }));
      pendingMessageTimer = undefined;
    }, MESSAGE_THROTTLE_MS - elapsed);
  }
}

export async function cancelActiveInstall(): Promise<void> {
  setActiveInstall((prev) => ({ ...prev, cancelling: true }));
  setMessageThrottled("Cancelling install...", true);
  try {
    await cancelInstall();
  } catch (e) {
    console.error("Failed to cancel install:", e);
  }
}

let unlistenInstall: Promise<UnlistenFn> | null = null;
let unlistenDownload: Promise<UnlistenFn> | null = null;

export function initInstallProgress(): () => void {
  if (unlistenInstall) return () => {};

  unlistenInstall = listen<ProgressEvent>("install-progress", (event) => {
    const payload = event.payload;

    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = undefined;
    }

    function resetActivityTimeout() {
      if (activityTimeout) clearTimeout(activityTimeout);
      activityTimeout = window.setTimeout(() => {
        setActiveInstall({
          active: false,
          title: "",
          message: "",
          fraction: 0,
          done: false,
          cancelling: false,
        });
      }, 45000);
    }

    if (payload.section === "cancelled") {
      installerActive = false;
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = undefined;
      }
      suppressUntil = Date.now() + SUPPRESS_AFTER_CANCEL_MS;
      setActiveInstall((prev) => ({ ...prev, cancelling: true, done: false }));
      setMessageThrottled("Install cancelled", true);
      hideTimeout = window.setTimeout(() => {
        setActiveInstall({
          active: false,
          title: "",
          message: "",
          fraction: 0,
          done: false,
          cancelling: false,
        });
      }, 1500);
      return;
    }

    if (Date.now() < suppressUntil) return;

    if (payload.section === "done") {
      installerActive = false;
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = undefined;
      }
      setActiveInstall((prev) => ({ ...prev, done: true, fraction: 1 }));
      setMessageThrottled(payload.message || "Ready to play", true);
      hideTimeout = window.setTimeout(() => {
        setActiveInstall({
          active: false,
          title: "",
          message: "",
          fraction: 0,
          done: false,
          cancelling: false,
        });
      }, 2500);
      return;
    }

    if (payload.skipped) return;

    const isNewInstall = payload.title !== activeInstall().title;
    const nextFraction = isNewInstall ? payload.fraction : Math.max(activeInstall().fraction, payload.fraction);
    setActiveInstall((prev) => ({
      ...prev,
      active: true,
      title: payload.title,
      done: false,
      cancelling: false,
      fraction: nextFraction,
    }));
    setMessageThrottled(payload.message);

    if (payload.fraction >= 0.95) {
      installerActive = true;
      phaseLatchUntil = Date.now() + 5000;
    } else {
      installerActive = false;
      phaseLatchUntil = Date.now() + PHASE_LATCH_MS;
    }

    resetActivityTimeout();
  });

  unlistenDownload = listen<{ completed: number; total: number; current_file: string }>(
    "download-progress",
    (event) => {
      const { completed, total } = event.payload;
      if (total > 0 && activeInstall().active && !activeInstall().done) {
        if (activityTimeout) {
          clearTimeout(activityTimeout);
          activityTimeout = window.setTimeout(() => {
            setActiveInstall({
              active: false,
              title: "",
              message: "",
              fraction: 0,
              done: false,
              cancelling: false,
            });
          }, 45000);
        }
        const fileFraction = completed / total;
        setActiveInstall((prev) => ({ ...prev, fraction: fileFraction }));
        if (!installerActive && Date.now() >= phaseLatchUntil) {
          setMessageThrottled(`Downloading files (${completed}/${total})`);
        }
      }
    }
  );

  return () => {
    unlistenInstall?.then((fn) => fn());
    unlistenDownload?.then((fn) => fn());
    unlistenInstall = null;
    unlistenDownload = null;
    if (hideTimeout) clearTimeout(hideTimeout);
    if (activityTimeout) clearTimeout(activityTimeout);
    if (pendingMessageTimer) clearTimeout(pendingMessageTimer);
  };
}
