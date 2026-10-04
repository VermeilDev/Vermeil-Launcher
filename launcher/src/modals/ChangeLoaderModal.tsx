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
  IconAnvil,
  IconPuzzle,
  IconChevronDown,
  IconSearch,
  IconArrowRight,
} from "../components/Icons";
import TactileSwitch from "../components/TactileSwitch";

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
    desc: "Clean official game runtime",
    tag: "Official",
    colorClass: "green",
    icon: () => <IconCube />,
  },
  {
    id: "fabric",
    name: "Fabric",
    desc: "Lightweight & fast modern loader",
    tag: "Popular",
    colorClass: "fabric",
    icon: () => <IconLayers />,
  },
  {
    id: "neoforge",
    name: "NeoForge",
    desc: "Modern 1.20.2+ Forge fork",
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
    icon: () => <IconAnvil />,
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
  let popoverAnchorRef: HTMLDivElement | undefined;

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
  const [versionFilter, setVersionFilter] = createSignal("");

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
      setVersionFilter("");
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

  const formatLoaderVersionDisplay = (ver: string, loader = selectedLoader()) => {
    const gv = inst()?.game_version || "";
    if (loader === "forge" && gv && ver.startsWith(`${gv}-`)) {
      let clean = ver.slice(gv.length + 1);
      if (clean.endsWith(`-${gv}`)) {
        clean = clean.slice(0, clean.length - gv.length - 1);
      }
      return clean;
    }
    return ver;
  };

  const filteredVersions = createMemo(() => {
    const list = availableLoaderVersions();
    const q = versionFilter().trim().toLowerCase();
    if (!q) return list;
    return list.filter((v) => {
      const raw = v.version.toLowerCase();
      const display = formatLoaderVersionDisplay(v.version).toLowerCase();
      const isStable = v.stable ? "stable" : "";
      return raw.includes(q) || display.includes(q) || isStable.includes(q);
    });
  });

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
      setSelectedVersion(current.loader.version);
      return;
    }

    const list = availableLoaderVersions();
    if (list.length > 0) {
      const stable = list.find((v) => v.stable) || list[0];
      setSelectedVersion(stable.version);
    }
  });

  // Active mod count
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

  // Close version dropdown on outside click
  createEffect(() => {
    if (!versionDropOpen()) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverAnchorRef && !popoverAnchorRef.contains(e.target as Node)) {
        setVersionDropOpen(false);
        setVersionFilter("");
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", onDocClick);
    }, 10);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("click", onDocClick);
    });
  });

  // Close version dropdown or modal on Escape
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !changing()) {
        if (versionDropOpen()) {
          setVersionDropOpen(false);
          setVersionFilter("");
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
          style="width: 620px; max-width: 95vw; overflow: visible;"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-instances">FRAMEWORK</span>
              <div>
                <div class="modal-title">Change Mod Loader</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 2px; font-family: var(--font-mono);">
                  {inst()!.name} &middot; Minecraft {inst()!.game_version}
                </div>
              </div>
            </div>
          </div>

          {/* Body */}
          <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px; overflow: visible;">
            {/* 1. Loader Selection (Balanced 3+2 Bento Grid) */}
            <div>
              <div class="field-label" style="margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
                <span>Select Modding Framework</span>
                <span style="font-size: 9.5px; color: var(--muted); text-transform: none; font-weight: 500;">5 Available</span>
              </div>
              <div class="loader-grid" style="gap: 8px;">
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
                            setVersionDropOpen(false);
                            setVersionFilter("");
                          }
                        }}
                      >
                        <div class={`loader-card-icon ${item.colorClass}`}>
                          {item.icon()}
                        </div>
                        <div class="loader-card-info" style="min-width: 0; flex: 1;">
                          <div
                            class="loader-card-top"
                            style="display: flex; align-items: center; justify-content: space-between; gap: 4px;"
                          >
                            <span
                              class="loader-card-name"
                              style="font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                            >
                              {item.name}
                            </span>
                            <Show
                              when={isCurrent()}
                              fallback={
                                <Show when={!compatible()}>
                                  <span
                                    class="loader-card-tag"
                                    style="background: rgba(239,68,68,0.2); color: var(--danger); font-size: 8.5px; font-weight: 700; text-transform: uppercase; padding: 1px 4px; border: 1px solid rgba(239,68,68,0.3);"
                                  >
                                    Unsupported
                                  </span>
                                </Show>
                              }
                            >
                              <span
                                class="loader-card-tag"
                                style="background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); font-size: 8.5px; font-weight: 700; text-transform: uppercase; padding: 1px 4px; border: 1px solid rgba(139,92,246,0.3);"
                              >
                                Current
                              </span>
                            </Show>
                          </div>
                          <div
                            class="loader-card-desc"
                            style="font-size: 10px; line-height: 1.3; margin-top: 1px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                          >
                            {compatible() ? item.desc : `Unsupported on MC ${inst()?.game_version}`}
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            {/* 2. Runtime Specification Plate (Stable Height & Searchable Combobox) */}
            <Show
              when={selectedLoader() !== "vanilla"}
              fallback={
                <div
                  class="setting-row"
                  style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--surface-panel); border: 1px solid var(--border); border-left: 3px solid var(--success); min-height: 58px; box-sizing: border-box;"
                >
                  <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 12.5px; font-weight: 700; color: var(--text);">
                      Official Vanilla Runtime
                    </span>
                    <span style="font-size: 11px; color: var(--muted); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                      Standard unmodified Minecraft {inst()?.game_version} execution environment
                    </span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); color: var(--success); font-size: 10.5px; font-weight: 700; text-transform: uppercase; font-family: var(--font-mono);">
                    DEFAULT
                  </div>
                </div>
              }
            >
              <div
                class="setting-row"
                style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--surface-panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); min-height: 58px; box-sizing: border-box;"
              >
                <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 12.5px; font-weight: 700; color: var(--text);">
                    {loaderLabel(selectedLoader())} Runtime Version
                  </span>
                  <span style="font-size: 11px; color: var(--muted); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    {isVersionLoading() ? "Fetching available releases..." : "Select the loader runtime release to use"}
                  </span>
                </div>
                <div style="position: relative; display: inline-flex; flex-shrink: 0;" ref={popoverAnchorRef}>
                  <button
                    type="button"
                    class="btn btn--neutral btn--sm"
                    style="min-width: 150px; justify-content: space-between; font-family: var(--font-mono); font-size: 12px;"
                    disabled={isVersionLoading() || availableLoaderVersions().length === 0}
                    onClick={() => {
                      setVersionDropOpen(!versionDropOpen());
                      setVersionFilter("");
                    }}
                  >
                    <span>{selectedVersion() ? formatLoaderVersionDisplay(selectedVersion()!) : (isVersionLoading() ? "Loading..." : "None")}</span>
                    <IconChevronDown />
                  </button>

                  {/* Searchable Dropdown Popover */}
                  <Show when={versionDropOpen() && availableLoaderVersions().length > 0}>
                    <div
                      class="custom-select-panel"
                      style="position: absolute; right: 0; top: calc(100% + 4px); width: 250px; max-height: 220px; display: flex; flex-direction: column; background: var(--surface-panel); border: 1px solid var(--border-strong); box-shadow: 0 12px 32px rgba(0,0,0,0.8); z-index: 200; border-radius: 0;"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Search Input Header */}
                      <div style="padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--surface-sunken, #0c0b12); display: flex; align-items: center; gap: 6px;">
                        <div style="color: var(--muted); display: flex; align-items: center; width: 14px; height: 14px;"><IconSearch /></div>
                        <input
                          type="text"
                          ref={(el) => setTimeout(() => el?.focus(), 50)}
                          placeholder="Filter versions..."
                          value={versionFilter()}
                          onInput={(e) => setVersionFilter(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const list = filteredVersions();
                              if (list.length > 0) {
                                setSelectedVersion(list[0].version);
                                setVersionDropOpen(false);
                                setVersionFilter("");
                              }
                            }
                          }}
                          style="background: transparent; border: none; outline: none; color: var(--text); font-family: var(--font-mono); font-size: 11.5px; width: 100%;"
                        />
                      </div>

                      {/* Version Options List */}
                      <div style="max-height: 175px; overflow-y: auto; display: flex; flex-direction: column;">
                        <For
                          each={filteredVersions()}
                          fallback={
                            <div style="padding: 12px; font-size: 11px; color: var(--muted); text-align: center; font-family: var(--font-mono);">
                              No versions match "{versionFilter()}"
                            </div>
                          }
                        >
                          {(v) => {
                            const isCurrent = () => selectedVersion() === v.version;
                            return (
                              <div
                                class="custom-select-option"
                                style={`padding: 6px 10px; font-size: 11.5px; font-family: var(--font-mono); cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; transition: background 0.1s; ${
                                  isCurrent()
                                    ? "background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-weight: 700;"
                                    : "color: var(--text);"
                                }`}
                                onClick={() => {
                                  setSelectedVersion(v.version);
                                  setVersionDropOpen(false);
                                  setVersionFilter("");
                                }}
                              >
                                <span>{formatLoaderVersionDisplay(v.version)}</span>
                                <Show when={v.stable}>
                                  <span style="font-size: 8.5px; padding: 1px 4px; background: rgba(16,185,129,0.15); color: var(--success); text-transform: uppercase; border: 1px solid rgba(16,185,129,0.3); font-family: var(--font-sans); font-weight: 700;">
                                    stable
                                  </span>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* 3. Safeguards & Impact Well (Height-Stable) */}
            <div
              style={`min-height: 84px; padding: 10px 14px; border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: center; gap: 6px; box-sizing: border-box; transition: background 0.15s, border-color 0.15s; ${
                isNoChange()
                  ? "border-left: 3px solid var(--dim, #5c566f); background: var(--surface-panel);"
                  : isSameLoader() && !isSameVersion()
                  ? "border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--surface-panel));"
                  : isVanillaToModded()
                  ? "border-left: 3px solid var(--success); background: rgba(16, 185, 129, 0.05);"
                  : isFabricQuiltCross()
                  ? "border-left: 3px solid #8b5cf6; background: rgba(139, 92, 246, 0.06);"
                  : isModdedToVanilla() && activeModCount() === 0
                  ? "border-left: 3px solid var(--success); background: rgba(16, 185, 129, 0.05);"
                  : isModdedToVanilla() && activeModCount() > 0
                  ? "border-left: 3px solid var(--warn); background: rgba(245, 158, 11, 0.06);"
                  : isIncompatibleCross() && activeModCount() === 0
                  ? "border-left: 3px solid var(--success); background: rgba(16, 185, 129, 0.05);"
                  : "border-left: 3px solid var(--danger); background: rgba(239, 68, 68, 0.06);"
              }`}
            >
              {/* Scenario 1: Same loader and version (No changes) */}
              <Show when={isNoChange()}>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: var(--surface-sunken, #0c0b12); color: var(--muted); border: 1px solid var(--border);">
                    NO CHANGES
                  </span>
                  <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                    Identical Configuration
                  </span>
                </div>
                <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                  Instance is already running {loaderLabel(inst()!.loader.type)} {inst()!.loader.version || ""}. Select a different loader or version to apply changes.
                </div>
              </Show>

              {/* Scenario 2: Same loader, changing version */}
              <Show when={isSameLoader() && !isSameVersion()}>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); border: 1px solid rgba(139,92,246,0.3);">
                    RUNTIME UPDATE
                  </span>
                  <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                    Loader Runtime Update
                  </span>
                </div>
                <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                  Updating {loaderLabel(selectedLoader())} from <strong style="font-family:var(--font-mono); color: var(--text);">{formatLoaderVersionDisplay(inst()!.loader.version || "default", inst()!.loader.type)}</strong> to <strong style="font-family:var(--font-mono); color: var(--text);">{formatLoaderVersionDisplay(selectedVersion() || "")}</strong>. Installed mods will remain intact.
                </div>
              </Show>

              {/* Scenario 3: Vanilla -> Modded */}
              <Show when={isVanillaToModded()}>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(16,185,129,0.15); color: var(--success); border: 1px solid rgba(16,185,129,0.3);">
                    ENABLING MODS
                  </span>
                  <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                    Enabling Mod Support
                  </span>
                </div>
                <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                  Switching to {loaderLabel(selectedLoader())} activates mod support for this instance. You will be able to browse and install {loaderLabel(selectedLoader())} mods directly.
                </div>
              </Show>

              {/* Scenario 4: Modded -> Vanilla */}
              <Show when={isModdedToVanilla()}>
                <Show
                  when={activeModCount() > 0}
                  fallback={
                    <>
                      <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(16,185,129,0.15); color: var(--success); border: 1px solid rgba(16,185,129,0.3);">
                          SAFE SWITCH
                        </span>
                        <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                          Switching to Vanilla
                        </span>
                      </div>
                      <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                        No mods are currently active on this instance. Switching to Vanilla is completely safe.
                      </div>
                    </>
                  }
                >
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(245,158,11,0.15); color: var(--warn); border: 1px solid rgba(245,158,11,0.3);">
                      VANILLA RUNTIME
                    </span>
                    <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                      Vanilla Does Not Run Mods
                    </span>
                  </div>
                  <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                    You have <strong style="color:var(--text);">{activeModCount()} active mod{activeModCount() === 1 ? "" : "s"}</strong>. Vanilla Minecraft will ignore them and cannot load modded content.
                  </div>
                  <div
                    style="margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; user-select: none;"
                    onClick={() => setDisableMods(!disableMods())}
                  >
                    <span style="font-size: 11.5px; font-weight: 600; color: var(--text);">
                      Disable {activeModCount()} active mod{activeModCount() === 1 ? "" : "s"} (renames to .disabled)
                    </span>
                    <TactileSwitch
                      checked={disableMods()}
                      onChange={setDisableMods}
                      aria-label="Disable active mods"
                    />
                  </div>
                </Show>
              </Show>

              {/* Scenario 5: Fabric <-> Quilt */}
              <Show when={isFabricQuiltCross()}>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(139,92,246,0.15); color: #a78bfa; border: 1px solid rgba(139,92,246,0.3);">
                    CROSS COMPATIBLE
                  </span>
                  <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                    Shared Ecosystem
                  </span>
                </div>
                <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                  Quilt and Fabric share high compatibility. Most mods continue to work normally, though individual mods may require targeted builds.
                </div>
              </Show>

              {/* Scenario 6: Incompatible Loader Architecture */}
              <Show when={isIncompatibleCross()}>
                <Show
                  when={activeModCount() > 0}
                  fallback={
                    <>
                      <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(16,185,129,0.15); color: var(--success); border: 1px solid rgba(16,185,129,0.3);">
                          SAFE SWITCH
                        </span>
                        <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                          Safe Loader Switch
                        </span>
                      </div>
                      <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                        No mods are currently active on this instance. Switching to {loaderLabel(selectedLoader())} is completely safe.
                      </div>
                    </>
                  }
                >
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 5px; background: rgba(239,68,68,0.15); color: var(--danger); border: 1px solid rgba(239,68,68,0.3);">
                      ARCHITECTURE MISMATCH
                    </span>
                    <span style="font-size: 12px; font-weight: 700; color: var(--text);">
                      Incompatible Mod Architecture
                    </span>
                  </div>
                  <div style="font-size: 11.5px; color: var(--muted); line-height: 1.4;">
                    You have <strong style="color:var(--text);">{activeModCount()} active mod{activeModCount() === 1 ? "" : "s"}</strong> built for {loaderLabel(inst()!.loader.type)}. They cannot run on {loaderLabel(selectedLoader())} and will crash on launch.
                  </div>
                  <div
                    style="margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; user-select: none;"
                    onClick={() => setDisableMods(!disableMods())}
                  >
                    <span style="font-size: 11.5px; font-weight: 600; color: var(--text);">
                      Disable {activeModCount()} incompatible mod{activeModCount() === 1 ? "" : "s"} (Recommended)
                    </span>
                    <TactileSwitch
                      checked={disableMods()}
                      onChange={setDisableMods}
                      aria-label="Disable incompatible mods"
                    />
                  </div>
                </Show>
              </Show>
            </div>
          </div>

          {/* Footer */}
          <div class="modal-footer" style="display: flex; align-items: center; justify-content: space-between;">
            {/* Real-time transition summary */}
            <div style="font-size: 11px; color: var(--muted); font-family: var(--font-mono); display: flex; align-items: center; gap: 6px;">
              <Show
                when={!isNoChange()}
                fallback={<span style="color: var(--dim, #5c566f);">No modifications pending</span>}
              >
                <span>
                  {loaderLabel(inst()!.loader.type)}
                  {inst()!.loader.type !== "vanilla" && inst()!.loader.version ? ` ${formatLoaderVersionDisplay(inst()!.loader.version!, inst()!.loader.type)}` : ""}
                </span>
                <span style="color: var(--dim, #5c566f); display: flex; align-items: center;"><IconArrowRight /></span>
                <span style="color: var(--accent); font-weight: 600;">
                  {loaderLabel(selectedLoader())}
                  {selectedLoader() !== "vanilla" && selectedVersion() ? ` ${formatLoaderVersionDisplay(selectedVersion()!, selectedLoader())}` : ""}
                </span>
              </Show>
            </div>

            {/* Actions */}
            <div style="display: flex; align-items: center; gap: 8px;">
              <button
                class="btn btn--subtle btn--sm"
                onClick={closeChangeLoaderModal}
                disabled={changing()}
              >
                Cancel
              </button>
              <button
                class={`btn btn--sm ${
                  isIncompatibleCross() && activeModCount() > 0 && !disableMods()
                    ? "btn--danger"
                    : "btn--primary"
                }`}
                disabled={
                  isNoChange() ||
                  !isLoaderCompatible(selectedLoader()) ||
                  changing() ||
                  (selectedLoader() !== "vanilla" && (!selectedVersion() || isVersionLoading()))
                }
                onClick={handleApply}
              >
                <Show when={!changing()} fallback={"Applying changes..."}>
                  {isSameLoader()
                    ? `Update ${loaderLabel(selectedLoader())}`
                    : `Switch to ${loaderLabel(selectedLoader())}`}
                </Show>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ChangeLoaderModal;
