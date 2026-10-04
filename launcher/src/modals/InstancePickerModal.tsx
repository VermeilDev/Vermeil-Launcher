// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { instances, showToast } from "../App";
import { IconPlay, IconGlobe } from "../components/Icons";
import { resolveAssetUrl } from "../lib/assets";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";
import TactileSwitch from "../components/TactileSwitch";

export interface InstancePickerTarget {
  name: string;
  address: string;
  versionRange?: string | null;
  onConfirm?: (instanceId: string, remember: boolean) => void;
}

const [open, setOpen] = createSignal(false);
const [target, setTarget] = createSignal<InstancePickerTarget | null>(null);
const [selectedInstanceId, setSelectedInstanceId] = createSignal<string>("");
const [remember, setRemember] = createSignal<boolean>(true);

/** Open the instance picker modal for a given server target. */
export function openInstancePickerModal(serverTarget: InstancePickerTarget, initialInstanceId?: string | null) {
  setTarget(serverTarget);
  const insts = instances() ?? [];
  if (initialInstanceId && insts.some((i) => i.id === initialInstanceId)) {
    setSelectedInstanceId(initialInstanceId);
  } else if (insts.length > 0) {
    setSelectedInstanceId(insts[0].id);
  } else {
    setSelectedInstanceId("");
  }
  setRemember(true);
  setOpen(true);
}

export const instancePickerModalOpen = open;

export function closeInstancePickerModal() {
  setOpen(false);
}

const InstancePickerModal: Component = () => {
  const allInstances = () => instances() ?? [];

  // Close modal on Escape
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        closeInstancePickerModal();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const handleLaunch = () => {
    const t = target();
    const instId = selectedInstanceId();
    if (!instId) {
      showToast({ title: "No instance selected", message: "Please select an instance to launch with.", type: "warning" });
      return;
    }

    if (t?.onConfirm) {
      t.onConfirm(instId, remember());
    }
    closeInstancePickerModal();
  };

  return (
    <Show when={open()}>
      <div
        class="modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeInstancePickerModal();
        }}
      >
        <div class="modal instance-picker-modal" role="dialog" aria-modal="true">
          {/* Header */}
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-network">SERVER QUICK JOIN</span>
              <div>
                <div class="modal-title">{target()?.name ?? "Direct Quick Join"}</div>
                <div class="modal-subtitle">
                  {target()?.address ?? "mc.hypixel.net"}
                  {target()?.versionRange ? ` · Supports MC ${target()!.versionRange}` : " · Direct Launch"}
                </div>
              </div>
            </div>
            <span class="badge badge--live">DIRECT CONNECT</span>
          </div>

          {/* Body */}
          <div class="modal-body instance-picker-body">
            <div class="picker-section-label">Select Launch Instance</div>

            <Show
              when={allInstances().length > 0}
              fallback={
                <div class="empty-state-notice">
                  No Minecraft instances found in your library. Please create or install an instance first.
                </div>
              }
            >
              <div class="picker-inst-list">
                <For each={allInstances()}>
                  {(inst) => {
                    const isSelected = () => selectedInstanceId() === inst.id;
                    return (
                      <div
                        class={`picker-inst-card ${isSelected() ? "selected" : ""}`}
                        onClick={() => setSelectedInstanceId(inst.id)}
                      >
                        <div class="picker-inst-info">
                          <div class="picker-inst-icon">
                            <Show
                              when={resolveAssetUrl(inst.icon)}
                              fallback={<span class="globe-icon-wrap"><IconGlobe /></span>}
                            >
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
                          <div class="picker-inst-meta">
                            <div class="picker-inst-name">{inst.name}</div>
                            <div class="picker-inst-tags">
                              <span class={`badge badge--loader ${loaderBadgeClass(inst.loader.type)}`}>
                                {loaderLabel(inst.loader.type)}
                              </span>
                              <span class="badge badge--version">{inst.game_version}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Remember Toggle */}
            <div
              class="picker-remember-row"
              style="display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer;"
              onClick={() => setRemember(!remember())}
            >
              <span>Always launch {target()?.name ?? "this server"} with this instance</span>
              <TactileSwitch
                checked={remember()}
                onChange={setRemember}
                aria-label="Remember server instance"
              />
            </div>
          </div>

          {/* Footer with clean single-point dismissal */}
          <div class="modal-footer">
            <button
              type="button"
              class="btn btn--secondary"
              onClick={closeInstancePickerModal}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--primary"
              onClick={handleLaunch}
            >
              <IconPlay />
              <span>Launch &amp; Connect</span>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default InstancePickerModal;
