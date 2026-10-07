// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onCleanup, onMount } from "solid-js";
import { SkinViewer, IdleAnimation } from "skinview3d";
import {
  CylinderGeometry,
  MeshBasicMaterial,
  Mesh,
  Group,
} from "three";
import {
  gameRunning,
  activeSkinUrl,
  activeOfflineSkin,
  getDummySkinDataUrl,
  offlineDummyVariant,
  account,
  activeCape,
} from "../App";
import { getSkinProfile, readCustomCapeSource, type CustomCape } from "../ipc/commands";
import { CapeAnimator, clampRes, clampScale, clampRot } from "../lib/cape";
import { normalizeHex } from "../lib/color";

interface Props {
  skinUrl?: string | null;
  capeUrl?: string | null;
  class?: string;
}

function getAccentHex(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    if (raw.startsWith("#")) {
      return parseInt(raw.slice(1), 16);
    }
  } catch {}
  return 0x8b5cf6;
}

const CharacterStage: Component<Props> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let viewer: SkinViewer | undefined;
  let rimMesh: Mesh<CylinderGeometry, MeshBasicMaterial> | undefined;
  const [viewerReady, setViewerReady] = createSignal(false);
  let capeAnimator: CapeAnimator | undefined;
  let animatorCapeId: string | null = null;

  const ensureAnimator = (): CapeAnimator => {
    if (!capeAnimator && viewer) {
      capeAnimator = new CapeAnimator(viewer, () => {
        const cape = activeCape();
        const t = cape?.customCape?.transform;
        return {
          dx: t?.dx ?? 0,
          dy: t?.dy ?? 0,
          scale: clampScale(t?.scale),
          rot: clampRot(t?.rot),
          bg: normalizeHex(t?.bg, "#2b2740"),
          res: clampRes(t?.res),
          solid: t?.solid ?? false,
          elytra: false,
        };
      });
    }
    return capeAnimator!;
  };

  const startCapeAnimation = async (cape: CustomCape) => {
    animatorCapeId = cape.id;
    try {
      const src = await readCustomCapeSource(cape.id);
      if (animatorCapeId !== cape.id || !viewer) return;
      const anim = ensureAnimator();
      if (anim) {
        await anim.start(src);
      }
    } catch (e) {
      console.error("CharacterStage animated cape failed, falling back to static frame:", e);
      try {
        viewer?.loadCape(cape.texture, { backEquipment: "cape" });
      } catch {}
    }
  };

  const stopCapeAnimation = () => {
    capeAnimator?.stop();
    animatorCapeId = null;
  };

  const loadActiveCape = () => {
    if (!viewer) return;
    const propCape = props.capeUrl;
    const currentActiveCape = activeCape();

    // 1. Explicit prop override takes priority
    if (propCape !== undefined) {
      stopCapeAnimation();
      if (propCape) {
        viewer.loadCape(propCape, { backEquipment: "cape" }).catch((e) => {
          console.error("CharacterStage prop cape load failed:", e);
        });
      } else {
        viewer.resetCape();
      }
      return;
    }

    // 2. Global active cape
    if (currentActiveCape) {
      if (
        currentActiveCape.type === "custom" &&
        currentActiveCape.customCape?.transform.animated
      ) {
        if (animatorCapeId !== currentActiveCape.id) {
          stopCapeAnimation();
          startCapeAnimation(currentActiveCape.customCape);
        }
        return;
      }

      stopCapeAnimation();
      viewer.loadCape(currentActiveCape.texture, { backEquipment: "cape" }).catch((e) => {
        console.error("CharacterStage cape load failed:", e);
      });
      return;
    }

    // 3. Neither prop nor active cape set
    stopCapeAnimation();
    viewer.resetCape();
  };

  const computeCanvasSize = () => {
    if (!viewer || !containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 0 && h > 0) {
      viewer.setSize(w, h);
    }
  };

  const loadActiveSkin = () => {
    if (!viewer) return;
    const acc = account();
    const globalSkin = activeSkinUrl();
    const propSkin = props.skinUrl;

    if (acc && !acc.is_offline) {
      if (propSkin || globalSkin) {
        viewer.loadSkin(propSkin || globalSkin!, { model: "auto-detect" }).catch(() => {});
      } else {
        // Fallback fetch if not yet populated
        getSkinProfile().then((p) => {
          const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
          if (active && viewer) {
            viewer.loadSkin(active.texture, {
              model: active.variant === "SLIM" ? "slim" : "default",
            }).catch(() => {});
          }
        }).catch(() => {
          if (viewer) {
            viewer.loadSkin(getDummySkinDataUrl(offlineDummyVariant()), { model: "default" }).catch(() => {});
          }
        });
      }
    } else {
      const offSkin = activeOfflineSkin();
      if (offSkin) {
        viewer.loadSkin(offSkin.texture, { model: offSkin.variant === "SLIM" ? "slim" : "default" }).catch(() => {});
      } else {
        const v = offlineDummyVariant();
        viewer.loadSkin(getDummySkinDataUrl(v), { model: v === "SLIM" ? "slim" : "default" }).catch(() => {});
      }
    }
  };

  onMount(() => {
    if (!canvasRef || !containerRef) return;

    const rect = containerRef.getBoundingClientRect();
    const width = Math.max(200, Math.round(rect.width || 340));
    const height = Math.max(200, Math.round(rect.height || 250));

    viewer = new SkinViewer({
      canvas: canvasRef,
      width,
      height,
      skin: undefined,
    });

    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.controls.enableRotate = true;

    // Framing: 0.74 zoom delivers a bold, heroic, and detailed player model
    // with comfortable margins around both the head and the hexagonal podium
    viewer.playerObject.rotation.y = -0.28;
    viewer.zoom = 0.74;

    // Hexagonal figurine pedestal under the model (identical to Skins screen).
    // Base sitting at y = -17.0 and rim at y = -16.1 just touching the foot plane (-16).
    const platform = new Group();
    const base = new Mesh(
      new CylinderGeometry(7, 8, 1.5, 6),
      new MeshBasicMaterial({ color: 0x1d1b24 }),
    );
    base.position.y = -17.0;

    rimMesh = new Mesh(
      new CylinderGeometry(8.2, 8.2, 0.3, 6),
      new MeshBasicMaterial({ color: getAccentHex() }),
    );
    rimMesh.position.y = -16.1;

    platform.add(base);
    platform.add(rimMesh);
    viewer.scene.add(platform);

    // Continuous idle breathing animation
    viewer.animation = new IdleAnimation();

    computeCanvasSize();
    const ro = new ResizeObserver(computeCanvasSize);
    ro.observe(containerRef);

    setViewerReady(true);
    loadActiveSkin();
    loadActiveCape();

    onCleanup(() => {
      ro.disconnect();
      stopCapeAnimation();
      capeAnimator = undefined;
      viewer?.dispose();
      viewer = undefined;
    });
  });

  // Keep rim mesh accent color synchronized with dynamic themes
  createEffect(() => {
    if (!rimMesh) return;
    const color = getAccentHex();
    rimMesh.material.color.setHex(color);
  });

  // Re-load skin when reactive dependencies change
  createEffect(() => {
    if (!viewerReady()) return;
    account();
    activeSkinUrl();
    activeOfflineSkin();
    offlineDummyVariant();
    void props.skinUrl;
    loadActiveSkin();
  });

  // Re-load cape when reactive dependencies change
  createEffect(() => {
    if (!viewerReady()) return;
    activeCape();
    void props.capeUrl;
    loadActiveCape();
  });

  // Pause render loop and cape animator when game is running to save CPU/GPU
  createEffect(() => {
    const running = gameRunning();
    if (!viewer) return;
    if (viewer.animation) {
      viewer.animation.paused = running;
    }
    if (running) {
      stopCapeAnimation();
    } else {
      const cape = activeCape();
      if (cape?.type === "custom" && cape.customCape?.transform?.animated) {
        startCapeAnimation(cape.customCape);
      }
    }
  });

  return (
    <div
      ref={containerRef}
      class={`character-stage-container ${props.class ?? ""}`}
      aria-label="Interactive 3D character, click and drag to rotate"
    >
      <canvas ref={canvasRef} class="character-stage-canvas" />
    </div>
  );
};

export default CharacterStage;
