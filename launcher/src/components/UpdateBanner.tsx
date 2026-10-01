// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, Show } from "solid-js";
import {
  updateAvailable,
  updateDownloading,
  updateInstalling,
  updateDownloaded,
  updateProgress,
} from "../App";
import { downloadUpdate, applyUpdate, dismissUpdate } from "../services/updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconArrowUpCircle,
  IconDownload,
  IconExternalLink,
  IconRotate,
  IconArrowRight,
} from "./Icons";

const RELEASES_URL = "https://github.com/VermeilDev/Vermeil-Launcher/releases/tag";

const fmtVer = (v?: string) => {
  if (!v) return "";
  return v.startsWith("v") ? v : `v${v}`;
};

/**
 * Auto-update prompt rendered as a centered fixed-position card matching the
 * other top-level overlays (`InstallProgress`, `BulkInstallToast`).
 *
 * State machine:
 *   • idle              → hidden
 *   • update available  → "Vermeil X is available — Download / Later"
 *   • downloading       → progress bar with bytes
 *   • downloaded        → "Ready to install — Restart now / Later"
 *   • installing        → indeterminate spinner ("Installing... app will close")
 *
 * The "installing" phase is intentionally indeterminate. NSIS does not emit
 * progress callbacks during file-replace, and the install runs in our
 * `RunEvent::Exit` handler after the window is gone — which means by the
 * time install actually starts, this UI is no longer rendered. We keep the
 * indeterminate spinner up between the user clicking "Restart" and the
 * window closing so they have visible feedback that something is happening.
 */
const UpdateBanner: Component = () => {
  const visible = () => updateAvailable() !== null;

  const phaseLabel = () => {
    if (updateInstalling()) return "Installing update...";
    if (updateDownloaded()) return "Ready to install";
    if (updateDownloading()) {
      return `Downloading — ${Math.round(updateProgress() * 100)}%`;
    }
    return `Vermeil ${updateAvailable()?.version} is available`;
  };

  return (
    <Show when={visible()}>
      <div class="update-banner">
        <div class="update-banner-header">
          <div class="update-banner-icon">
            <IconArrowUpCircle />
          </div>
          <div class="update-banner-title">{phaseLabel()}</div>
        </div>

        <div class="update-banner-body">
          <Show when={!updateDownloading() && !updateDownloaded() && !updateInstalling()}>
            <div class="update-banner-version-row">
              <span class="update-version-badge update-version-badge--old">
                {fmtVer(updateAvailable()?.currentVersion)}
              </span>
              <span class="update-version-arrow">
                <IconArrowRight />
              </span>
              <span class="update-version-badge update-version-badge--new">
                {fmtVer(updateAvailable()?.version)}
              </span>
            </div>
            <div class="update-banner-actions">
              <button
                class="btn btn--primary btn--sm"
                onClick={() => downloadUpdate().catch((e) => console.error(e))}
              >
                <IconDownload />
                <span>Download</span>
              </button>
              <button
                class="btn btn--subtle btn--sm"
                onClick={() =>
                  openUrl(`${RELEASES_URL}/${fmtVer(updateAvailable()?.version)}`).catch(() => {})
                }
              >
                <IconExternalLink />
                <span>Release notes</span>
              </button>
              <button class="btn btn--subtle btn--sm" onClick={() => dismissUpdate()}>
                Later
              </button>
            </div>
          </Show>

          <Show when={updateDownloading()}>
            <div class="update-banner-bar-track">
              <div
                class="update-banner-bar-fill"
                style={{ width: `${Math.min(updateProgress() * 100, 100)}%` }}
              />
            </div>
          </Show>

          <Show when={updateDownloaded() && !updateInstalling()}>
            <div class="update-banner-meta">
              Vermeil will close, install the update, and reopen on the new version.
            </div>
            <div class="update-banner-actions">
              <button
                class="btn btn--primary btn--sm"
                onClick={() => applyUpdate().catch((e) => console.error(e))}
              >
                <IconRotate />
                <span>Restart and install</span>
              </button>
              <button class="btn btn--subtle btn--sm" onClick={() => dismissUpdate()}>
                Later
              </button>
            </div>
          </Show>

          <Show when={updateInstalling()}>
            <div class="update-banner-installing">
              <div class="update-banner-spinner" />
              <span class="update-banner-meta">
                Closing Vermeil and applying the update — the app will reopen automatically.
              </span>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default UpdateBanner;
