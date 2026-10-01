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
} from "../App";
import { getSkinProfile } from "../ipc/commands";

interface Props {
  skinUrl?: string | null;
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

    onCleanup(() => {
      ro.disconnect();
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

  // Pause render loop when game is running to save CPU/GPU
  createEffect(() => {
    const running = gameRunning();
    if (!viewer || !viewer.animation) return;
    viewer.animation.paused = running;
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
