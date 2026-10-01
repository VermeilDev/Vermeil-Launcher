// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, Show, For, onMount } from "solid-js";
import { instances, showToast, refreshPinnedInstanceIds, currentTheme } from "../App";
import { getSettings, saveSettings } from "../ipc/commands";
import { IconCheck, IconSearch } from "../components/Icons";
import { resolveAssetUrl } from "../lib/assets";

/**
 * Dock pin manager. Lets the user pick up to 6 instances to surface as
 * quick-launch icons in the floating dock.
 *
 * Mounted at App level. Open via the exported `openPinInstancesModal()` helper.
 */
export const MAX_PINS = 6;

const [open, setOpen] = createSignal(false);
const [pinned, setPinned] = createSignal<string[]>([]);

/** Open the picker. Loads the current pin list from settings on every open
 *  so the modal always reflects what's actually saved. Filters out any IDs
 *  pointing at instances that no longer exist. */
export function openPinInstancesModal() {
  getSettings()
    .then((s) => {
      const live = new Set((instances() ?? []).map((i) => i.id));
      const realPins = (s.sidebar_pinned_instances ?? []).filter((id) => live.has(id));
      setPinned(realPins);
      setOpen(true);
    })
    .catch((e) => {
      showToast({ title: "Couldn't open pin manager", message: String(e), type: "error" });
    });
}

/** Read by App.tsx to know whether to render the modal at all. */
export const pinInstancesModalOpen = open;

/** Close the pin modal without saving. Used by the global Escape handler. */
export function closePinInstancesModal() {
  setOpen(false);
}

const PinInstancesModal: Component = () => {
  const [saving, setSaving] = createSignal(false);
  const [search, setSearch] = createSignal("");

  onMount(() => {
    if (open() && pinned().length === 0) {
      getSettings().then((s) => setPinned(s.sidebar_pinned_instances ?? [])).catch(() => {});
    }
  });

  const allInstances = () => instances() ?? [];
  const filteredInstances = () => {
    const q = search().trim().toLowerCase();
    const all = allInstances();
    if (!q) return all;
    return all.filter((inst) =>
      inst.name.toLowerCase().includes(q) ||
      inst.game_version.toLowerCase().includes(q) ||
      inst.loader.type.toLowerCase().includes(q)
    );
  };

  const toggle = (id: string) => {
    const current = pinned();
    if (current.includes(id)) {
      setPinned(current.filter((p) => p !== id));
      return;
    }
    if (current.length >= MAX_PINS) {
      showToast({
        title: `${MAX_PINS}-pin limit`,
        message: "Unpin one of the existing pins to add a different instance.",
        type: "info",
        autoCloseMs: 3000,
      });
      return;
    }
    setPinned([...current, id]);
  };

  const close = () => {
    setOpen(false);
    setSearch("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const s = await getSettings();
      s.theme = currentTheme();
      s.sidebar_pinned_instances = pinned();
      await saveSettings(s);
      await refreshPinnedInstanceIds();
      setOpen(false);
      setSearch("");
    } catch (e) {
      showToast({ title: "Couldn't save pins", message: String(e), type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show when={open()}>
      <div class="modal-overlay" onClick={close}>
        <div class="modal pin-instances-modal panel panel--bracketed" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-general">QUICK LAUNCH</span>
              <span class="modal-title">Manage Pinned Instances</span>
            </div>
          </div>
          <div class="modal-body">
            <div class="pin-instances-help">
              Pin up to {MAX_PINS} favorite instances to the floating dock for quick launching from anywhere in the launcher.
            </div>

            <Show when={allInstances().length > 0}>
              <div class="pin-instances-search-bar">
                <IconSearch />
                <input
                  type="text"
                  class="pin-instances-search-input"
                  placeholder="Search instances by name, version, or loader..."
                  value={search()}
                  onInput={(e) => setSearch(e.currentTarget.value)}
                />
              </div>
            </Show>

            <Show
              when={allInstances().length > 0}
              fallback={
                <div class="pin-instances-empty">
                  No instances yet. Create one from the Library to pin it here.
                </div>
              }
            >
              <Show
                when={filteredInstances().length > 0}
                fallback={
                  <div class="pin-instances-empty">
                    No instances match "{search()}".
                  </div>
                }
              >
                <div class="pin-instances-list">
                  <For each={filteredInstances()}>
                    {(inst) => {
                      const checked = () => pinned().includes(inst.id);
                      return (
                        <div
                          class={`pin-instance-card ${checked() ? "checked" : ""}`}
                          onClick={() => toggle(inst.id)}
                        >
                          <div class={`pin-instance-check ${checked() ? "checked" : ""}`}>
                            <Show when={checked()}>
                              <IconCheck />
                            </Show>
                          </div>
                          <div class="pin-instance-icon">
                            <Show when={resolveAssetUrl(inst.icon)} fallback={
                              <div class="pin-instance-icon-placeholder">
                                {inst.name.trim().charAt(0).toUpperCase() || "?"}
                              </div>
                            }>
                              <img
                                src={resolveAssetUrl(inst.icon)!}
                                alt=""
                                draggable={false}
                                onError={(e) => {
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                            </Show>
                          </div>
                          <div class="pin-instance-info">
                            <span class="pin-instance-name">{inst.name}</span>
                            <div class="pin-instance-meta">
                              <span class="pin-badge pin-badge-version">{inst.game_version}</span>
                              <span class={`pin-badge pin-badge-loader pin-badge-loader-${inst.loader.type}`}>
                                {inst.loader.type}
                              </span>
                              <span class="pin-badge pin-badge-ram">{inst.java.memory_max_mb} MB</span>
                              <Show when={inst.mod_count > 0}>
                                <span class="pin-badge pin-badge-mods">{inst.mod_count} mods</span>
                              </Show>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </div>

          <div class="modal-footer">
            <div class="pin-instances-footer">
              <span class={`pin-instances-counter ${pinned().length >= MAX_PINS ? "full" : ""}`}>
                {pinned().length} / {MAX_PINS} slots used
              </span>
              <div style="display: flex; align-items: center; gap: 8px;">
                <button class="btn btn--subtle" onClick={close}>Cancel</button>
                <button class="btn btn--primary" onClick={save} disabled={saving()}>
                  <IconCheck />
                  <span>{saving() ? "Saving..." : "Save Pins"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default PinInstancesModal;
