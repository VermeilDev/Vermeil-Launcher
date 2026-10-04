// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { instances, showToast } from "../App";
import { quickServers, setQuickServers, serverPings, formatServerVersion } from "../screens/Home";
import { saveQuickServer, removeQuickServer, QuickServerEntry } from "../ipc/commands";
import { IconServer, IconTrash2 } from "../components/Icons";
import { loaderLabel } from "../lib/loader";
import TactileSwitch from "../components/TactileSwitch";

const [open, setOpen] = createSignal(false);

export const serverRoutingModalOpen = open;

export function openServerRoutingModal() {
  setOpen(true);
}

export function closeServerRoutingModal() {
  setOpen(false);
}

const ServerRoutingModal: Component = () => {
  const allInstances = () => instances() ?? [];

  // Close modal on Escape
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        closeServerRoutingModal();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const handleSetInstance = async (server: QuickServerEntry, newInstId: string | null) => {
    const updated: QuickServerEntry = {
      ...server,
      linked_instance_id: newInstId || null,
    };
    try {
      await saveQuickServer(updated);
      setQuickServers((prev) => prev.map((s) => (s.address === server.address ? updated : s)));
      showToast({
        title: "Routing Updated",
        message: newInstId
          ? `Linked ${server.name} to boot with instance automatically.`
          : `Set ${server.name} to prompt for an instance on each launch.`,
        type: "success",
      });
    } catch (err) {
      console.error("Failed to update server routing:", err);
      showToast({ title: "Save Failed", message: String(err), type: "error" });
    }
  };

  const handleToggleRemember = async (server: QuickServerEntry) => {
    const isCurrentlyLinked = Boolean(server.linked_instance_id);
    if (isCurrentlyLinked) {
      // Unlink -> will prompt on each launch
      await handleSetInstance(server, null);
    } else {
      // Link to first available instance (or keep existing if found)
      const insts = allInstances();
      const defaultInstId = insts[0]?.id || null;
      if (!defaultInstId) {
        showToast({
          title: "No Instances",
          message: "Please create a Minecraft instance first to link to this server.",
          type: "warning",
        });
        return;
      }
      await handleSetInstance(server, defaultInstId);
    }
  };

  const handleRemove = async (address: string) => {
    try {
      const updated = await removeQuickServer(address);
      setQuickServers(updated);
      showToast({
        title: "Server Removed",
        message: "Removed server from Quick Join deck.",
        type: "info",
      });
    } catch (err) {
      console.error("Failed to remove server:", err);
      showToast({ title: "Remove Failed", message: String(err), type: "error" });
    }
  };

  return (
    <Show when={open()}>
      <div
        class="modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeServerRoutingModal();
        }}
      >
        <div class="modal server-routing-modal" role="dialog" aria-modal="true">
          {/* Header */}
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-network">SERVER ROUTING</span>
              <div>
                <div class="modal-title">Server Settings</div>
                <div class="modal-subtitle">
                  Configure launch instance and auto-boot behavior
                </div>
              </div>
            </div>
            <span class="badge badge--live">
              {quickServers().length} / 6 SERVERS
            </span>
          </div>

          {/* Body */}
          <div class="modal-body server-routing-body">
            <Show
              when={quickServers().length > 0}
              fallback={
                <div class="empty-state-notice">
                  No servers currently saved in your Quick Join deck. Add a server IP using the bottom input in Dispatch Station.
                </div>
              }
            >
              <div class="server-routing-list">
                <For each={quickServers()}>
                  {(srv) => {
                    const ping = () => serverPings()[srv.address];
                    const isLinked = () => Boolean(srv.linked_instance_id);
                    const linkedInst = () => allInstances().find((i) => i.id === srv.linked_instance_id);

                    return (
                      <div class="server-routing-card">
                        <div class="routing-card-header">
                          <div class="routing-server-info">
                            <div class="routing-server-thumb">
                              <Show when={ping()?.favicon || srv.favicon} fallback={<IconServer />}>
                                {(icon) => <img src={icon()} alt="" draggable={false} decoding="sync" />}
                              </Show>
                            </div>
                            <div class="routing-server-meta">
                              <div class="routing-server-name">{srv.name}</div>
                              <div class="routing-server-address">
                                {srv.address}
                                <Show when={ping()?.ping_ms != null}>
                                  {" "}· <span style="color: #34d399; font-weight: 600;">{ping()!.ping_ms}ms</span>
                                </Show>
                                <Show when={formatServerVersion(ping()?.version_name || srv.last_ping_version, ping()?.motd || srv.last_ping_motd)}>
                                  {(ver) => ` · MC ${ver()}`}
                                </Show>
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            class="routing-delete-btn tip-below tip-left"
                            data-tip="Remove"
                            aria-label={`Remove ${srv.name}`}
                            onClick={() => handleRemove(srv.address)}
                          >
                            <IconTrash2 />
                          </button>
                        </div>

                        {/* Shelf: Instance selector & remember setting */}
                        <div class="routing-shelf">
                          <div class="routing-shelf-row">
                            <span class="routing-shelf-label">Launch Instance:</span>
                            <select
                              class="routing-select"
                              value={srv.linked_instance_id || ""}
                              onChange={(e) => {
                                const val = e.currentTarget.value;
                                handleSetInstance(srv, val || null);
                              }}
                            >
                              <option value="">Prompt every time (Ask before launch)</option>
                              <For each={allInstances()}>
                                {(inst) => (
                                  <option value={inst.id} selected={srv.linked_instance_id === inst.id}>
                                    {inst.name} ({loaderLabel(inst.loader.type)} {inst.game_version})
                                  </option>
                                )}
                              </For>
                            </select>
                          </div>

                          {/* Toggle row */}
                          <div
                            class="routing-toggle-row"
                            style="display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer;"
                            onClick={() => handleToggleRemember(srv)}
                          >
                            <span>
                              {isLinked()
                                ? `Always boots ${linkedInst()?.name ? `"${linkedInst()!.name}"` : "linked instance"} immediately`
                                : "Always asks which instance to launch with"}
                            </span>
                            <TactileSwitch
                              checked={isLinked()}
                              onChange={() => handleToggleRemember(srv)}
                              aria-label="Always boots linked instance immediately"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Footer with clean single-point dismissal */}
          <div class="modal-footer">
            <button
              type="button"
              class="btn btn--primary"
              onClick={closeServerRoutingModal}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ServerRoutingModal;
