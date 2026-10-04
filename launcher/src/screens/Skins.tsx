// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createResource, createEffect, onCleanup, onMount, Show, For } from "solid-js";
import { account, refetchAccount, showToast, refreshActiveSkin, setActiveSkinUrl, getDummySkinDataUrl, activeOfflineSkin, setActiveOfflineSkin, offlineDummyVariant, setOfflineDummyVariant, setDockHidden, setActiveScreen, currentTheme } from "../App";
import { getThemeDefinition } from "../lib/theme";
import {
  getSkinProfile,
  uploadSkin,
  resetSkin,
  equipCape,
  unequipCape,
  listLocalSkins,
  addLocalSkin,
  equipLocalSkin,
  removeLocalSkin,
  syncCraftySkins,
  listCustomCapes,
  removeCustomCape,
  readCustomCapeSource,
  setIngameCape,
  setIngameCapeEnabled,
  clearIngameCape,
  getIngameCape,
  startMsLogin,
  PlayerProfile,
  LocalSkin,
  CustomCape,
  SkinVariant,
} from "../ipc/commands";
import { SkinViewer, IdleAnimation, PlayerObject } from "skinview3d";
import {
  CylinderGeometry,
  MeshBasicMaterial,
  Mesh,
  Group,
} from "three";
import {
  IconUpload,
  IconReload,
  IconTrash2,
  IconPlus,
  IconMinus,
  IconEdit,
  IconX,
  IconCheck,
  IconRotateCcw,
  IconMaximize2,
  IconMinimize2,
  IconMicrosoft,
  IconUser,
} from "../components/Icons";
import CapeChipThumb from "../components/CapeChipThumb";
import SkinAvatar from "../components/SkinAvatar";
import CustomCapeEditor from "../modals/CustomCapeEditor";
import {
  CapeAnimator,
  FrameSource,
  bakeModCapeStrip,
  clampRes,
  clampScale,
  clampRot,
  ANIMATED_MAX_RES,
} from "../lib/cape";
import { normalizeHex } from "../lib/color";

/**
 * Idle animation with a subtle elytra breath.
 *
 * Extends skinview3d's IdleAnimation (the slow arm + cape sway) and, only when
 * the elytra is the active back-equipment, breathes the wings on the same slow
 * tempo so they read as alive instead of frozen — without ever spreading. The
 * body never leaves the upright idle stance — this is deliberately NOT the
 * flight pose.
 *
 * Wing angles come straight from the model's own joints: the folded rest is 15°
 * (0.2617994 rad) on the z axis. The breath flexes them a few degrees above
 * that rest and back, never opening anywhere near the flight spread (90°).
 */
class IdleElytraAnimation extends IdleAnimation {
  protected animate(player: PlayerObject): void {
    // Keep the normal idle body sway (arms, cape).
    super.animate(player);

    // Wings are only visible when the elytra is equipped — skip the work
    // (and leave the joints untouched) when the cape or nothing is shown.
    if (!player.elytra.visible) return;

    const FOLDED = 0.2617994; // 15° — the model's resting wing fold

    // Continuous breath, matched to the body's idle tempo. skinview3d's idle
    // arms/cape use `sin(progress) * small`, period 2π ≈ 6.3 s; we ride the
    // same `progress` so the flex syncs with the rest of the body. AMP is
    // ~2.3°, picked to be visibly alive but well under any "spreading" read,
    // and the (1 - cos)/2 form keeps the wings at-or-above FOLDED so they
    // never close tighter than the rest pose.
    const AMP = 0.04;
    const z = FOLDED + AMP * (1 - Math.cos(this.progress)) / 2;

    player.elytra.leftWing.rotation.x = FOLDED;
    player.elytra.leftWing.rotation.y = 0.01; // model's tiny offset to avoid z-fighting
    player.elytra.leftWing.rotation.z = z;
    player.elytra.updateRightWing();
  }
}

/**
 * Skin & cape changer — cinematic hero canvas redesign.
 *
 * The 3D model is the centerpiece. All chrome (variant toggle, action
 * buttons, cape gallery, saved skin library, carousel arrows) floats over
 * the canvas as glass overlays and auto-hides 1.5 s after the last mouse
 * movement, returning the screen to "just the model" at rest.
 *
 * Microsoft accounts only — offline accounts hit the disabled state since
 * Mojang has no concept of their UUID and any upload would 401.
 *
 * Texture pipeline: every skin / cape texture arrives from the backend as
 * a base64 `data:image/png;` URL. The webview never makes a request to
 * `textures.minecraft.net`, so there are no CORS or http/https scheme
 * issues — drop the data URL straight into skinview3d.
 */

// In-game cape state + the selected custom cape live at MODULE scope so they
// survive the screen remounting on navigation (the screen is mounted via
// `<Show>`, which unmounts it when you leave). Keeping them local caused a
// flicker: on every remount the selection reset to null, briefly highlighting
// "No cape" until the async state load resolved. Module scope + a one-time load
// means re-entering the screen reflects the real state immediately.
const [activeCustomCapeId, setActiveCustomCapeId] = createSignal<string | null>(null);
const [ingameCapeId, setIngameCapeId] = createSignal<string | null>(null);
const [ingameEnabled, setIngameEnabled] = createSignal(false);
let ingameStateLoaded = false;

/**
 * Read a CSS variable from document.documentElement or fall back to a known theme value.
 */
const getThemeHex = (varName: string, fallback: string): string => {
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (val.startsWith("#")) return val;
  } catch {}
  return fallback;
};

/**
 * High-performance square voxel ember particle background for the Character Studio.
 * Features 3 depth parallax tiers, vertical edge fading, and responsive cursor repulsion.
 */
function initStageParticles(canvas: HTMLCanvasElement, container: HTMLElement): () => void {
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return () => {};

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return () => {};

  let W = 0;
  let H = 0;
  let raf = 0;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const COUNT = 85;
  const getThemeParticleColors = (): string[] => {
    try {
      const theme = currentTheme();
      const def = getThemeDefinition(theme);
      const accent = getThemeHex("--accent", def.primaryColor);
      if (accent.startsWith("#")) {
        const hex = accent.replace("#", "");
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
          return [
            `${r}, ${g}, ${b}`,
            `${Math.min(255, Math.round(r * 1.15))}, ${Math.min(255, Math.round(g * 1.15))}, ${Math.min(255, Math.round(b * 1.15))}`,
            `${Math.max(0, Math.round(r * 0.85))}, ${Math.max(0, Math.round(g * 0.85))}, ${Math.max(0, Math.round(b * 0.85))}`,
          ];
        }
      }
    } catch {}
    return [
      "139, 92, 246",
      "168, 85, 247",
      "192, 132, 252",
    ];
  };
  const GOLD_COLS = [
    "250, 204, 21",  // Warm bright gold
    "251, 191, 36",  // Radiant amber
    "245, 158, 11",  // Deep honey amber
    "253, 224, 71",  // Incandescent yellow spark
    "254, 240, 138", // White-gold shimmer
  ];

  interface VoxelEmber {
    x: number;
    y: number;
    sz: number;
    vx: number;
    vy: number;
    bvx: number;
    bvy: number;
    baseAlpha: number;
    layer: number;
    col: string;
    isGold: boolean;
    flickerPhase: number;
    flickerSpeed: number;
  }

  const pickColor = (): { col: string; isGold: boolean } => {
    const isGold = Math.random() < 0.32;
    const themeCols = getThemeParticleColors();
    const col = isGold
      ? GOLD_COLS[Math.floor(Math.random() * GOLD_COLS.length)]
      : themeCols[Math.floor(Math.random() * themeCols.length)];
    return { col, isGold };
  };

  const makePt = (initial = false): VoxelEmber => {
    // 3 depth layers: 0 (distant), 1 (midground), 2 (foreground)
    const roll = Math.random();
    let layer = 1;
    let sz = 3;
    let vy = rnd(-0.20, -0.38);
    let vx = rnd(-0.08, 0.08);
    let baseAlpha = rnd(0.35, 0.55);

    if (roll < 0.45) {
      // Distant layer: smaller, slower, softer
      layer = 0;
      sz = 2;
      vy = rnd(-0.10, -0.22);
      vx = rnd(-0.05, 0.05);
      baseAlpha = rnd(0.20, 0.38);
    } else if (roll > 0.78) {
      // Foreground layer: larger, faster, bolder
      layer = 2;
      sz = Math.random() > 0.5 ? 4 : 5;
      vy = rnd(-0.38, -0.65);
      vx = rnd(-0.12, 0.12);
      baseAlpha = rnd(0.55, 0.80);
    }

    const { col, isGold } = pickColor();
    // Warm gold embers receive a slight brightness boost to read as incandescent sparks
    if (isGold) {
      baseAlpha = Math.min(0.88, baseAlpha * 1.2);
    }

    return {
      x: rnd(0, W || 400),
      y: initial ? rnd(0, H || 500) : (H || 500) + rnd(4, 20),
      sz,
      vx,
      vy,
      bvx: vx,
      bvy: vy,
      baseAlpha,
      layer,
      col,
      isGold,
      flickerPhase: rnd(0, Math.PI * 2),
      flickerSpeed: rnd(0.02, 0.06),
    };
  };

  const pts: VoxelEmber[] = [];

  const resize = () => {
    const rect = container.getBoundingClientRect();
    const oldW = W;
    const oldH = H;
    W = rect.width;
    H = rect.height;
    if (W <= 0 || H <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // If particles were initialized before layout measurement, distribute across canvas
    if (oldW <= 0 || oldH <= 0) {
      for (const p of pts) {
        p.x = rnd(0, W);
        p.y = rnd(0, H);
      }
    }
  };

  resize();
  for (let i = 0; i < COUNT; i++) {
    pts.push(makePt(true));
  }

  const ro = new ResizeObserver(() => {
    resize();
  });
  ro.observe(container);

  // Mouse repulsion
  const REPEL_RADIUS = 125;
  const REPEL_FORCE = 0.88;
  let mouseX = -9999;
  let mouseY = -9999;
  let mouseActive = false;

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const rect = container.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    mouseActive = true;
  };

  const onPointerLeave = () => {
    mouseActive = false;
  };

  container.addEventListener("pointermove", onPointerMove, { passive: true });
  container.addEventListener("pointerleave", onPointerLeave, { passive: true });

  const frame = () => {
    if (W <= 0 || H <= 0) {
      raf = requestAnimationFrame(frame);
      return;
    }

    ctx.clearRect(0, 0, W, H);

    for (const p of pts) {
      if (mouseActive) {
        const dx = p.x - mouseX;
        const dy = p.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < REPEL_RADIUS && dist > 0.01) {
          const layerMultiplier = 0.75 + p.layer * 0.35;
          const push = (1 - dist / REPEL_RADIUS) * REPEL_FORCE * layerMultiplier;
          p.vx += (dx / dist) * push;
          p.vy += (dy / dist) * push;
        }
      }

      // Ease back toward base lazy drift
      p.vx += (p.bvx - p.vx) * 0.035;
      p.vy += (p.bvy - p.vy) * 0.035;

      p.x += p.vx;
      p.y += p.vy;

      // Wrap-around
      if (p.y < -12) {
        p.y = H + rnd(4, 16);
        p.x = rnd(0, W);
        // Refresh color choice on re-wrap to maintain even, dynamic distribution
        const fresh = pickColor();
        p.col = fresh.col;
        p.isGold = fresh.isGold;
      }
      if (p.x < -12) p.x = W + 12;
      if (p.x > W + 12) p.x = -12;

      // Edge fading: fade in smoothly near bottom, fade out near top
      let edgeFade = 1;
      if (p.y > H - 50) {
        edgeFade = Math.max(0, (H - p.y) / 50);
      } else if (p.y < 50) {
        edgeFade = Math.max(0, p.y / 50);
      }

      // Subtle atmospheric shimmer
      p.flickerPhase += p.flickerSpeed;
      const shimmer = 1 + Math.sin(p.flickerPhase) * 0.14;
      const alpha = Math.min(1, Math.max(0, p.baseAlpha * edgeFade * shimmer));
      if (alpha <= 0.01) continue;

      const sz = p.sz;
      // Snapped to integer pixels for crisp square voxel edges
      const px = Math.round(p.x - sz / 2);
      const py = Math.round(p.y - sz / 2);

      ctx.fillStyle = `rgba(${p.col},${alpha.toFixed(3)})`;
      ctx.fillRect(px, py, sz, sz);
    }

    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    ro.disconnect();
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerleave", onPointerLeave);
  };
}

const Skins: Component = () => {
  const isOfflineAccount = () => !account();
  const [loggingIn, setLoggingIn] = createSignal(false);

  const [profile, { refetch: refetchProfile }] = createResource(
    () => account(),
    async (): Promise<PlayerProfile | null> => {
      try {
        return await getSkinProfile();
      } catch (e) {
        if (account()) {
          showToast({ title: "Couldn't load profile", message: String(e), type: "error" });
        }
        return null;
      }
    }
  );

  const [localSkins, { refetch: refetchLocal }] = createResource(
    () => account(),
    async () => {
      try {
        return await listLocalSkins();
      } catch {
        return [];
      }
    }
  );

  // Selected skin variant. Starts `null` (unknown) rather than defaulting to
  // a concrete value: the screen fully remounts on every navigation, and the
  // profile loads asynchronously, so a hardcoded default would flash the wrong
  // toggle as "active" for a frame before the profile resolves. While null,
  // neither toggle is highlighted — the profile-load effect sets the real
  // variant once it arrives.
  const [variant, setVariant] = createSignal<SkinVariant | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [capeCooldownUntil, setCapeCooldownUntil] = createSignal(0);
  const isCapeOnCooldown = () => Date.now() < capeCooldownUntil();
  const [showElytra, setShowElytra] = createSignal(false);

  // Local custom capes (display-only — never sent to Mojang). `activeCustomCapeId`
  // is the cape currently shown on the model; when set it overrides the Mojang
  // cape in the display effect. Selecting a Mojang cape or "No cape" clears it.
  const [customCapes, { refetch: refetchCustomCapes }] = createResource<CustomCape[]>(async () => {
    try {
      return await listCustomCapes();
    } catch {
      return [];
    }
  });
  const [showCapeEditor, setShowCapeEditor] = createSignal(false);
  const [editingCape, setEditingCape] = createSignal<CustomCape | null>(null);
  // In-game cape (companion mod): `ingameCapeId`/`ingameEnabled` are module-scope
  // (above) so they persist across remounts; `ingameBusy` is transient per-mount.
  const [ingameBusy, setIngameBusy] = createSignal(false);

  // Active skin texture, handed to the cape editor so its 3D preview shows the
  // user's own body instead of an empty stand.
  const activeSkinTexture = (): string | undefined => {
    const p = profile();
    const a = p?.skins.find((s) => s.state === "ACTIVE") ?? p?.skins[0];
    if (a?.texture) return a.texture;
    if (activeOfflineSkin()) return activeOfflineSkin()!.texture;
    if (isOfflineAccount()) return getDummySkinDataUrl(variant() ?? "CLASSIC");
    const local = localSkins();
    if (local && local.length > 0) return local[0].texture;
    return undefined;
  };

  // Zen mode: hides side panels for an unobstructed character showcase view.
  const [zenMode, setZenMode] = createSignal(false);

  // Canvas crossfade flag — toggles a brief opacity drop while a new texture
  // loads so the swap reads as a soft transition, not a hard cut.
  const [canvasFading, setCanvasFading] = createSignal(false);

  let fileInputRef: HTMLInputElement | undefined;
  let viewerCanvas: HTMLCanvasElement | undefined;
  let particleCanvas: HTMLCanvasElement | undefined;
  let viewer: SkinViewer | undefined;
  let stageEl: HTMLDivElement | undefined;
  let baseMaterial: MeshBasicMaterial | undefined;
  let rimMaterial: MeshBasicMaterial | undefined;

  // Manual zoom for the player model. skinview3d's `zoom` is a camera-distance
  // factor (higher = closer / bigger model). We keep wheel-zoom off the
  // built-in OrbitControls and drive a single signal instead, so the +/-
  // buttons and the scroll wheel share one clamped source of truth. 0.62 is
  // the default framing that fits the model + pedestal at every idle angle.
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 1.8;
  const ZOOM_STEP = 0.16;
  const ZOOM_DEFAULT = 0.62;
  const [zoomLevel, setZoomLevel] = createSignal(ZOOM_DEFAULT);
  const applyZoom = (z: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    setZoomLevel(clamped);
    if (viewer) viewer.zoom = clamped;
  };
  const zoomIn = () => applyZoom(zoomLevel() + ZOOM_STEP);
  const zoomOut = () => applyZoom(zoomLevel() - ZOOM_STEP);
  const resetZoom = () => applyZoom(ZOOM_DEFAULT);
  const onStageWheel = (e: WheelEvent) => {
    e.preventDefault();
    // deltaY > 0 = scroll down = zoom out. Scale by a small factor for a
    // smooth feel regardless of the device's wheel granularity.
    applyZoom(zoomLevel() - e.deltaY * 0.0012);
  };

  // Animated custom capes drive a live frame loop instead of a static texture.
  // We keep one animator for the main viewer and track which cape it's playing
  // so the display effect can re-run (e.g. on elytra toggle) without restarting
  // it. `getParams` reads the live transform + elytra each frame.
  let capeAnimator: CapeAnimator | undefined;
  let animatorCapeId: string | null = null;

  const ensureAnimator = (): CapeAnimator => {
    if (!capeAnimator) {
      capeAnimator = new CapeAnimator(viewer!, () => {
        const live = (customCapes() ?? []).find((c) => c.id === animatorCapeId);
        const t = live?.transform;
        return {
          dx: t?.dx ?? 0,
          dy: t?.dy ?? 0,
          scale: clampScale(t?.scale),
          rot: clampRot(t?.rot),
          bg: normalizeHex(t?.bg, "#2b2740"),
          res: clampRes(t?.res),
          solid: t?.solid ?? false,
          elytra: showElytra(),
        };
      });
    }
    return capeAnimator;
  };

  const startCapeAnimation = async (cape: CustomCape) => {
    animatorCapeId = cape.id; // mark up-front so re-runs don't double-start
    try {
      const src = await readCustomCapeSource(cape.id);
      if (animatorCapeId !== cape.id || !viewer) return; // superseded while fetching
      await ensureAnimator().start(src);
    } catch (e) {
      console.error("Animated cape failed, falling back to static frame:", e);
      // Fall back to the stored poster texture so the cape still shows.
      try {
        viewer?.loadCape(cape.texture, { backEquipment: showElytra() ? "elytra" : "cape" });
      } catch {
        // viewer gone; ignore
      }
    }
  };

  const stopCapeAnimation = () => {
    capeAnimator?.stop();
    animatorCapeId = null;
  };

  // Size the canvas to a PORTRAIT rect that scales with the stage height.
  // A humanoid model is ~2x taller than its max rotational width, so a tall
  // narrow canvas fills with the model (appears large) instead of wasting
  // horizontal space like a square would, and lets the side docks sit close.
  // Height drives the size and grows with the window; width is 80% of height,
  // chosen to fit an open elytra spread (each wing tip lands roughly ±13.5
  // world units at the idle flutter's apex, vs ±6 for the body alone) with a
  // small margin. A tighter ratio looked great with just the skin but clipped
  // the wings on every flutter peak.
  const computeCanvasSize = () => {
    if (!viewer || !stageEl) return;
    const rect = stageEl.getBoundingClientRect();
    const h = Math.min(rect.height * 0.96, 880);
    const w = Math.min(rect.width, h * 0.8);
    if (h > 0 && w > 0) viewer.setSize(Math.round(w), Math.round(h));
  };

  onMount(() => {
    if (!viewerCanvas) return;
    viewer = new SkinViewer({
      canvas: viewerCanvas,
      width: 400,
      height: 520,
      skin: undefined,
    });
    viewer.animation = new IdleElytraAnimation();
    viewer.controls.enableZoom = false;
    // Zoom out from the default (0.9) so the full model — plus the pedestal
    // below the feet — fits with margin. At 0.9 the model nearly fills the
    // canvas height, so rotating it (arms/legs swinging out) or the added
    // platform clipped at the frame edges. The manual zoom controls let the
    // user push in past this; ZOOM_DEFAULT leaves comfortable headroom at
    // every angle as the starting framing.
    viewer.zoom = zoomLevel();

    // Hexagonal figurine pedestal under the model. Two stacked discs:
    // a chunky dark base and a thinner accent rim sitting on top.
    //
    // Coordinate system (traced from skinview3d's PlayerObject): the skin is
    // offset +8 inside the player, legs sit at y=-12 and extend ~12 units
    // down, so the FEET BOTTOM lands at scene Y ≈ -16. Y=0 is chest/waist
    // height (which is why a platform at y≈0 floated at the chest). Place the
    // pedestal so the rim's top surface meets the foot plane at -16.
    const theme = currentTheme();
    const def = getThemeDefinition(theme);
    const accent = getThemeHex("--accent", def.primaryColor);
    const panel = getThemeHex("--surface-panel", "#1d1b24");

    const platform = new Group();
    baseMaterial = new MeshBasicMaterial({ color: panel });
    const base = new Mesh(
      // radiusTop, radiusBottom, height, 6 sides for a chunky hex pedestal
      new CylinderGeometry(7, 8, 1.5, 6),
      baseMaterial,
    );
    base.position.y = -17.0; // top surface at -16.25, just below the feet
    rimMaterial = new MeshBasicMaterial({ color: accent });
    const rim = new Mesh(
      new CylinderGeometry(8.2, 8.2, 0.3, 6),
      rimMaterial,
    );
    rim.position.y = -16.1; // sits on the base, top surface ≈ foot plane (-16)
    platform.add(base);
    platform.add(rim);
    viewer.scene.add(platform);

    computeCanvasSize();
    const ro = new ResizeObserver(computeCanvasSize);
    if (stageEl) ro.observe(stageEl);
    onCleanup(() => ro.disconnect());

    if (particleCanvas && stageEl) {
      const destroyParticles = initStageParticles(particleCanvas, stageEl);
      onCleanup(destroyParticles);
    }
  });

  // Dynamically synchronize the 3D pedestal base and accent rim with the active theme.
  createEffect(() => {
    const theme = currentTheme();
    if (!baseMaterial || !rimMaterial) return;
    const def = getThemeDefinition(theme);
    const accent = getThemeHex("--accent", def.primaryColor);
    const panel = getThemeHex("--surface-panel", "#1d1b24");
    rimMaterial.color.set(accent);
    baseMaterial.color.set(panel);
  });

  // Auto-hide the floating dock while on the Skins screen so the Character Studio
  // and pedestal remain unobstructed. Reveals when the cursor nears bottom.
  createEffect(() => {
    setDockHidden(true);
  });
  onCleanup(() => setDockHidden(false));

  onCleanup(() => {
    stopCapeAnimation();
    baseMaterial?.dispose();
    rimMaterial?.dispose();
    baseMaterial = undefined;
    rimMaterial = undefined;
    viewer?.dispose();
    viewer = undefined;
  });

  // Push the active skin into the 3D viewer whenever the profile or offline skin changes.
  // Wraps the load in a brief opacity fade for the cinematic swap. The cape is
  // loaded by a separate effect so toggling cape/elytra never reloads the skin.
  createEffect(() => {
    if (!viewer) return;
    const isOffline = isOfflineAccount();
    if (isOffline) {
      const offSkin = activeOfflineSkin();
      if (offSkin) {
        setVariant(offSkin.variant);
        setCanvasFading(true);
        try {
          viewer.loadSkin(offSkin.texture, {
            model: offSkin.variant === "SLIM" ? "slim" : "default",
          });
        } catch (e) {
          console.error("Offline skin load failed:", e);
        }
        window.setTimeout(() => setCanvasFading(false), 250);
      } else {
        const v = variant() ?? offlineDummyVariant();
        setVariant(v);
        setCanvasFading(true);
        try {
          viewer.loadSkin(getDummySkinDataUrl(v), {
            model: v === "SLIM" ? "slim" : "default",
          });
        } catch (e) {
          console.error("Dummy skin load failed:", e);
        }
        window.setTimeout(() => setCanvasFading(false), 250);
      }
      return;
    }

    const p = profile();
    if (!p) return;

    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (active) {
      setVariant(active.variant);
      setCanvasFading(true);
      try {
        viewer.loadSkin(active.texture, {
          model: active.variant === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Skin load failed:", e);
      }
      // 250 ms: long enough to read as a fade, short enough not to feel slow.
      window.setTimeout(() => setCanvasFading(false), 250);
    }
  });

  // Show the active cape on the model whenever the profile or the cape/elytra
  // toggle changes. Only the back-equipment swaps between "cape" and "elytra";
  // the model keeps its idle animation with no flying pose or transition, so
  // the elytra simply appears on the player's back.
  createEffect(() => {
    const elytra = showElytra();
    const customId = activeCustomCapeId();
    const caps = customCapes();
    const p = profile();
    if (!viewer) return;

    const cc = customId ? (caps ?? []).find((c) => c.id === customId) : undefined;

    // Animated custom cape → drive the live frame loop. The animator reads the
    // elytra toggle live each frame, so a re-run from toggling elytra must NOT
    // restart it — only (re)start when the target cape actually changes.
    if (cc && cc.transform.animated) {
      if (animatorCapeId !== cc.id) {
        stopCapeAnimation();
        startCapeAnimation(cc);
      }
      return;
    }

    // Not an animated custom cape — make sure any running animation is stopped
    // before we paint a static texture.
    stopCapeAnimation();

    // A locally-selected static custom cape wins over the Mojang cape — it's a
    // display-only override that lives entirely in the viewer.
    if (cc) {
      // Rendered with skinview3d's default nearest filtering (crisp texels)
      // so the cape's baked resolution shows as a real pixel grid, matching
      // the editor preview. loadCape is async for a data-URL source, so
      // guard the returned promise's rejection.
      const r = viewer.loadCape(cc.texture, {
        backEquipment: elytra ? "elytra" : "cape",
      }) as unknown as Promise<unknown> | undefined;
      if (r && typeof (r as { then?: unknown }).then === "function") {
        r.catch((e) => console.error("Custom cape load failed:", e));
      }
      return;
    }

    const activeCape = p?.capes.find((c) => c.state === "ACTIVE");
    if (activeCape) {
      try {
        viewer.loadCape(activeCape.texture, {
          backEquipment: elytra ? "elytra" : "cape",
        });
      } catch (e) {
        console.error("Cape load failed:", e);
      }
    } else {
      viewer.resetCape();
    }
  });

  // Re-load skin on local variant toggle (Classic ↔ Slim).
  createEffect(() => {
    const v = variant();
    const p = profile();
    if (!viewer) return;
    if (isOfflineAccount()) {
      const offSkin = activeOfflineSkin();
      if (offSkin) {
        try {
          viewer.loadSkin(offSkin.texture, {
            model: v === "SLIM" ? "slim" : "default",
          });
        } catch (e) {
          console.error("Variant switch failed:", e);
        }
      } else {
        const targetV = v ?? "CLASSIC";
        try {
          viewer.loadSkin(getDummySkinDataUrl(targetV), {
            model: targetV === "SLIM" ? "slim" : "default",
          });
        } catch (e) {
          console.error("Dummy variant switch failed:", e);
        }
      }
      return;
    }
    if (!p) return;
    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (active) {
      try {
        viewer.loadSkin(active.texture, {
          model: v === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Variant switch failed:", e);
      }
    }
  });

  // ─── Actions ───

  const handleStartLogin = async () => {
    if (loggingIn()) return;
    setLoggingIn(true);
    try {
      await startMsLogin();
      await refetchAccount();
      await refetchProfile();
      await refetchLocal();
      await refetchCustomCapes();
      showToast({ title: "Account connected", message: "Signed in with Microsoft", type: "success" });
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Login failed";
      if (msg !== "Login cancelled") {
        showToast({ title: "Sign-in failed", message: msg, type: "error" });
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const handleUpload = () => fileInputRef?.click();

  const handleFileSelected = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    setBusy("upload");
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const name = file.name.replace(/\.png$/i, "") || "Custom skin";
      // Fall back to Classic if the profile hasn't resolved the variant yet
      // (variant() is null until then). In practice the profile is loaded by
      // the time the user can click Upload.
      const v = variant() ?? "CLASSIC";

      if (isOfflineAccount()) {
        const newLocal = await addLocalSkin(name, bytes, v);
        await refetchLocal();
        setActiveOfflineSkin(newLocal);
        if (viewer) {
          setCanvasFading(true);
          try {
            viewer.loadSkin(newLocal.texture, {
              model: v === "SLIM" ? "slim" : "default",
            });
          } catch (e) {
            console.error("Local skin preview failed:", e);
          }
          window.setTimeout(() => setCanvasFading(false), 250);
        }
        showToast({
          title: "Skin imported",
          message: `${name} (${v === "SLIM" ? "Slim" : "Classic"}) saved to wardrobe`,
          type: "success",
        });
        return;
      }

      await uploadSkin(bytes, v, true, name);
      await refetchLocal();
      await refetchProfile();
      await refreshActiveSkin();
      showToast({
        title: "Skin equipped",
        message: `${name} (${v === "SLIM" ? "Slim" : "Classic"})`,
        type: "success",
      });
    } catch (err) {
      showToast({ title: "Skin upload failed", message: String(err), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy("reset");
    try {
      if (isOfflineAccount()) {
        setActiveOfflineSkin(null);
        setOfflineDummyVariant("CLASSIC");
        setVariant("CLASSIC");
        setActiveSkinUrl(null);
        if (viewer) {
          viewer.loadSkin(getDummySkinDataUrl("CLASSIC"), {
            model: "default",
          });
        }
        showToast({ title: "Skin reset to default dummy", type: "success" });
        return;
      }
      await resetSkin();
      await refetchProfile();
      await refreshActiveSkin();
      showToast({ title: "Skin reset to default", type: "success" });
    } catch (e) {
      showToast({ title: "Reset failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async () => {
    setBusy("refresh");
    try {
      if (!isOfflineAccount()) {
        await refetchProfile();
      }
      await refetchLocal();
      await refetchCustomCapes();
      showToast({ title: "Character studio refreshed", type: "info", autoCloseMs: 1500 });
    } finally {
      setBusy(null);
    }
  };

  const handleSyncHistory = async () => {
    if (busy() !== null) return;
    if (isOfflineAccount()) {
      showToast({
        title: "Microsoft account required",
        message: "Skin history sync from Crafty.gg requires an official Minecraft account.",
        type: "info",
      });
      return;
    }
    setBusy("sync");
    try {
      const res = await syncCraftySkins();
      await refetchLocal();
      if (res.added > 0) {
        showToast({
          title: "Skins synced",
          message: `Imported ${res.added} previous skin${res.added === 1 ? "" : "s"} from Crafty.gg`,
          type: "success",
        });
      } else if (res.total > 0) {
        showToast({
          title: "Wardrobe up to date",
          message: `All ${res.total} skins from your account history are already saved.`,
          type: "info",
        });
      } else {
        showToast({
          title: "No skin history",
          message: "No previous skins found on Crafty.gg for this account.",
          type: "info",
        });
      }
    } catch (e) {
      showToast({
        title: "Sync failed",
        message: String(e),
        type: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleEquipLocal = async (skin: LocalSkin) => {
    if (busy() !== null) return;
    // Optimistic crossfade: swap the canvas texture immediately so the click
    // reads as instant. The Mojang upload runs in the background; the
    // profile-change effect later reaffirms with the same texture data, so
    // there's no flicker from the eventual round-trip.
    if (viewer) {
      setCanvasFading(true);
      try {
        viewer.loadSkin(skin.texture, {
          model: skin.variant === "SLIM" ? "slim" : "default",
        });
        setVariant(skin.variant);
      } catch (e) {
        console.error("Optimistic skin preview failed:", e);
      }
      window.setTimeout(() => setCanvasFading(false), 250);
    }

    if (isOfflineAccount()) {
      setActiveOfflineSkin(skin);
      showToast({ title: `${skin.name} previewed`, type: "success" });
      return;
    }

    setBusy(`equip-${skin.hash}`);
    try {
      await equipLocalSkin(skin.hash);
      await refetchProfile();
      await refreshActiveSkin();
      showToast({ title: `${skin.name} equipped`, type: "success" });
    } catch (e) {
      showToast({ title: "Equip failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveLocal = async (skin: LocalSkin) => {
    setBusy(`remove-${skin.hash}`);
    try {
      await removeLocalSkin(skin.hash);
      if (activeOfflineSkin()?.hash === skin.hash) {
        setActiveOfflineSkin(null);
        setActiveSkinUrl(null);
        const v = variant() ?? offlineDummyVariant();
        if (viewer) {
          viewer.loadSkin(getDummySkinDataUrl(v), {
            model: v === "SLIM" ? "slim" : "default",
          });
        }
      }
      await refetchLocal();
    } catch (e) {
      showToast({ title: "Remove failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleVariantSwitch = async (newVariant: SkinVariant) => {
    if (newVariant === variant()) return;

    if (isOfflineAccount()) {
      setVariant(newVariant);
      setOfflineDummyVariant(newVariant);
      if (!activeOfflineSkin()) {
        setActiveSkinUrl(null);
      }
      if (viewer) {
        const offSkin = activeOfflineSkin();
        if (offSkin) {
          try {
            viewer.loadSkin(offSkin.texture, {
              model: newVariant === "SLIM" ? "slim" : "default",
            });
          } catch (e) {
            console.error("Variant switch failed:", e);
          }
        } else {
          try {
            viewer.loadSkin(getDummySkinDataUrl(newVariant), {
              model: newVariant === "SLIM" ? "slim" : "default",
            });
          } catch (e) {
            console.error("Dummy variant switch failed:", e);
          }
        }
      }
      showToast({
        title: "Variant changed",
        message: newVariant === "SLIM" ? "Slim (3px arms)" : "Classic (4px arms)",
        type: "success",
        autoCloseMs: 2000,
      });
      return;
    }

    const p = profile();
    if (!p) return;
    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (!active) return;

    setVariant(newVariant);
    setBusy("variant");
    try {
      // active.texture is already a base64 data URL; pass it directly without decoding and re-encoding.
      await uploadSkin(active.texture, newVariant, false);
      await refetchProfile();
      await refreshActiveSkin();
      showToast({
        title: "Variant changed",
        message: newVariant === "SLIM" ? "Slim (3px arms)" : "Classic (4px arms)",
        type: "success",
        autoCloseMs: 2000,
      });
    } catch (e) {
      showToast({ title: "Variant switch failed", message: String(e), type: "error" });
      const p2 = profile();
      if (p2) {
        const act = p2.skins.find((s) => s.state === "ACTIVE") ?? p2.skins[0];
        if (act) setVariant(act.variant);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleEquipCape = async (capeId: string | null) => {
    // Selecting a Mojang cape (or "No cape") clears any local custom cape
    // override and turns the in-game custom cape off, so the launcher selection
    // and what shows in-game stay in sync.
    if (ingameBusy()) return;
    setActiveCustomCapeId(null);
    if (ingameEnabled()) {
      try {
        await setIngameCapeEnabled(false);
        setIngameEnabled(false);
      } catch {
        // best-effort
      }
    }

    if (isOfflineAccount()) {
      viewer?.resetCape();
      return;
    }

    if (isCapeOnCooldown()) {
      showToast({
        title: "Slow down",
        message: "Mojang rate-limits cape changes. Wait a moment between switches.",
        type: "info",
        autoCloseMs: 3000,
      });
      return;
    }
    setBusy(`cape-${capeId ?? "none"}`);
    try {
      if (capeId) await equipCape(capeId);
      else await unequipCape();
      await refetchProfile();
      setCapeCooldownUntil(Date.now() + 3000);
    } catch (e) {
      showToast({ title: "Cape change failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  // ─── Custom capes ───

  const openNewCape = () => {
    setEditingCape(null);
    setShowCapeEditor(true);
  };

  const openEditCape = (cape: CustomCape) => {
    setEditingCape(cape);
    setShowCapeEditor(true);
  };

  const handleCapeSaved = async (cape: CustomCape) => {
    await refetchCustomCapes();
    // Saving equips the cape everywhere: show it on the model and (re)apply it
    // in-game from the just-saved transform, so a resolution / position / bg edit
    // takes effect in the game too — not only in the viewer.
    setActiveCustomCapeId(cape.id);
    setIngameBusy(true);
    try {
      const { png, frameTimeMs } = await bakeForIngame(cape);
      await setIngameCape(cape.id, png, frameTimeMs);
      setIngameCapeId(cape.id);
      setIngameEnabled(true);
    } catch (e) {
      showToast({ title: "Couldn't apply cape in-game", message: String(e), type: "error" });
    } finally {
      setIngameBusy(false);
    }
  };

  const handleEquipCustomCape = async (id: string) => {
    if (ingameBusy()) return;
    // Clicking the active cape again unequips it (viewer + in-game), like
    // clicking an equipped cape to take it off.
    if (activeCustomCapeId() === id) {
      setActiveCustomCapeId(null);
      if (ingameEnabled()) {
        setIngameBusy(true);
        try {
          await setIngameCapeEnabled(false);
          setIngameEnabled(false);
        } catch (e) {
          showToast({ title: "Couldn't remove in-game cape", message: String(e), type: "error" });
        } finally {
          setIngameBusy(false);
        }
      }
      return;
    }
    // Equip: show in the viewer immediately, then apply it in-game (bake +
    // store). On supported instances the cape appears in-game on next launch
    // (or live, if one is running).
    setActiveCustomCapeId(id);
    const cape = (customCapes() ?? []).find((c) => c.id === id);
    if (!cape) return;
    setIngameBusy(true);
    try {
      const { png, frameTimeMs } = await bakeForIngame(cape);
      await setIngameCape(id, png, frameTimeMs);
      setIngameCapeId(id);
      setIngameEnabled(true);
      showToast({
        title: "Cape equipped",
        message: "Applies in-game on launch (Fabric on MC 26.x or 1.21.11).",
        type: "success",
        autoCloseMs: 3000,
      });
    } catch (e) {
      showToast({ title: "In-game cape failed", message: String(e), type: "error" });
    } finally {
      setIngameBusy(false);
    }
  };

  const handleRemoveCustomCape = async (id: string) => {
    setBusy(`ccape-${id}`);
    try {
      await removeCustomCape(id);
      if (activeCustomCapeId() === id) setActiveCustomCapeId(null);
      // If this cape was the in-game one, clear that too so it doesn't linger.
      if (ingameCapeId() === id) {
        try {
          await clearIngameCape();
        } catch {
          // best-effort
        }
        setIngameCapeId(null);
        setIngameEnabled(false);
      }
      await refetchCustomCapes();
    } catch (e) {
      showToast({ title: "Remove failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  // ─── In-game cape (companion mod) ───

  // Load the current in-game cape state once, and reflect it in the selection
  // so the dock shows the enabled cape as active (no "nothing selected but still
  // on" desync when re-entering the screen).
  onMount(async () => {
    if (ingameStateLoaded) return; // module-scope state persists across remounts
    try {
      const st = await getIngameCape();
      setIngameCapeId(st?.cape_id ?? null);
      setIngameEnabled(st?.enabled ?? false);
      if (st?.enabled && st.cape_id) setActiveCustomCapeId(st.cape_id);
      ingameStateLoaded = true;
    } catch {
      // Leave it off; retry on the next mount.
    }
  });

  /** Bake a custom cape into the mod's frame-strip layout and return IPC-ready bytes. */
  const bakeForIngame = async (cape: CustomCape) => {
    const sourceUrl = await readCustomCapeSource(cape.id);
    const src = await FrameSource.load(sourceUrl);
    try {
      const t = cape.transform;
      // Cap animated strips so a high-res, many-frame GIF doesn't decode to a
      // huge texture (OOM risk). Matches the editor's animated res ceiling.
      const res = src.frameCount > 1 ? Math.min(clampRes(t.res), ANIMATED_MAX_RES) : clampRes(t.res);
      const bake = bakeModCapeStrip(src, {
        dx: t.dx,
        dy: t.dy,
        scale: clampScale(t.scale),
        rot: clampRot(t.rot),
        bg: normalizeHex(t.bg, "#2b2740"),
        res,
        solid: t.solid ?? false,
      });
      return { png: bake.png, frameTimeMs: bake.frames > 1 ? bake.frameTimeMs : null };
    } finally {
      src.dispose();
    }
  };

  // ─── Render ───

  return (
    <div class="screen-enter skins-screen">
      {/* Offline preview banner: informs user of local-only state and provides quick sign-in actions */}
      <Show when={isOfflineAccount()}>
        <div class="skins-offline-banner">
          <div class="skins-offline-banner-content">
            <span class="tag-offline">OFFLINE PREVIEW</span>
            <span class="skins-offline-banner-text">
              Skins & capes rendered locally on this device. Official multiplayer sync requires a Microsoft account.
            </span>
          </div>
          <div class="skins-offline-actions">
            <button
              class="skins-banner-btn skins-banner-btn--primary"
              onClick={handleStartLogin}
              disabled={loggingIn()}
            >
              <IconMicrosoft />
              <span>{loggingIn() ? "Signing in…" : "Sign in with Microsoft"}</span>
            </button>
            <button
              class="skins-banner-btn"
              onClick={() => setActiveScreen("account")}
            >
              <IconUser />
              <span>Manage Accounts</span>
            </button>
          </div>
        </div>
      </Show>

      {/* Hidden file picker driven by the Upload button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png"
        style="display:none"
        onChange={handleFileSelected}
      />

      <div class="skins-studio" classList={{ "zen-mode": zenMode() }}>
        {/* Left Panel: Wardrobe & Local Skins */}
        <div class="skins-panel skins-panel-wardrobe">
          <div class="skins-panel-header">
            <div class="skins-panel-title-wrap">
              <span class="card-section-tag tag-settings-skins">WARDROBE</span>
              <span class="skins-count-badge">{(localSkins() ?? []).length}</span>
            </div>
            <div class="skins-panel-actions">
              <button
                class="skins-mini-btn tip-below"
                data-tip="Sync from Crafty.gg"
                onClick={handleSyncHistory}
                disabled={busy() !== null}
              >
                <IconReload class={busy() === "sync" ? "icon-spin" : undefined} />
                <span>{busy() === "sync" ? "Syncing…" : "Sync"}</span>
              </button>
              <button
                class="skins-mini-btn"
                onClick={handleUpload}
                disabled={busy() !== null}
              >
                <IconUpload />
                <span>{busy() === "upload" ? "Importing…" : "Import"}</span>
              </button>
            </div>
          </div>

          <div class="skins-panel-body">
            <Show
              when={(localSkins() ?? []).length > 0}
              fallback={
                <div class="skins-empty-wardrobe">
                  <div class="skins-empty-wardrobe-title">No skins saved</div>
                  <div class="skins-empty-wardrobe-text">
                    Import a .png skin or save skins to your local wardrobe.
                  </div>
                  <div class="skins-empty-wardrobe-actions">
                    <button
                      class="skins-action-btn skins-action-btn--primary"
                      onClick={handleUpload}
                      disabled={busy() !== null}
                    >
                      <IconUpload />
                      <span>Import Skin</span>
                    </button>
                    <Show when={!isOfflineAccount()}>
                      <button
                        class="skins-action-btn skins-action-btn--secondary"
                        onClick={handleSyncHistory}
                        disabled={busy() !== null}
                      >
                        <IconReload class={busy() === "sync" ? "icon-spin" : undefined} />
                        <span>{busy() === "sync" ? "Syncing History…" : "Sync Previous Skins"}</span>
                      </button>
                    </Show>
                  </div>
                </div>
              }
            >
                <div class="skins-lib-list">
                  <For each={localSkins() ?? []}>
                    {(skin) => {
                      const isActive = () => {
                        if (isOfflineAccount()) {
                          if (activeOfflineSkin()) {
                            return activeOfflineSkin()!.hash === skin.hash;
                          }
                          return false;
                        }
                        const p = profile();
                        const a = p?.skins.find((s) => s.state === "ACTIVE") ?? p?.skins[0];
                        return a?.texture === skin.texture;
                      };
                      return (
                        <div
                          class="skins-lib-card"
                          classList={{ active: isActive() }}
                          onClick={() => handleEquipLocal(skin)}
                        >
                          <div class="skins-lib-card-preview">
                            <SkinAvatar
                              texture={skin.texture}
                              variant={skin.variant as "CLASSIC" | "SLIM" | "Unknown"}
                              size={48}
                            />
                          </div>
                          <div class="skins-lib-card-info">
                            <div class="skins-lib-card-name">
                              {skin.name}
                            </div>
                            <div class="skins-lib-card-meta">
                              <span class="skins-variant-pill">
                                {skin.variant === "SLIM" ? "Slim 3px" : "Classic 4px"}
                              </span>
                              <Show when={isActive()}>
                                <span class="skins-active-indicator">
                                  <IconCheck /> Active
                                </span>
                              </Show>
                            </div>
                          </div>
                          <div class="skins-lib-card-actions">
                            <button
                              class="skins-lib-btn-delete tip-right"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveLocal(skin);
                              }}
                              disabled={busy() !== null}
                              data-tip="Delete"
                            >
                              <IconTrash2 />
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>

          {/* Center: Figurine Studio Stage */}
          <div class="skins-stage-container">
            {/* Top Studio Bar */}
            <div class="skins-stage-topbar">
              <div class="skins-topbar-left">
                <div class="skins-studio-identity">
                  <span class="skins-studio-title-text">Character Studio</span>
                  <span class="beta-pill">Beta</span>
                </div>
              </div>

              <div class="skins-topbar-center">
                <div class="skins-segmented-switch">
                  <button
                    class="skins-segment-btn"
                    classList={{ active: variant() === "CLASSIC" }}
                    disabled={busy() !== null}
                    onClick={() => handleVariantSwitch("CLASSIC")}
                  >
                    Classic
                  </button>
                  <button
                    class="skins-segment-btn"
                    classList={{ active: variant() === "SLIM" }}
                    disabled={busy() !== null}
                    onClick={() => handleVariantSwitch("SLIM")}
                  >
                    Slim
                  </button>
                </div>
              </div>

              <div class="skins-topbar-right">
                <button
                  class="skins-studio-btn"
                  onClick={handleReset}
                  disabled={busy() !== null}
                >
                  <IconRotateCcw />
                  <span>Reset</span>
                </button>
                <button
                  class="skins-studio-btn"
                  onClick={handleRefresh}
                  disabled={busy() !== null}
                >
                  <IconReload />
                  <span>Refresh</span>
                </button>
                <button
                  class="skins-studio-btn skins-zen-btn"
                  classList={{ active: zenMode() }}
                  onClick={() => setZenMode(!zenMode())}
                >
                  {zenMode() ? <IconMinimize2 /> : <IconMaximize2 />}
                  <span>{zenMode() ? "Exit Zen" : "Zen"}</span>
                </button>
              </div>
            </div>

            {/* 3D Canvas Stage */}
            <div class="skins-stage" ref={stageEl} onWheel={onStageWheel}>
              <canvas
                ref={particleCanvas}
                class="skins-particle-canvas"
                aria-hidden="true"
              />
              <canvas
                ref={viewerCanvas}
                class="skins-hero-canvas"
                classList={{ fading: canvasFading() }}
              />
            </div>

            {/* Bottom Stage Footer */}
            <div class="skins-stage-footer">
              <span class="skins-stage-hint">Drag to rotate · Scroll to zoom</span>
              <div class="skins-zoom-cluster">
                <button
                  class="skins-zoom-btn"
                  onClick={zoomIn}
                  disabled={zoomLevel() >= ZOOM_MAX}
                  data-tip="Zoom in"
                >
                  <IconPlus />
                </button>
                <button
                  class="skins-zoom-btn"
                  onClick={zoomOut}
                  disabled={zoomLevel() <= ZOOM_MIN}
                  data-tip="Zoom out"
                >
                  <IconMinus />
                </button>
                <button
                  class="skins-zoom-btn tip-right"
                  onClick={resetZoom}
                  data-tip="Reset zoom"
                >
                  <IconRotateCcw />
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel: Equipment & Capes */}
          <div class="skins-panel skins-panel-equipment">
            <div class="skins-panel-header">
              <div class="skins-panel-title-wrap">
                <span class="card-section-tag tag-settings-video">EQUIPMENT</span>
                <span class="skins-panel-title">Capes & Wings</span>
                <span class="skins-count-badge">
                  {(profile()?.capes ?? []).length + (customCapes() ?? []).length}
                </span>
              </div>
            </div>

            <div class="skins-panel-body">
              {/* Wear/Display Mode: Cape vs Elytra */}
              <div class="skins-equipment-mode-bar">
                <span class="skins-equipment-mode-label">Wear as</span>
                <div class="skins-segmented-switch skins-segmented-switch--sm">
                  <button
                    class="skins-segment-btn"
                    classList={{ active: !showElytra() }}
                    onClick={() => setShowElytra(false)}
                  >
                    Cape
                  </button>
                  <button
                    class="skins-segment-btn"
                    classList={{ active: showElytra() }}
                    onClick={() => setShowElytra(true)}
                  >
                    Elytra
                  </button>
                </div>
              </div>

              {/* Mojang Capes */}
              <div class="skins-equipment-section">
                <div class="skins-section-subhead">Mojang Capes</div>
                <div class="skins-cape-grid">
                  {/* No cape */}
                  <button
                    class="skins-cape-tile"
                    classList={{
                      active:
                        !activeCustomCapeId() &&
                        !profile()?.capes.some((c) => c.state === "ACTIVE"),
                    }}
                    onClick={() => handleEquipCape(null)}
                    disabled={busy() !== null}
                  >
                    <div class="skins-cape-none-icon">
                      <IconX />
                    </div>
                    <span class="skins-cape-label">None</span>
                  </button>

                  {/* Mojang-granted capes */}
                  <For each={profile()?.capes ?? []}>
                    {(cape, idx) => {
                      const isEquipped = () =>
                        !activeCustomCapeId() && cape.state === "ACTIVE";
                      const col = (idx() + 1) % 3;
                      const tipPos = col === 0 ? "tip-below tip-left" : col === 2 ? "tip-below tip-right" : "tip-below";
                      return (
                        <button
                          class={`skins-cape-tile ${tipPos}`}
                          classList={{ active: isEquipped() }}
                          onClick={() => handleEquipCape(cape.id)}
                          disabled={busy() !== null}
                          data-tip={cape.alias}
                        >
                          <div class="skins-cape-tile-thumb">
                            <CapeChipThumb texture={cape.texture} withElytra={true} />
                          </div>
                          <span class="skins-cape-label">{cape.alias}</span>
                          <Show when={isEquipped()}>
                            <span class="skins-tile-equipped-dot" />
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
                <Show when={isOfflineAccount()}>
                  <div class="skins-cape-offline-hint">
                    Official Mojang capes require signing in with Microsoft.
                  </div>
                </Show>
              </div>

              {/* Custom In-Game Capes */}
              <div class="skins-equipment-section">
                <div class="skins-section-subhead-row">
                  <div class="skins-section-subhead">
                    In-Game Capes <span class="skins-subhead-badge">Companion</span>
                  </div>
                  <button
                    class="skins-mini-btn"
                    onClick={openNewCape}
                    disabled={busy() !== null}
                  >
                    <IconPlus />
                    <span>New</span>
                  </button>
                </div>

                <Show
                  when={(customCapes() ?? []).length > 0}
                  fallback={
                    <div class="skins-empty-capes">
                      <p>No custom capes yet</p>
                      <button
                        class="skins-action-btn skins-action-btn--secondary"
                        onClick={openNewCape}
                        disabled={busy() !== null}
                      >
                        <IconPlus />
                        <span>Create Custom Cape</span>
                      </button>
                    </div>
                  }
                >
                  <div class="skins-custom-cape-list">
                    <For each={customCapes() ?? []}>
                      {(cape) => {
                        const isEquipped = () => activeCustomCapeId() === cape.id;
                        return (
                          <div
                            class="skins-custom-cape-card"
                            classList={{ active: isEquipped() }}
                            onClick={() => {
                              if (busy() === null && !ingameBusy()) {
                                handleEquipCustomCape(cape.id);
                              }
                            }}
                          >
                            <div class="skins-custom-cape-thumb">
                              <CapeChipThumb texture={cape.texture} />
                            </div>
                            <div class="skins-custom-cape-info">
                              <div class="skins-custom-cape-name">{cape.name}</div>
                              <div class="skins-custom-cape-meta">
                                <Show when={cape.transform?.animated}>
                                  <span class="skins-animated-badge">Animated</span>
                                </Show>
                                <Show when={isEquipped()}>
                                  <span class="skins-active-indicator">
                                    <IconCheck /> Equipped
                                  </span>
                                </Show>
                              </div>
                            </div>
                            <div
                              class="skins-custom-cape-actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                class="skins-lib-btn tip-right"
                                onClick={() => openEditCape(cape)}
                                disabled={busy() !== null}
                                data-tip="Edit"
                              >
                                <IconEdit />
                              </button>
                              <button
                                class="skins-lib-btn-delete tip-right"
                                onClick={() => handleRemoveCustomCape(cape.id)}
                                disabled={busy() !== null}
                                data-tip="Delete"
                              >
                                <IconTrash2 />
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </div>

        <Show when={showCapeEditor()}>
          <CustomCapeEditor
            editing={editingCape()}
            skinTexture={activeSkinTexture()}
            onClose={() => setShowCapeEditor(false)}
            onSaved={handleCapeSaved}
          />
        </Show>
    </div>
  );
};

export default Skins;
