// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openInstanceFolder } from "../ipc/commands";
import { IconFolderOpen, IconGlobe } from "./Icons";

/**
 * One file the launcher isn't permitted to download. Mirrors the backend
 * `ManualDownload` payload in `services/manual_download.rs`.
 */
interface ManualDownload {
  /** "mod" | "modpack" */
  kind: string;
  title: string;
  file_name: string | null;
  /** CurseForge project page. Null when the lookup failed. */
  url: string | null;
  /** Present when the file belongs in an existing instance. */
  instance_id: string | null;
}

/**
 * Queue lives at module level so entries arriving from separate backend emits
 * collect into one dialog. A modpack import can block several files at once and
 * emits one event each; stacking dialogs would be unusable.
 *
 * Capped because it's fed by events: a pathological pack shouldn't grow the DOM
 * without bound.
 */
const MAX_ENTRIES = 25;
const [entries, setEntries] = createSignal<ManualDownload[]>([]);
const [open, setOpen] = createSignal(false);

const ManualDownloadModal: Component = () => {
  const [copiedFile, setCopiedFile] = createSignal<string | null>(null);

  onMount(() => {
    const unlisten = listen<ManualDownload>("manual-download-required", (event) => {
      const next = event.payload;
      setEntries((prev) => {
        // Same project + file arriving twice (a retry, or a dependency reached by
        // two parents) shouldn't produce a duplicate row.
        if (prev.some((e) => e.title === next.title && e.file_name === next.file_name)) {
          return prev;
        }
        return [...prev, next].slice(-MAX_ENTRIES);
      });
      setOpen(true);
    });
    onCleanup(() => { unlisten.then((fn) => fn()); });
  });

  const close = () => {
    setOpen(false);
    setEntries([]);
  };

  const isPack = () => entries().some((e) => e.kind === "modpack");
  /** First instance id in the queue — every blocked file of one pack shares it. */
  const instanceId = () => entries().find((e) => e.instance_id)?.instance_id ?? null;

  return (
    <Show when={open() && entries().length > 0}>
      <div class="modal-overlay" onClick={close}>
        <div class="modal manual-dl-modal" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-storage">MANUAL DOWNLOAD</span>
              <span class="modal-title">
                {entries().length === 1 ? "Manual Download Needed" : `${entries().length} Manual Downloads Needed`}
              </span>
            </div>
          </div>

          <div class="modal-body manual-dl-body">
            <p class="manual-dl-intro">
              <Show
                when={isPack()}
                fallback={
                  <>
                    The author{entries().length === 1 ? "" : "s"} of the following disabled
                    third-party downloads, so Vermeil can't fetch {entries().length === 1 ? "it" : "them"} for
                    you. Open the page, download the listed file, and drop it into the
                    instance's <strong>mods</strong> folder — Vermeil picks up jars added by
                    hand automatically.
                  </>
                }
              >
                This modpack's author disabled third-party downloads. Download the pack
                from CurseForge, then use <strong>Import</strong> to add it.
              </Show>
            </p>

            <div class="manual-dl-list">
              <For each={entries()}>
                {(entry) => (
                  <div class="manual-dl-item">
                    <div class="manual-dl-item-text">
                      <div class="manual-dl-item-title">{entry.title}</div>
                      <Show when={entry.file_name}>
                        <div class="manual-dl-item-file" data-tip={entry.file_name!}>
                          {entry.file_name}
                        </div>
                      </Show>
                    </div>
                    <div class="manual-dl-item-actions">
                      <Show when={entry.file_name}>
                        {/* The file name is the thing you search for on the page,
                            and it's long enough to be annoying to retype. */}
                        <button
                          class="btn btn--sm"
                          onClick={() => {
                            navigator.clipboard.writeText(entry.file_name!).catch(() => {});
                            setCopiedFile(entry.file_name!);
                            window.setTimeout(() => setCopiedFile(null), 1500);
                          }}
                        >
                          {copiedFile() === entry.file_name ? "Copied" : "Copy name"}
                        </button>
                      </Show>
                      <Show
                        when={entry.url}
                        fallback={<span class="manual-dl-item-nolink">No page found</span>}
                      >
                        <button
                          class="btn btn--sm btn--primary"
                          onClick={() => { openUrl(entry.url!).catch(() => {}); }}
                        >
                          <IconGlobe /> Open page
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="modal-footer">
            <Show when={instanceId()}>
              <button
                class="btn"
                onClick={() => { openInstanceFolder(instanceId()!, "mods").catch(() => {}); }}
              >
                <IconFolderOpen /> Open mods folder
              </button>
            </Show>
            <button class="btn btn--subtle" onClick={close}>Got it</button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ManualDownloadModal;
