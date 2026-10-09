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
import TactileSwitch from "../components/TactileSwitch";
import {
  IconBolt,
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
 * Aligned with the canonical Tactile Bento ModDetailModal design system.
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

  const handleToggle = async (nextChecked?: boolean) => {
    if (toggling()) return;
    setToggling(true);
    const next = typeof nextChecked === "boolean" ? nextChecked : !(props.companionEnabled ?? true);
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
      <div class="modal-overlay mod-detail-overlay" onClick={props.onClose}>
        <div
          class="modal mod-detail-modal panel panel--bracketed"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="modal-header mod-detail-header">
            <div class="mod-detail-identity">
              <div class="mod-detail-icon">
                <img src="/logo.png" alt="" draggable={false} class="mod-detail-icon-img" />
              </div>
              <div class="mod-detail-names">
                <div class="mod-detail-title-row">
                  <span class="modal-title mod-detail-title">Vermeil Companion Mod</span>
                  <span
                    class="mod-source-badge"
                    style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.4); color: var(--accent-rim);"
                  >
                    <IconBolt /> Managed
                  </span>
                </div>
                <span class="mod-detail-author">
                  Custom client companion mod by <strong>Vermeil</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Body */}
          <div class="modal-body mod-detail-body">
            {/* Recessed description plate */}
            <p class="mod-detail-summary">
              Enables custom in-game capes, dynamic camera FOV tuning, cosmetic synchronization, and native client integrations without third-party dependencies.
            </p>

            {/* 4-column metric stats */}
            <div class="mod-detail-stats">
              <div class="mod-detail-stat">
                <span class="mod-detail-stat-label">Features Status</span>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px;">
                  <span
                    class="mod-detail-stat-value"
                    style={{
                      color: (props.companionEnabled ?? true) ? "var(--success)" : "var(--muted)",
                      "font-size": "13px",
                    }}
                  >
                    {(props.companionEnabled ?? true) ? "Active" : "Disabled"}
                  </span>
                  <TactileSwitch
                    checked={props.companionEnabled ?? true}
                    disabled={toggling()}
                    onChange={handleToggle}
                    aria-label={(props.companionEnabled ?? true) ? "Disable companion" : "Enable companion"}
                    tip={(props.companionEnabled ?? true) ? "Disable companion" : "Enable companion"}
                  />
                </div>
              </div>

              <div class="mod-detail-stat">
                <span class="mod-detail-stat-label">Target Loader</span>
                <div style="margin-top: 2px;">
                  <span class={`badge badge--loader badge--${props.loader}`}>
                    {props.loader.charAt(0).toUpperCase() + props.loader.slice(1)}
                  </span>
                </div>
              </div>

              <div class="mod-detail-stat">
                <span class="mod-detail-stat-label">Game Version</span>
                <div style="margin-top: 2px;">
                  <span class="badge badge--version">{props.gameVersion}</span>
                </div>
              </div>

              <div class="mod-detail-stat">
                <span class="mod-detail-stat-label">Installed Version</span>
                <div style="margin-top: 2px;">
                  <span class="badge badge--vnum">
                    {props.companionVersion ? `v${props.companionVersion}` : "Not installed"}
                  </span>
                </div>
              </div>
            </div>

            {/* Version / Build selector section */}
            <div class="mod-versions-section">
              <div class="mod-versions-header">
                <span class="mod-section-title">Available Companion Builds</span>
                <Show when={!loading() && builds().length > 0}>
                  <span style="font-size: 11px; color: var(--muted); font-family: var(--font-mono);">
                    {builds().length} compatible build{builds().length === 1 ? "" : "s"}
                  </span>
                </Show>
              </div>

              <div class="mod-versions-list">
                <Show when={loading()}>
                  <div class="mod-versions-loading">
                    <div class="spinner-sm" />
                    <span>Fetching companion manifest...</span>
                  </div>
                </Show>

                <Show when={error()}>
                  <div class="mod-versions-error">
                    <span>{error()}</span>
                  </div>
                </Show>

                <Show when={!loading() && !error() && builds().length === 0}>
                  <div class="mod-versions-empty">
                    No compatible companion builds found for Minecraft {props.gameVersion} on {props.loader}.
                  </div>
                </Show>

                <Show when={!loading() && !error() && builds().length > 0}>
                  <For each={builds()}>
                    {(b) => {
                      const isSelected = () => selectedFile() === b.file;
                      return (
                        <div
                          class={`mod-version-row ${isSelected() ? "selected" : ""}`}
                          onClick={() => setSelectedFile(b.file)}
                        >
                          <div class="mod-vrow-left">
                            <div class="mod-vrow-title-row">
                              <span class="mod-vrow-name">v{b.version}</span>
                              <Show when={b.is_active}>
                                <span
                                  class="badge"
                                  style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4);"
                                >
                                  Active on disk
                                </span>
                              </Show>
                            </div>
                            <div class="mod-vrow-meta">
                              <span class="mod-vrow-mc">MC {props.gameVersion}</span>
                              <span class="mod-vrow-sep">·</span>
                              <span class="mod-vrow-loaders">{b.loaders.join(", ")}</span>
                              <span class="mod-vrow-sep">·</span>
                              <span class="mod-vrow-size">{formatSize(b.size)}</span>
                            </div>
                          </div>
                          <span style="font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); flex-shrink: 0;">
                            {b.file}
                          </span>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div class="modal-footer mod-detail-footer">
            <div class="mod-footer-left">
              <Show when={selectedBuild()}>
                <span class="mod-selected-indicator">
                  Selected: <strong>v{selectedBuild()!.version}</strong>
                  <Show when={selectedBuild()!.is_active}>
                    <span
                      class="badge"
                      style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10px; padding: 1px 5px;"
                    >
                      Active
                    </span>
                  </Show>
                </span>
              </Show>
            </div>
            <div class="mod-footer-actions">
              <button
                type="button"
                class="btn mod-footer-close-btn"
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
      </div>
    </Show>
  );
};

export default CompanionDetailModal;
