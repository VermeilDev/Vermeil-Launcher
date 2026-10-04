// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, Show, For, createMemo, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import {
  activeScreen,
  setActiveScreen,
  Screen,
  instances,
  setActiveInstanceId,
  gameRunning,
  setGameRunning,
  showToast,
  pinnedInstanceIds,
  pinSelectorOpen,
  setPinSelectorOpen,
  setInitialInstanceTab,
  dockHidden,
  autoHideDockSetting,
  dockPagination,
  paginationPosition,
  paginationScrollMode,
  activeDownloadCount,
} from "../App";
import { resolveAssetUrl } from "../lib/assets";
import {
  IconHome,
  IconGrid,
  IconSettings,
  IconUser,
  IconShirt,
  IconPlus,
  IconDownload,
  IconX,
} from "./Icons";
import { stopInstance } from "../ipc/commands";
import {
  openPinInstancesModal,
  closePinInstancesModal,
  pinInstancesModalOpen,
  MAX_PINS,
} from "../modals/PinInstancesModal";

/**
 * Bottom-centered floating dock — single unified pill with a FAB-style
 * center action button raised above it.
 *
 * When pagination is active a second mini floating pill appears above the
 * dock with ‹ page/total › controls.
/**
 * Standalone pagination island — iOS-style dot indicator above the dock.
 * Safely guards all pagination signals to prevent any exceptions when
 * dockPagination() changes or resets to null.
 */
const DockPaginationIsland: Component = () => {
  const [holding, setHolding] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");
  const [scrolling, setScrolling] = createSignal(false);
  let scrollResetTimer: number | undefined;
  const flashScroll = () => {
    setScrolling(true);
    if (scrollResetTimer !== undefined) window.clearTimeout(scrollResetTimer);
    scrollResetTimer = window.setTimeout(() => setScrolling(false), 600);
  };
  let holdTimer: number | undefined;
  let islandEl: HTMLDivElement | undefined;
  let lastWheelTime = 0;
  const WHEEL_COOLDOWN_MS = 140;

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pag = dockPagination();
    if (!pag) return;

    // Dominant scroll delta (supports standard vertical wheel and horizontal tilt / trackpad)
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 1) return;

    const now = Date.now();
    if (now - lastWheelTime < WHEEL_COOLDOWN_MS) return;
    lastWheelTime = now;

    flashScroll();

    // Scrolling DOWN (delta > 0) / RIGHT advances to NEXT page
    // Scrolling UP (delta < 0) / LEFT moves back to PREVIOUS page
    if (delta > 0 && pag.current < pag.total) {
      pag.onPageChange(pag.current + 1);
      if (holding()) setInputValue((pag.current + 1).toString());
    } else if (delta < 0 && pag.current > 1) {
      pag.onPageChange(pag.current - 1);
      if (holding()) setInputValue((pag.current - 1).toString());
    }
  };

  onCleanup(() => {
    if (scrollResetTimer !== undefined) window.clearTimeout(scrollResetTimer);
    if (islandEl) islandEl.removeEventListener("wheel", handleWheel);
  });

  // When pagination scroll mode is toggled on, capture mouse wheel anywhere in the window
  createEffect(() => {
    if (!paginationScrollMode()) return;
    const onWindowWheel = (e: WheelEvent) => {
      const pag = dockPagination();
      if (!pag || pag.total <= 1) return;
      handleWheel(e);
    };
    window.addEventListener("wheel", onWindowWheel, { passive: false });
    onCleanup(() => {
      window.removeEventListener("wheel", onWindowWheel);
    });
  });

  const startHold = () => {
    const pag = dockPagination();
    if (!pag) return;
    holdTimer = window.setTimeout(() => {
      setHolding(true);
      setInputValue((dockPagination()?.current ?? 1).toString());
      setTimeout(() => {
        const input = islandEl?.querySelector<HTMLInputElement>(".dock-page-input");
        if (input) { input.focus(); input.select(); }
      }, 20);
    }, 500);
  };
  const cancelHold = () => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
  };
  const submitInput = () => {
    const val = parseInt(inputValue());
    const pag = dockPagination();
    if (pag && !isNaN(val) && val >= 1 && val <= pag.total) {
      pag.onPageChange(val);
    }
    setHolding(false);
  };

  const MAX_DOTS = 7;
  const dots = () => {
    const pag = dockPagination();
    if (!pag) return [];
    const total = pag.total;
    const current = pag.current;
    const count = Math.min(MAX_DOTS, total);
    let start = Math.max(1, current - Math.floor(count / 2));
    if (start + count - 1 > total) start = Math.max(1, total - count + 1);
    const arr: number[] = [];
    for (let i = start; i < start + count; i++) arr.push(i);
    return arr;
  };

  return (
    <div
      class={`dock-page-island ${holding() ? "holding" : ""}`}
      classList={{ "scroll-mode-active": paginationScrollMode() }}
      ref={(el) => {
        islandEl = el;
        el.addEventListener("wheel", handleWheel, { passive: false });
      }}
      onMouseDown={startHold}
      onMouseUp={cancelHold}
      onMouseLeave={cancelHold}
      data-tip={paginationScrollMode() ? "Scroll active (Z)" : undefined}
    >
      <Show when={!holding()}>
        <div class="dock-page-dots">
          <For each={dots()}>
            {(page) => {
              const isActive = () => {
                const pag = dockPagination();
                return pag ? page === pag.current : false;
              };
              const dist = () => {
                const pag = dockPagination();
                return pag ? Math.abs(page - pag.current) : 0;
              };
              return (
                <div
                  class={`dock-dot ${isActive() ? "active" : ""} ${isActive() && scrolling() ? "scrolling" : ""}`}
                  style={`opacity: ${Math.max(0.2, 1 - dist() * 0.2)}; transform: scale(${isActive() ? 1 : Math.max(0.5, 1 - dist() * 0.15)})`}
                  onClick={() => {
                    const pag = dockPagination();
                    if (pag) {
                      pag.onPageChange(page);
                      flashScroll();
                    }
                  }}
                >
                  <Show when={isActive()}>
                    <span class="dock-dot-num">{page}</span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={holding()}>
        <div class="dock-page-hold-input">
          <input
            class="dock-page-input"
            type="text"
            value={inputValue()}
            onInput={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitInput(); if (e.key === "Escape") setHolding(false); }}
            onBlur={submitInput}
          />
          <span class="dock-page-total">/ {dockPagination()?.total ?? 1}</span>
        </div>
      </Show>
    </div>
  );
};

const FloatingDock: Component = () => {
  let dockEl: HTMLDivElement | undefined;
  const isActive = (screens: Screen[]) => screens.includes(activeScreen());
  const effectiveDockHidden = () => autoHideDockSetting() || dockHidden();

  const [nearBottom, setNearBottom] = createSignal(false);
  let leaveTimer: number | undefined;

  onMount(() => {
    const handler = (e: MouseEvent) => {
      // If dock isn't in auto-hide mode, reset nearBottom and bail
      if (!effectiveDockHidden()) {
        if (nearBottom()) setNearBottom(false);
        return;
      }

      const center = window.innerWidth / 2;
      const distFromBottom = window.innerHeight - e.clientY;

      if (!nearBottom()) {
        // Precise bottom-centered trigger zone: 180px width (90px left/right of center) and bottom 14px
        const inCenterTrigger = Math.abs(e.clientX - center) <= 90 && distFromBottom <= 14;
        if (inCenterTrigger) {
          if (leaveTimer !== undefined) {
            clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
          setNearBottom(true);
        }
      } else {
        // Dock is currently visible: keep it open while cursor is within dock bounding area (+ margin)
        let inDockArea = false;
        if (dockEl) {
          const rect = dockEl.getBoundingClientRect();
          inDockArea =
            e.clientX >= rect.left - 40 &&
            e.clientX <= rect.right + 40 &&
            e.clientY >= rect.top - 50 &&
            e.clientY <= window.innerHeight;
        } else {
          inDockArea = Math.abs(e.clientX - center) <= 240 && distFromBottom <= 100;
        }

        if (inDockArea) {
          if (leaveTimer !== undefined) {
            clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
        } else {
          // Cursor moved away from dock — give 300ms grace period before sliding away
          if (leaveTimer === undefined) {
            leaveTimer = window.setTimeout(() => {
              setNearBottom(false);
              leaveTimer = undefined;
            }, 300);
          }
        }
      }
    };

    window.addEventListener("mousemove", handler);
    onCleanup(() => {
      window.removeEventListener("mousemove", handler);
      if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    });
  });

  // Auto-dismiss pin selector when clicking outside the dock pill
  createEffect(() => {
    if (!pinSelectorOpen()) return;
    const onMouseDown = (e: MouseEvent) => {
      // Only dismiss on left-click (button 0) — ignore right-click, middle-click, and side buttons (Mouse4/5)
      if (e.button !== 0) return;
      // Do not auto-dismiss the pin dock while managing pins in the modal
      if (pinInstancesModalOpen()) return;
      if (dockEl && !dockEl.contains(e.target as Node)) {
        setPinSelectorOpen(false);
      }
    };
    // Defer listener attachment so the event that opened pin selector (e.g. Mouse4/mouse side button)
    // finishes bubbling without immediately triggering dismissal.
    let timer: number | undefined = window.setTimeout(() => {
      window.addEventListener("mousedown", onMouseDown);
    }, 50);

    onCleanup(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("mousedown", onMouseDown);
    });
  });

  const hidden = () => effectiveDockHidden() && !nearBottom() && !pinSelectorOpen();

  const showDownloadBadge = () => activeDownloadCount() > 0;

  const DockBtn = (props: { screens: Screen[]; target: Screen; icon: any; label: string; badge?: number }) => (
    <div class="dock-btn-slot">
      <button
        type="button"
        class={`dock-btn ${isActive(props.screens) ? "active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setActiveScreen(props.target);
          if (props.target !== "mods") setActiveInstanceId(null);
        }}
        data-tooltip={props.label}
      >
        {props.icon}
        <Show when={props.badge !== undefined && props.badge > 0}>
          <span class="dock-badge">{props.badge}</span>
        </Show>
      </button>
    </div>
  );

  const loaderLabel = (t: string) => {
    switch (t) {
      case "neoforge": return "NeoForge";
      case "forge": return "Forge";
      case "fabric": return "Fabric";
      case "quilt": return "Quilt";
      case "vanilla": return "Vanilla";
      default: return t;
    }
  };

  const pinnedInstances = () => {
    const list = instances();
    if (!list) return [];
    const ids = pinnedInstanceIds();
    return ids
      .map((id) => list.find((inst) => inst.id === id))
      .filter((inst): inst is NonNullable<typeof inst> => !!inst);
  };

  const openPinned = (id: string) => {
    closePinInstancesModal();
    setActiveInstanceId(id);
    setInitialInstanceTab("content");
    setActiveScreen("mods");
    setPinSelectorOpen(false);
  };

  type CenterMode = "stop" | "create";
  const centerMode = createMemo<CenterMode>(() => {
    if (gameRunning()) return "stop";
    return "create";
  });

  const createScreens: Screen[] = [
    "create-choose",
    "create-custom",
    "create-modpack",
    "create-import",
  ];

  const isCenterActive = () => {
    if (centerMode() === "create") {
      return createScreens.includes(activeScreen());
    }
    return false;
  };

  const centerLabel = () => {
    switch (centerMode()) {
      case "stop": return "Stop game";
      case "create": return "New instance";
    }
  };

  const handleCenterClick = async () => {
    const mode = centerMode();
    if (mode === "create") {
      setActiveScreen("create-choose");
      return;
    }
    if (mode === "stop") {
      try {
        await stopInstance();
        setGameRunning(false);
      } catch (e) {
        showToast({ title: "Stop failed", message: String(e), type: "error" });
      }
      return;
    }
  };

  return (
    <>
      {/* Cut-off rectangular bottom-centered trigger tab — appears when dock is auto-hidden */}
      <Show when={effectiveDockHidden() && !pinSelectorOpen()}>
        <div
          class={`dock-trigger-zone ${!nearBottom() ? "visible" : ""}`}
          onMouseEnter={() => {
            if (leaveTimer !== undefined) {
              clearTimeout(leaveTimer);
              leaveTimer = undefined;
            }
            setNearBottom(true);
          }}
          onClick={() => setNearBottom(true)}
          data-tip="Show dock"
        />
      </Show>

      {/* Pagination island — persists cleanly above the dock or rests at bottom when dock is hidden */}
      <Show when={Boolean(dockPagination()) && !pinSelectorOpen()}>
        <div class={`dock-island-wrap pos-${paginationPosition()} ${hidden() ? "dock-hidden" : ""}`}>
          <DockPaginationIsland />
        </div>
      </Show>

      <div class={`dock-wrap ${pinSelectorOpen() ? "pin-mode" : ""} ${hidden() ? "dock-hidden" : ""}`}>
        <div class="dock" ref={dockEl}>
        {/* NAV MODE */}
        <Show when={!pinSelectorOpen()}>
          <div class="dock-row">
            <DockBtn screens={["home"]} target="home" icon={<IconHome />} label="Home" />
            <DockBtn
              screens={isCenterActive() ? ["library"] : ["library", "mods"]}
              target="library"
              icon={<IconGrid />}
              label="Library"
            />
            <DockBtn screens={["skins"]} target="skins" icon={<IconShirt />} label="Skins" />

            {/* Center Action Button */}
            <div class="dock-btn-slot">
              <button
                type="button"
                class={`dock-btn dock-center-btn ${isCenterActive() ? "active" : ""} ${centerMode() === "stop" ? "dock-btn-stop" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCenterClick}
                data-tooltip={centerLabel()}
              >
                <span class="dock-center-icon">
                  <Show when={centerMode() === "create"}>
                    <IconPlus />
                  </Show>
                  <Show when={centerMode() === "stop"}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
                  </Show>
                </span>
                <Show when={isCenterActive()}>
                  <span class="dock-btn-dot" />
                </Show>
              </button>
            </div>

            <DockBtn
              screens={["downloads"]}
              target="downloads"
              icon={<IconDownload />}
              label="Downloads"
              badge={showDownloadBadge() ? activeDownloadCount() : undefined}
            />
            <DockBtn screens={["settings"]} target="settings" icon={<IconSettings />} label="Settings" />
            <DockBtn screens={["account"]} target="account" icon={<IconUser />} label="Account" />
          </div>
        </Show>

        {/* PIN SELECTOR MODE */}
        <Show when={pinSelectorOpen()}>
          <div class="dock-pin-carousel">
            <div class="dock-pin-track">
              <Show
                when={pinnedInstances().length > 0}
                fallback={
                  <div class="dock-pin-hint">
                    <span class="dock-pin-hint-title">Pin up to {MAX_PINS} instances</span>
                    <span class="dock-pin-hint-sub">Quick-launch favourites straight from the dock</span>
                  </div>
                }
              >
                <div class="dock-pin-items">
                  <For each={pinnedInstances()}>
                    {(inst, i) => {
                      const iconSrc = () => resolveAssetUrl(inst.icon);
                      const tooltip = `${inst.name} · ${inst.game_version} ${loaderLabel(inst.loader?.type || "vanilla")}`;
                      return (
                        <button
                          type="button"
                          class={`dock-pin-tile loader-${inst.loader?.type === "neoforge" ? "neoforge" : (inst.loader?.type || "vanilla")}`}
                          style={`animation-delay:${i() * 30}ms`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => openPinned(inst.id)}
                          data-tooltip={tooltip}
                        >
                          <div class="dock-pin-tile-img">
                            <Show
                              when={iconSrc()}
                              fallback={
                                <span class="dock-pin-tile-letter">
                                  {inst.name.trim().charAt(0).toUpperCase() || "?"}
                                </span>
                              }
                            >
                              <img
                                src={iconSrc()!}
                                alt=""
                                draggable={false}
                                onError={(e) => {
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                            </Show>
                          </div>
                          <span class="dock-pin-tile-name">{inst.name}</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>

              <div class="dock-pin-actions">
                <button
                  type="button"
                  class="dock-pin-tile dock-pin-tile-manage"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    openPinInstancesModal();
                  }}
                  data-tooltip="Manage pins"
                >
                  <div class="dock-pin-tile-img">
                    <IconPlus />
                  </div>
                  <span class="dock-pin-tile-name">Manage</span>
                </button>

                <button
                  type="button"
                  class="dock-pin-tile dock-pin-tile-close"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    closePinInstancesModal();
                    setPinSelectorOpen(false);
                  }}
                  data-tooltip="Close pins (Esc)"
                >
                  <div class="dock-pin-tile-img">
                    <IconX />
                  </div>
                  <span class="dock-pin-tile-name">Close</span>
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  </>
  );
};

export default FloatingDock;
