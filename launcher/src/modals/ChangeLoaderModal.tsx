// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createResource, createEffect, createMemo, Show, For, onCleanup } from "solid-js";
import { instances, refetchInstances, showToast, gameRunning } from "../App";
import {
  getFabricLoaderVersions,
  getFabricGameVersions,
  getQuiltLoaderVersions,
  getQuiltGameVersions,
  getNeoforgeVersions,
  getNeoforgeGameVersions,
  getForgeVersions,
  getForgeGameVersions,
  changeInstanceLoader,
  syncInstanceMods,
  FabricVersion,
} from "../ipc/commands";
import { loaderLabel } from "../lib/loader";
import {
  IconCube,
  IconLayers,
  IconBolt,
  IconWand,
  IconPuzzle,
  IconAlertTriangle,
  IconChevronDown,
} from "../components/Icons";

interface LoaderInfo {
  id: string;
  name: string;
  desc: string;
  tag: string;
  colorClass: string;
  icon: () => any;
}

const LOADER_INFOS: LoaderInfo[] = [
  {
    id: "vanilla",
    name: "Vanilla",
    desc: "Clean official game without modding framework",
    tag: "Official",
    colorClass: "green",
    icon: () => <IconCube />,
  },
  {
    id: "fabric",
    name: "Fabric",
    desc: "Lightweight, modular, and fast modern mod loader",
    tag: "Popular",
    colorClass: "fabric",
    icon: () => <IconLayers />,
  },
  {
    id: "neoforge",
    name: "NeoForge",
    desc: "Modern community successor to Forge for 1.20.2+",
    tag: "Modern",
    colorClass: "purple",
    icon: () => <IconBolt />,
  },
  {
    id: "forge",
    name: "Forge",
    desc: "Classic heavyweight modding framework",
    tag: "Classic",
    colorClass: "orange",
    icon: () => <IconWand />,
  },
  {
    id: "quilt",
    name: "Quilt",
    desc: "Community fork of Fabric with wide compatibility",
    tag: "Modular",
    colorClass: "quilt",
    icon: () => <IconPuzzle />,
  },
];

const [open, setOpen] = createSignal(false);
const [targetInstanceId, setTargetInstanceId] = createSignal<string | null>(null);

export function openChangeLoaderModal(instanceId: string) {
  setTargetInstanceId(instanceId);
  setOpen(true);
}

export function closeChangeLoaderModal() {
  setOpen(false);
}

export const changeLoaderModalOpen = open;

const ChangeLoaderModal: Component = () => {
  const inst = createMemo(() => {
    const id = targetInstanceId();
    if (!id) return null;
    return (instances() || []).find((i) => i.id === id) || null;
  });

  const [selectedLoader, setSelectedLoader] = createSignal<string>("vanilla");
  const [selectedVersion, setSelectedVersion] = createSignal<string | null>(null);
  const [disableMods, setDisableMods] = createSignal(true);
  const [changing, setChanging] = createSignal(false);
  const [versionDropOpen, setVersionDropOpen] = createSignal(false);

  // Supported MC game versions per loader
  const [fabricGameVersions] = createResource(getFabricGameVersions);
  const [quiltGameVersions] = createResource(getQuiltGameVersions);
  const [neoforgeGameVersions] = createResource(getNeoforgeGameVersions);
  const [forgeGameVersions] = createResource(getForgeGameVersions);

  // Loader versions per loader for this instance's game version
  const [fabricVersions] = createResource(getFabricLoaderVersions);
  const [quiltVersions] = createResource(getQuiltLoaderVersions);
  const [neoforgeVersions] = createResource(
    () => (selectedLoader() === "neoforge" ? inst()?.game_version : null),
    (gv) => (gv ? getNeoforgeVersions(gv) : Promise.resolve([]))
  );
  const [forgeVersions] = createResource(
    () => (selectedLoader() === "forge" ? inst()?.game_version : null),
    (gv) => (gv ? getForgeVersions(gv) : Promise.resolve([]))
  );

  // Initialize state whenever modal opens or instance changes
  createEffect(() => {
    if (!open()) return;
    const current = inst();
    if (current) {
      setSelectedLoader(current.loader.type);
      setSelectedVersion(current.loader.version || null);
      setDisableMods(true);
      setVersionDropOpen(false);
    }
  });

  // Check if loader supports instance's game_version
  const isLoaderCompatible = (loaderId: string): boolean => {
    const gv = inst()?.game_version;
    if (!gv) return true;
    if (loaderId === "vanilla") return true;
    if (loaderId === "fabric") {
      const list = fabricGameVersions();
      return !list || list.length === 0 || list.includes(gv);
    }
    if (loaderId === "quilt") {
      const list = quiltGameVersions();
      return !list || list.length === 0 || list.includes(gv);
    }
    if (loaderId === "neoforge") {
      const list = neoforgeGameVersions();
      return !!list && list.includes(gv);
    }
    if (loaderId === "forge") {
      const list = forgeGameVersions();
      return !list || list.length === 0 || list.includes(gv);
    }
    return true;
  };

  // Available loader versions for the currently selected loader
  const availableLoaderVersions = createMemo((): FabricVersion[] => {
    const l = selectedLoader();
    if (l === "fabric") return fabricVersions() || [];
    if (l === "quilt") return quiltVersions() || [];
    if (l === "neoforge") return neoforgeVersions() || [];
    if (l === "forge") return forgeVersions() || [];
    return [];
  });

  const isVersionLoading = () => {
    const l = selectedLoader();
    if (l === "fabric") return fabricVersions.loading;
    if (l === "quilt") return quiltVersions.loading;
    if (l === "neoforge") return neoforgeVersions.loading;
    if (l === "forge") return forgeVersions.loading;
    return false;
  };

  // Auto-pick latest stable version when switching loader
  createEffect(() => {
    const l = selectedLoader();
    const current = inst();
    if (!current) return;

    if (l === "vanilla") {
      setSelectedVersion(null);
      return;
    }

    if (l === current.loader.type && current.loader.version) {
      // If returning to current loader, restore current version
      setSelectedVersion(current.loader.version);
      return;
    }

    const list = availableLoaderVersions();
    if (list.length > 0) {
      const stable = list.find((v) => v.stable) || list[0];
      setSelectedVersion(stable.version);
    }
  });

  // Active mod count (only category === "mod" can crash the loader)
  const activeModCount = () => inst()?.mod_count || 0;

  // Risk & change categorizations
  const isSameLoader = () => selectedLoader() === inst()?.loader.type;
  const isSameVersion = () =>
    selectedVersion() === (inst()?.loader.version || null) ||
    (selectedLoader() === "vanilla" && !inst()?.loader.version);
  const isNoChange = () => isSameLoader() && isSameVersion();
  const isVanillaToModded = () => inst()?.loader.type === "vanilla" && selectedLoader() !== "vanilla";
  const isModdedToVanilla = () => inst()?.loader.type !== "vanilla" && selectedLoader() === "vanilla";
  const isFabricQuiltCross = () =>
    (inst()?.loader.type === "fabric" && selectedLoader() === "quilt") ||
    (inst()?.loader.type === "quilt" && selectedLoader() === "fabric");
  const isIncompatibleCross = () =>
    !isSameLoader() && !isVanillaToModded() && !isModdedToVanilla() && !isFabricQuiltCross();

  const formatLoaderVersionDisplay = (ver: string) => {
    const l = selectedLoader();
    const gv = inst()?.game_version || "";
    if (l === "forge" && gv && ver.startsWith(`${gv}-`)) {
      let clean = ver.slice(gv.length + 1);
      if (clean.endsWith(`-${gv}`)) {
        clean = clean.slice(0, clean.length - gv.length - 1);
      }
      return clean;
    }
    return ver;
  };

  // Close version dropdown or modal on Escape
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !changing()) {
        if (versionDropOpen()) {
          setVersionDropOpen(false);
        } else {
          closeChangeLoaderModal();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const handleApply = async () => {
    const current = inst();
    if (!current || isNoChange() || changing()) return;

    if (gameRunning()) {
      showToast({
        title: "Game running",
        message: "Please close Minecraft before changing the mod loader.",
        type: "error",
      });
      return;
    }

    setChanging(true);
    try {
      await changeInstanceLoader(
        current.id,
        selectedLoader(),
        selectedLoader() === "vanilla" ? null : selectedVersion(),
        disableMods()
      );
      await syncInstanceMods(current.id);
      await refetchInstances();
      showToast({
        title: "Loader updated",
        message: `Switched "${current.name}" to ${loaderLabel(selectedLoader())} ${selectedVersion() || ""}`.trim(),
        type: "success",
        autoCloseMs: 3500,
      });
      closeChangeLoaderModal();
    } catch (e: any) {
      showToast({
        title: "Failed to change loader",
        message: typeof e === "string" ? e : e?.message || "Unknown error",
        type: "error",
        autoCloseMs: 6000,
      });
    } finally {
      setChanging(false);
    }
  };

  return (
    <Show when={open() && inst()}>
      <div class="modal-overlay" onClick={closeChangeLoaderModal}>
        <div
          class="modal"
          style="width: 560px; max-width: 95vw;"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-instances">FRAMEWORK</span>
              <div>
                <div class="modal-title">Change Mod Loader</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 2px">
                  {inst()!.name} &middot; Minecraft {inst()!.game_version}
                </div>
              </div>
            </div>
          </div>

          {/* Body */}
          <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-4);">
            {/* 1. Loader Selection */}
            <div>
              <div class="field-label" style="margin-bottom: 8px">Select Modding Framework</div>
              <div class="loader-grid" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px;">
                <For each={LOADER_INFOS}>
                  {(item) => {
                    const isSelected = () => selectedLoader() === item.id;
                    const isCurrent = () => inst()?.loader.type === item.id;
                    const compatible = () => isLoaderCompatible(item.id);

                    return (
                      <div
                        class="loader-card"
                        classList={{
                          selected: isSelected(),
                          disabled: !compatible(),
                        }}
                        style={!compatible() ? "opacity: 0.45; cursor: not-allowed;" : ""}
                        onClick={() => {
                          if (compatible()) {
                            setSelectedLoader(item.id);
                          }
                        }}
                      >
                        <div class={`loader-card-icon ${item.colorClass}`}>
                          {item.icon()}
                        </div>
                        <div class="loader-card-info" style="min-width: 0; flex: 1;">
                          <div class="loader-card-top" style="display: flex; align-items: center; justify-content: space-between; gap: 4px;">
                            <span class="loader-card-name" style="font-size: 13px; font-weight: 700;">{item.name}</span>
                            <Show
                              when={isCurrent()}
                              fallback={
                                <Show when={!compatible()}>
                                  <span class="loader-card-tag" style="background: rgba(239,68,68,0.2); color: var(--danger); font-size: 9px; padding: 2px 4px;">Unsupported</span>
                                </Show>
                              }
                            >
                              <span class="loader-card-tag" style="background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); font-size: 9px; padding: 2px 4px;">Current</span>
                            </Show>
                          </div>
                          <div class="loader-card-desc" style="font-size: 10px; line-height: 1.3; margin-top: 2px; color: var(--muted);">
                            {compatible() ? item.desc : `Not available for MC ${inst()?.game_version}`}
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            {/* 2. Loader Version Selector (When non-vanilla) */}
            <Show when={selectedLoader() !== "vanilla"}>
              <div
                class="setting-row"
                style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--surface-panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 0; box-sizing: border-box;"
              >
                <div class="setting-info" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                  <span class="setting-name" style="font-size: 13px; font-weight: 600; color: var(--text);">{loaderLabel(selectedLoader())} Version</span>
                  <span class="setting-desc" style="font-size: 11px; color: var(--muted); line-height: 1.4;">
                    {isVersionLoading() ? "Fetching available versions..." : "Select the loader runtime release to use"}
                  </span>
                </div>
                <div class="setting-control" style="position: relative; display: inline-flex; flex-shrink: 0;">
                  <button
                    type="button"
                    class="btn btn--sm"
                    style="min-width: 140px; justify-content: space-between;"
                    disabled={isVersionLoading() || availableLoaderVersions().length === 0}
                    onClick={() => setVersionDropOpen(!versionDropOpen())}
                  >
                    <span>{selectedVersion() ? formatLoaderVersionDisplay(selectedVersion()!) : (isVersionLoading() ? "Loading..." : "None")}</span>
                    <IconChevronDown />
                  </button>

                  {/* Version dropdown panel directly anchored to button */}
                  <Show when={versionDropOpen() && availableLoaderVersions().length > 0}>
                    <div
                      class="custom-select-panel"
                      style="position: absolute; right: 0; top: calc(100% + 4px); min-width: 100%; width: max-content; max-width: 260px; max-height: 200px; overflow-y: auto; background: var(--surface-panel); border: 1px solid var(--border-strong); box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 100; border-radius: 0;"
                    >
                      <For each={availableLoaderVersions()}>
                        {(v) => (
                          <div
                            class="custom-select-option"
                            style={`padding: 6px 12px; font-size: 12px; font-family: var(--font-mono); cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; ${selectedVersion() === v.version ? "background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);" : "color: var(--text);"}`}
                            onClick={() => {
                              setSelectedVersion(v.version);
                              setVersionDropOpen(false);
                            }}
                          >
                            <span>{formatLoaderVersionDisplay(v.version)}</span>
                            <Show when={v.stable}>
                              <span style="font-size: 9px; padding: 1px 4px; background: rgba(34,197,94,0.15); color: var(--success); text-transform: uppercase;">stable</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* 3. Impact Analysis & Safeguard Callouts */}
            <div>
              {/* Scenario 1: Same loader and version (No changes) */}
              <Show when={isNoChange()}>
                <div style="padding: 10px 12px; background: var(--surface-panel); border: 1px solid var(--border); border-left: 3px solid var(--muted); font-size: 12px; color: var(--muted);">
                  No changes selected. Pick a different loader or version to switch.
                </div>
              </Show>

              {/* Scenario 2: Same loader, changing version (Upgrade/Downgrade) */}
              <Show when={isSameLoader() && !isSameVersion()}>
                <div style="padding: 10px 12px; background: color-mix(in srgb, var(--accent) 6%, var(--surface-panel)); border: 1px solid var(--border); border-left: 3px solid var(--accent); font-size: 12px; color: var(--text);">
                  <div style="font-weight: 600; color: var(--accent); margin-bottom: 2px;">Loader Runtime Update</div>
                  <div>
                    Updating {loaderLabel(selectedLoader())} from <strong style="font-family:var(--font-mono)">{inst()!.loader.version || "default"}</strong> to <strong style="font-family:var(--font-mono)">{selectedVersion()}</strong>. Installed mods will remain intact and will run on the updated loader.
                  </div>
                </div>
              </Show>

              {/* Scenario 3: Vanilla -> Modded */}
              <Show when={isVanillaToModded()}>
                <div style="padding: 10px 12px; background: rgba(34,197,94,0.06); border: 1px solid var(--border); border-left: 3px solid var(--success); font-size: 12px; color: var(--text);">
                  <div style="font-weight: 600; color: var(--success); margin-bottom: 2px;">Enabling Mod Support</div>
                  <div>
                    Switching to {loaderLabel(selectedLoader())} will enable mod support for this instance. You will be able to browse and install {loaderLabel(selectedLoader())} mods directly from Modrinth and CurseForge.
                  </div>
                </div>
              </Show>

              {/* Scenario 4: Modded -> Vanilla */}
              <Show when={isModdedToVanilla()}>
                <Show
                  when={activeModCount() > 0}
                  fallback={
                    <div style="padding: 10px 12px; background: rgba(34,197,94,0.06); border: 1px solid var(--border); border-left: 3px solid var(--success); font-size: 12px; color: var(--text);">
                      <div style="font-weight: 600; color: var(--success); margin-bottom: 2px;">Switching to Vanilla</div>
                      <div>No mods are currently active on this instance. Switching to Vanilla is completely safe.</div>
                    </div>
                  }
                >
                  <div style="padding: 12px; background: rgba(245,158,11,0.08); border: 1px solid var(--border); border-left: 3px solid var(--warn);">
                    <div style="display: flex; gap: 8px; align-items: flex-start;">
                      <div style="color: var(--warn); margin-top: 1px;"><IconAlertTriangle /></div>
                      <div style="flex: 1; font-size: 12px;">
                        <div style="font-weight: 700; color: var(--warn); margin-bottom: 3px;">Vanilla Does Not Run Mods</div>
                        <div style="color: var(--text); line-height: 1.4;">
                          You have <strong>{activeModCount()} active mod{activeModCount() === 1 ? "" : "s"}</strong>. Vanilla Minecraft will not load them, and worlds saved with modded items may have missing blocks.
                        </div>

                        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);">
                          <label class="check check--lg" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input
                              type="checkbox"
                              checked={disableMods()}
                              onChange={(e) => setDisableMods(e.currentTarget.checked)}
                            />
                            <span class="check-box"></span>
                            <span style="font-size: 12px; font-weight: 600; color: var(--text);">
                              Disable {activeModCount()} installed mod{activeModCount() === 1 ? "" : "s"} (renames to .disabled)
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>
              </Show>

              {/* Scenario 5: Fabric <-> Quilt */}
              <Show when={isFabricQuiltCross()}>
                <div style="padding: 12px; background: rgba(124,77,222,0.08); border: 1px solid var(--border); border-left: 3px solid #7c3aed;">
                  <div style="font-size: 12px; line-height: 1.4;">
                    <div style="font-weight: 700; color: #a78bfa; margin-bottom: 2px;">Cross-Compatible Ecosystems</div>
                    <div style="color: var(--text);">
                      Quilt and Fabric share high compatibility. Most mods will continue to work normally, although a few specific mods may require loader-targeted builds.
                    </div>
                  </div>
                </div>
              </Show>

              {/* Scenario 6: Incompatible Loader Architecture (e.g. Fabric <-> Forge/NeoForge) */}
              <Show when={isIncompatibleCross()}>
                <Show
                  when={activeModCount() > 0}
                  fallback={
                    <div style="padding: 10px 12px; background: rgba(34,197,94,0.06); border: 1px solid var(--border); border-left: 3px solid var(--success); font-size: 12px; color: var(--text);">
                      <div style="font-weight: 600; color: var(--success); margin-bottom: 2px;">Safe Loader Switch</div>
                      <div>No mods are currently active on this instance. Switching to {loaderLabel(selectedLoader())} is completely safe.</div>
                    </div>
                  }
                >
                  <div style="padding: 12px; background: rgba(239,68,68,0.08); border: 1px solid var(--border); border-left: 3px solid var(--danger);">
                    <div style="display: flex; gap: 8px; align-items: flex-start;">
                      <div style="color: var(--danger); margin-top: 2px;"><IconAlertTriangle /></div>
                      <div style="flex: 1; font-size: 12px;">
                        <div style="font-weight: 700; color: var(--danger); margin-bottom: 4px;">
                          Incompatible Mod Architecture
                        </div>
                        <div style="color: var(--text); line-height: 1.4;">
                          You have <strong>{activeModCount()} active mod{activeModCount() === 1 ? "" : "s"}</strong> installed for <strong>{loaderLabel(inst()!.loader.type)}</strong>.
                          Mods built for {loaderLabel(inst()!.loader.type)} are <span style="color: var(--danger); font-weight: 700;">completely incompatible</span> with {loaderLabel(selectedLoader())} and will cause Minecraft to crash on launch.
                        </div>

                        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);">
                          <label class="check check--lg" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input
                              type="checkbox"
                              checked={disableMods()}
                              onChange={(e) => setDisableMods(e.currentTarget.checked)}
                            />
                            <span class="check-box"></span>
                            <span style="font-size: 12px; font-weight: 600; color: var(--text);">
                              Disable {activeModCount()} incompatible mod{activeModCount() === 1 ? "" : "s"} (Recommended)
                            </span>
                          </label>
                          <div style="font-size: 11px; color: var(--muted); margin-left: 26px; margin-top: 2px;">
                            Renames active jars to <code style="font-family:var(--font-mono);color:var(--text)">.disabled</code>. Your mods are safely kept in your Library and can be re-enabled if you switch back.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </div>

          {/* Footer */}
          <div class="modal-footer">
            <button
              class="btn btn--subtle btn--sm"
              onClick={closeChangeLoaderModal}
              disabled={changing()}
            >
              Cancel
            </button>
            <button
              class={`btn btn--sm ${isIncompatibleCross() && activeModCount() > 0 && !disableMods() ? "btn--danger" : "btn--primary"}`}
              disabled={
                isNoChange() ||
                !isLoaderCompatible(selectedLoader()) ||
                changing() ||
                (selectedLoader() !== "vanilla" && (!selectedVersion() || isVersionLoading()))
              }
              onClick={handleApply}
            >
              <Show
                when={!changing()}
                fallback={"Applying changes..."}
              >
                {isSameLoader()
                  ? `Update ${loaderLabel(selectedLoader())}`
                  : `Switch to ${loaderLabel(selectedLoader())}`}
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ChangeLoaderModal;
