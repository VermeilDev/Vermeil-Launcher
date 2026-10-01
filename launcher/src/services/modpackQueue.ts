// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { createSignal } from "solid-js";
import {
  trackDownload,
  completeDownload,
  failDownload,
  refetchInstances,
  refreshPinnedInstanceIds,
  downloads,
} from "../App";
import { resetActiveInstall, setActiveInstall } from "./installProgress";

export interface QueuedInstallTask {
  id: string; // dlId from trackDownload
  title: string;
  projectId: string;
  category: string;
  instanceId?: string;
  isOrchestrator?: boolean;
  meta?: {
    iconUrl?: string | null;
    loader?: string;
    gameVersion?: string;
    versionNumber?: string | null;
    author?: string | null;
  };
  execute: (dlId: string) => Promise<any>;
}

// Backwards-compatible alias for existing imports
export type QueuedModpackTask = QueuedInstallTask;

const [activeInstallTask, setActiveInstallTask] = createSignal<QueuedInstallTask | null>(null);
const [queuedInstallTasks, setQueuedInstallTasks] = createSignal<QueuedInstallTask[]>([]);

// Backwards-compatible aliases
export const activeModpackTask = activeInstallTask;
export const queuedModpackTasks = queuedInstallTasks;
export { activeInstallTask, queuedInstallTasks };

export function isTaskQueuedOrActive(projectId: string, instanceId?: string): boolean {
  const current = activeInstallTask();
  if (current && current.projectId === projectId) {
    if (!instanceId || !current.instanceId || current.instanceId === instanceId) {
      return true;
    }
  }
  return queuedInstallTasks().some((t) => {
    if (t.projectId !== projectId) return false;
    if (!instanceId || !t.instanceId) return true;
    return t.instanceId === instanceId;
  });
}

export function isTaskActive(projectId: string, instanceId?: string): boolean {
  const current = activeInstallTask();
  if (!current || current.projectId !== projectId) return false;
  if (instanceId && current.instanceId && current.instanceId !== instanceId) return false;
  return true;
}

export function isTaskQueued(projectId: string, instanceId?: string): boolean {
  return queuedInstallTasks().some((t) => {
    if (t.projectId !== projectId) return false;
    if (!instanceId || !t.instanceId) return true;
    return t.instanceId === instanceId;
  });
}

// Backwards-compatible aliases
export function isModpackQueuedOrActive(projectId: string): boolean {
  return isTaskQueuedOrActive(projectId);
}

export function isModpackActive(dlId: string): boolean {
  return activeInstallTask()?.id === dlId;
}

export function enqueueInstallTask(
  task: Omit<QueuedInstallTask, "id">,
): string {
  const dlId = trackDownload(task.title, task.category, task.meta);
  const item: QueuedInstallTask = {
    ...task,
    id: dlId,
  };

  setQueuedInstallTasks((prev) => [...prev, item]);
  processQueue();
  return dlId;
}

// Backwards-compatible alias for modpacks (orchestrator installs)
export function enqueueModpack(
  task: Omit<QueuedInstallTask, "id">,
): string {
  return enqueueInstallTask({
    ...task,
    isOrchestrator: true,
  });
}

export function cancelQueuedTask(dlId: string): boolean {
  const list = queuedInstallTasks();
  const idx = list.findIndex((t) => t.id === dlId);
  if (idx !== -1) {
    const item = list[idx];
    setQueuedInstallTasks((prev) => prev.filter((t) => t.id !== dlId));
    failDownload(item.id, "Install cancelled");
    return true;
  }
  return false;
}

// Backwards-compatible alias
export const cancelQueuedModpack = cancelQueuedTask;

let isProcessing = false;

async function processQueue() {
  if (isProcessing || activeInstallTask() !== null) {
    return;
  }

  const queue = queuedInstallTasks();
  if (queue.length === 0) {
    return;
  }

  isProcessing = true;
  const nextTask = queue[0];
  // Pop first item from queued tasks and set as active task
  setQueuedInstallTasks((prev) => prev.slice(1));
  setActiveInstallTask(nextTask);

  if (nextTask.isOrchestrator) {
    // Clear previous installation state completely so progress starts at 0%
    resetActiveInstall();
    setActiveInstall({
      active: true,
      title: nextTask.title,
      message: "Starting installation...",
      fraction: 0,
      done: false,
      cancelling: false,
    });
  }

  try {
    const result = await nextTask.execute(nextTask.id);
    if (nextTask.isOrchestrator) {
      await refetchInstances();
      refreshPinnedInstanceIds().catch(() => {});
      completeDownload(
        nextTask.id,
        result?.name || nextTask.title,
        result?.source_version ?? nextTask.meta?.versionNumber ?? undefined,
        {
          iconUrl: nextTask.meta?.iconUrl || (result?.icon && result.icon !== "cube" ? result.icon : undefined),
          loader: result?.loader?.type || nextTask.meta?.loader,
          gameVersion: result?.game_version || nextTask.meta?.gameVersion,
          author: nextTask.meta?.author,
          instanceId: result?.id,
        },
      );
    } else {
      // In case execute didn't complete it, ensure it's completed
      const dl = downloads().find((d) => d.id === nextTask.id);
      if (dl && dl.status === "downloading") {
        completeDownload(
          nextTask.id,
          result?.name,
          result?.source_version ?? nextTask.meta?.versionNumber ?? undefined,
          {
            iconUrl: nextTask.meta?.iconUrl || (result?.icon && result.icon !== "cube" ? result.icon : undefined),
            loader: result?.loader?.type || nextTask.meta?.loader,
            gameVersion: result?.game_version || nextTask.meta?.gameVersion,
            author: nextTask.meta?.author,
            instanceId: result?.id,
          },
        );
      }
    }
  } catch (e: any) {
    const isCancelled = typeof e === "string" && e.includes("cancelled");
    if (isCancelled) {
      failDownload(nextTask.id, "Install cancelled");
    } else {
      console.error(`${nextTask.isOrchestrator ? "Modpack" : "Content"} install failed:`, e);
      const dl = downloads().find((d) => d.id === nextTask.id);
      if (!dl || dl.status === "downloading") {
        failDownload(nextTask.id, typeof e === "string" ? e : (e?.message || "Installation failed"));
      }
    }
  } finally {
    setActiveInstallTask(null);
    if (nextTask.isOrchestrator) {
      resetActiveInstall();
    }
    isProcessing = false;
    // Automatically advance to the next queued item (FIFO)
    processQueue();
  }
}
