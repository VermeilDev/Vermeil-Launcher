// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, createSignal } from "solid-js";
import { IconInfo, IconCheck, IconAlertTriangle, IconX, IconRefresh } from "./Icons";

export interface ToastAction {
  /** Visible button label. */
  label: string;
  /** Click handler. The toast auto-dismisses after this fires unless
   *  `keepOpen` is true. */
  onClick: () => void;
  /** When true, clicking the action does NOT dismiss the toast (e.g. a
   *  link opener that should let the user keep reading). */
  keepOpen?: boolean;
}

export type ToastType = "info" | "success" | "warning" | "error" | "loading";

export interface Toast {
  id: string;
  title: string;
  message?: string;
  type: ToastType;
  autoCloseMs?: number;
  /** Optional CTA rendered next to the dismiss button. */
  action?: ToastAction;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

function startTimer(id: string, ms: number) {
  if (activeTimers.has(id)) {
    clearInterval(activeTimers.get(id)!);
    activeTimers.delete(id);
  }
  if (ms <= 0) return;

  let remaining = ms;
  let last = performance.now();
  const interval = setInterval(() => {
    if (document.visibilityState === "visible") {
      remaining -= (performance.now() - last);
      if (remaining <= 0) {
        clearInterval(interval);
        activeTimers.delete(id);
        dismissToast(id);
      }
    }
    last = performance.now();
  }, 250);
  activeTimers.set(id, interval);
}

/** Show a toast notification. Returns the toast ID for manual dismissal or updating. */
export function showToast(toast: Omit<Toast, "id">): string {
  const id = Math.random().toString(36).slice(2);
  const entry: Toast = { ...toast, id };
  setToasts((prev) => [...prev, entry].slice(-5)); // max 5 visible

  const autoClose = toast.autoCloseMs ?? (toast.type === "loading" ? 0 : 5000);
  if (autoClose > 0) {
    startTimer(id, autoClose);
  }
  return id;
}

/** Update an active toast in-place (e.g. transitioning from loading to success or error). */
export function updateToast(id: string, updates: Partial<Omit<Toast, "id">>) {
  setToasts((prev) =>
    prev.map((t) => {
      if (t.id !== id) return t;
      return { ...t, ...updates };
    })
  );

  const autoClose = updates.autoCloseMs !== undefined
    ? updates.autoCloseMs
    : (updates.type && updates.type !== "loading" ? 4000 : 0);

  if (autoClose > 0) {
    startTimer(id, autoClose);
  } else if (updates.autoCloseMs === 0 || updates.type === "loading") {
    if (activeTimers.has(id)) {
      clearInterval(activeTimers.get(id)!);
      activeTimers.delete(id);
    }
  }
}

/** Dismiss a specific toast by ID. */
export function dismissToast(id: string) {
  if (activeTimers.has(id)) {
    clearInterval(activeTimers.get(id)!);
    activeTimers.delete(id);
  }
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

/** Check if a specific toast is currently active in the DOM. */
export function isToastActive(id: string): boolean {
  return toasts().some((t) => t.id === id);
}

const typeIcon = (type: Toast["type"]) => {
  switch (type) {
    case "info":
      return <IconInfo />;
    case "success":
      return <IconCheck />;
    case "warning":
      return <IconAlertTriangle />;
    case "error":
      return <IconX />;
    case "loading":
      return <span class="toast-spinner-icon"><IconRefresh /></span>;
  }
};

const Toasts: Component = () => {
  return (
    <div class="toast-container">
      <For each={toasts()}>
        {(toast) => (
          <div class={`toast-item toast-${toast.type}`}>
            <span class="toast-icon">{typeIcon(toast.type)}</span>
            <div class="toast-body">
              <div class="toast-title">{toast.title}</div>
              {toast.message && <div class="toast-msg">{toast.message}</div>}
            </div>
            {toast.action && (
              <button
                class="toast-action"
                onClick={() => {
                  toast.action!.onClick();
                  if (!toast.action!.keepOpen) dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              class="toast-dismiss tip-right"
              data-tip="Dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              <IconX />
            </button>
          </div>
        )}
      </For>
    </div>
  );
};

export default Toasts;
