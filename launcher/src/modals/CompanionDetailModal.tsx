// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  CompanionBuild,
  getInstanceCompanionBuilds,
  reinstallInstanceCompanion,
  setInstanceCompanionEnabled,
} from "../ipc/commands";
import { formatSize } from "../lib/format";
import { showToast } from "../App";
import {
  IconCheck,
  IconDownload,
  IconRefresh,
  IconReload,
} from "../components/Icons";

interface Props {
  instanceId: string;
  gameVersion: string;
  loader: string;
  companionVersion?: string | null;
  companionEnabled?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

/**
 * Dedicated modal for managing, reinstalling, and switching versions of the
 * Vermeil Companion in-game client mod for a specific instance.
 */
const CompanionDetailModal: Component<Props> = (props) => {
  const [builds, setBuilds] = createSignal<CompanionBuild[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [reinstalling, setReinstalling] = createSignal(false);
  const [toggling, setToggling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);

  // Close on Escape without bubbling
  createEffect(() => {
    if (!props.isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // Fetch available builds when modal opens
  createEffect(() => {
    if (!props.isOpen || !props.instanceId) {
      setBuilds([]);
      setSelectedFile(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    getInstanceCompanionBuilds(props.instanceId)
      .then((res) => {
        setBuilds(res);
        const active = res.find((b) => b.is_active);
        if (active) {
          setSelectedFile(active.file);
        } else if (res.length > 0) {
          setSelectedFile(res[0].file);
        }
      })
      .catch((err) => {
        setError(typeof err === "string" ? err : "Could not load companion builds.");
      })
      .finally(() => {
        setLoading(false);
      });
  });

  const selectedBuild = () => builds().find((b) => b.file === selectedFile());
  const isSelectedActive = () => Boolean(selectedBuild()?.is_active);

  const handleToggle = async () => {
    if (toggling()) return;
    setToggling(true);
    const next = !(props.companionEnabled ?? true);
    try {
      await setInstanceCompanionEnabled(props.instanceId, next);
      await props.onChanged();
      showToast({
        title: next ? "Companion enabled" : "Companion disabled",
        message: next
          ? "Vermeil features will run on next game launch."
          : "Vermeil features disabled for this instance.",
        type: "success",
      });
    } catch (e) {
      showToast({ title: "Update failed", message: String(e), type: "error" });
    } finally {
      setToggling(false);
    }
  };

  const handleReinstallOrSwitch = async () => {
    const file = selectedFile();
    if (!file || reinstalling()) return;

    setReinstalling(true);
    try {
      const installedVer = await reinstallInstanceCompanion(props.instanceId, file);
      await props.onChanged();
      // Refresh build list to update active state
      const refreshed = await getInstanceCompanionBuilds(props.instanceId);
      setBuilds(refreshed);

      showToast({
        title: isSelectedActive() ? "Companion reinstalled" : "Companion updated",
        message: `Successfully installed Vermeil Companion v${installedVer}.`,
        type: "success",
      });
      props.onClose();
    } catch (err) {
      showToast({
        title: "Install failed",
        message: String(err),
        type: "error",
      });
    } finally {
      setReinstalling(false);
    }
  };

  return (
    <Show when={props.isOpen}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div
          class="modal panel panel--bracketed"
          style="max-width: 540px; width: 100%; display: flex; flex-direction: column; gap: 16px; padding: 22px;"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 14px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div class="mod-card-icon mod-card-icon--companion" style="width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: rgba(230, 57, 70, 0.12); border: 1px solid rgba(230, 57, 70, 0.3);">
                <img src="/logo.png" alt="" draggable={false} style="width: 24px; height: 24px;" />
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="modal-title" style="font-size: var(--fs-md); font-weight: 600; color: var(--text);">Vermeil Companion Mod</span>
                  <span class="badge badge--companion" style="font-size: 10px; padding: 2px 6px;">Managed</span>
                </div>
                <div class="modal-subtitle" style="font-size: var(--fs-xs); color: var(--muted); margin-top: 2px;">
                  Custom client companion mod by Vermeil
                </div>
              </div>
            </div>
          </div>

          {/* Instance Context & In-Game Features Card */}
          <div class="card-section-body" style="background: #0f0e13; border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div style="display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); color: var(--text);">
                <span style="color: var(--muted);">Target:</span>
                <span class={`mod-tag mod-tag-loader loader-${props.loader}`}>{props.loader}</span>
                <span class="mod-tag mod-tag-version">{props.gameVersion}</span>
                <Show when={props.companionVersion}>
                  <span class="mod-tag mod-tag-vnum">v{props.companionVersion}</span>
                </Show>
              </div>

              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: var(--fs-xs); color: var(--muted);">
                  {(props.companionEnabled ?? true) ? "Active" : "Disabled"}
                </span>
                <button
                  type="button"
                  class={`btn btn--sm btn--icon btn--toggle ${(props.companionEnabled ?? true) ? "active" : ""}`}
                  disabled={toggling()}
                  onClick={handleToggle}
                  data-tip={(props.companionEnabled ?? true) ? "Disable features" : "Enable features"}
                >
                  <IconCheck />
                </button>
              </div>
            </div>

            <div style="font-size: var(--fs-xs); color: var(--muted); line-height: 1.5; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 10px;">
              Enables custom in-game capes, dynamic camera FOV tuning, cosmetic synchronization, and native client integrations without third-party dependencies.
            </div>
          </div>

          {/* Available Builds Section */}
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);">
                Available Companion Builds
              </span>
              <Show when={!loading() && builds().length > 0}>
                <span style="font-size: 11px; color: var(--muted);">
                  {builds().length} build{builds().length === 1 ? "" : "s"} compatible
                </span>
              </Show>
            </div>

            <Show when={loading()}>
              <div style="padding: 24px; text-align: center; color: var(--muted); font-size: var(--fs-xs); display: flex; align-items: center; justify-content: center; gap: 8px;">
                <span class="spin-icon"><IconReload /></span>
                <span>Fetching companion manifest...</span>
              </div>
            </Show>

            <Show when={error()}>
              <div style="padding: 16px; background: rgba(230, 57, 70, 0.1); border: 1px solid rgba(230, 57, 70, 0.25); border-radius: 8px; color: #ff8080; font-size: var(--fs-xs);">
                {error()}
              </div>
            </Show>

            <Show when={!loading() && !error() && builds().length === 0}>
              <div style="padding: 24px; text-align: center; color: var(--muted); font-size: var(--fs-xs);">
                No published companion builds found for Minecraft {props.gameVersion} on {props.loader}.
              </div>
            </Show>

            <Show when={!loading() && builds().length > 0}>
              <div style="display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; padding-right: 2px;">
                <For each={builds()}>
                  {(b) => {
                    const isSelected = () => selectedFile() === b.file;
                    return (
                      <div
                        class="setting-row"
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          padding: "10px 14px",
                          background: isSelected() ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.02)",
                          border: isSelected() ? "1px solid var(--accent)" : "1px solid var(--border)",
                          "border-radius": "6px",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                        }}
                        onClick={() => setSelectedFile(b.file)}
                      >
                        <div style="display: flex; align-items: center; gap: 10px;">
                          <div style="width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; background: ${isSelected() ? 'var(--accent)' : 'transparent'}">
                            <Show when={isSelected()}>
                              <div style="width: 6px; height: 6px; border-radius: 50%; background: #fff;" />
                            </Show>
                          </div>
                          <div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                              <span style="font-weight: 600; font-size: var(--fs-sm); color: var(--text);">
                                v{b.version}
                              </span>
                              <Show when={b.is_active}>
                                <span class="badge" style="background: rgba(56, 176, 0, 0.18); color: #70e000; font-size: 10px; padding: 1px 5px; border: 1px solid rgba(56, 176, 0, 0.3);">
                                  Active on disk
                                </span>
                              </Show>
                            </div>
                            <div style="font-size: 11px; color: var(--muted); margin-top: 1px;">
                              {b.loaders.join(", ")} · {formatSize(b.size)}
                            </div>
                          </div>
                        </div>

                        <span style="font-size: 11px; font-family: monospace; color: var(--muted);">
                          {b.file}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Modal Footer */}
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px; margin-top: 4px;">
            <button
              type="button"
              class="btn"
              onClick={props.onClose}
              disabled={reinstalling()}
            >
              Close
            </button>
            <button
              type="button"
              class={`btn ${isSelectedActive() ? "btn--secondary" : "btn--primary"}`}
              disabled={reinstalling() || !selectedBuild()}
              onClick={handleReinstallOrSwitch}
            >
              <Show when={!reinstalling()} fallback={
                <>
                  <span class="spin-icon"><IconReload /></span>
                  <span>Installing...</span>
                </>
              }>
                <Show when={isSelectedActive()} fallback={
                  <>
                    <IconDownload />
                    <span>Switch to v{selectedBuild()?.version}</span>
                  </>
                }>
                  <IconRefresh />
                  <span>Reinstall & Verify</span>
                </Show>
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CompanionDetailModal;
