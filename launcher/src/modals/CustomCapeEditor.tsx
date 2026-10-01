// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import { SkinViewer } from "skinview3d";
import { saveCustomCape, readCustomCapeSource, CustomCape, CapeTransform } from "../ipc/commands";
import { showToast } from "../App";
import Dropdown from "../components/Dropdown";
import ColorPicker from "../components/ColorPicker";
import { normalizeHex } from "../lib/color";
import { IconRotate, IconUpload, IconCheck } from "../components/Icons";
import {
  PANEL,
  clampRes,
  clampScale,
  clampRot,
  computeBaseFit,
  bakeCape,
  drawPlacedImage,
  FrameSource,
  ANIMATED_MAX_RES,
  SCALE_STEPS,
  posToScale,
  scaleToPos,
  snapAngle,
} from "../lib/cape";

/**
 * Custom cape editor — a local, display-only cape designer.
 *
 * The user uploads a static image and positions/scales it onto the cape's
 * visible back panel. The result is baked into a standard 64×32 Minecraft
 * cape texture and stored in the per-account cape library; it's never sent to
 * Mojang (their API rejects arbitrary cape textures), so this lives purely in
 * our 3D viewer.
 *
 * ## Geometry
 *
 * skinview3d's `CapeObject` maps the cape box from a 64×32 atlas, and the
 * `PlayerObject` attaches it with `rotation.y = Math.PI`. After that flip, the
 * face an observer sees when looking at the player's back is the box's local
 * +z ("front") face, which `setCapeUVs(0,0,10,16,1)` places at texture rect
 * `(1, 1)` size `10×16` — the same rect Minecraft itself uses for the visible
 * cape art. That rect — `PANEL` below — is where the uploaded image lands.
 * The rest of the cape footprint (`0,0 → 22,17`) is filled with a solid
 * background colour so no cape face renders transparent.
 *
 * ## Transform
 *
 * Position/scale are tracked in panel-texel space (the panel is 10×16), so the
 * 2D workspace and the baked texture use identical maths — the workspace just
 * multiplies everything by `DISP` for display. `dw/dh` come from a contain-fit
 * baseline (`baseDw/baseDh`, derived from the image aspect) times `scale`.
 */

// Display magnification for the 2D workspace. The workspace shows the cape as
// an unfolded cross-net — the front panel plus the 1-texel side/top/bottom
// faces around it (12×18 texels) — so 20px keeps it compact and balanced with
// the 3D preview beside it.
const DISP = 20;
// Bake-resolution choices: multiplier of the 64×32 atlas → baked texture size.
// 1× is the classic pixelated cape; 32× (2048×1024) is the sharpest the
// backend accepts. skinview3d renders whatever resolution we hand it.
const RES_OPTIONS = [
  { value: "1", label: "Standard — 64×32" },
  { value: "2", label: "128×64" },
  { value: "4", label: "256×128" },
  { value: "8", label: "512×256" },
  { value: "16", label: "HD — 1024×512" },
  { value: "32", label: "Max HD — 2048×1024" },
];
const DEFAULT_BG = "#2b2740";

/** Readout for the scale slider: 0.85×, 2.4×, 12× — no trailing zeros. */
const fmtScale = (s: number) =>
  s < 10 ? s.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(s));

interface Props {
  /** Existing cape to re-edit, or null/undefined to create a new one. */
  editing?: CustomCape | null;
  /** Active skin texture (data URL) so the 3D preview shows the user's body. */
  skinTexture?: string;
  onClose: () => void;
  onSaved: (cape: CustomCape) => void;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** A 1×1 PNG of `color`. Solid capes have no uploaded image, but the backend
 *  stores a source for round-tripping — re-edit reads the colour from the
 *  transform, so this is just a valid placeholder. */
function makeSolidSourcePng(color: string): Uint8Array {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
  }
  return dataUrlToBytes(c.toDataURL("image/png"));
}

const CustomCapeEditor: Component<Props> = (props) => {
  const [name, setName] = createSignal(props.editing?.name ?? "Custom Cape");
  // Normalized on load: a stored transform is an opaque blob to the backend, and
  // canvas `fillStyle` silently ignores an invalid colour (keeping whatever was
  // set before) rather than erroring, so a bad value would be hard to trace.
  const [bg, setBg] = createSignal<string>(normalizeHex(props.editing?.transform.bg, DEFAULT_BG));
  // Cape type: a solid colour fill, or an uploaded image/animation. Solid capes
  // are just `bg` with no image (the editor hides the image controls).
  const [solid, setSolid] = createSignal<boolean>(props.editing?.transform.solid ?? false);
  const [scale, setScale] = createSignal<number>(clampScale(props.editing?.transform.scale));
  // Clockwise rotation of the placed image, in degrees.
  const [rot, setRot] = createSignal<number>(clampRot(props.editing?.transform.rot));
  const [res, setRes] = createSignal<number>(clampRes(props.editing?.transform.res));
  const [hasImage, setHasImage] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  // Whether the loaded source is an animated GIF / APNG / WebP — drives a live
  // frame loop instead of a one-shot bake.
  const [isAnimated, setIsAnimated] = createSignal(false);

  // Animated capes are capped at ANIMATED_MAX_RES to bound the decoded texture
  // size (memory). Only offer the allowed multipliers for animated sources, and
  // clamp a higher saved/selected value down — so the preview never shows a
  // resolution the game won't actually use.
  const resChoices = () =>
    isAnimated() ? RES_OPTIONS.filter((o) => parseInt(o.value, 10) <= ANIMATED_MAX_RES) : RES_OPTIONS;
  createEffect(() => {
    if (isAnimated() && res() > ANIMATED_MAX_RES) {
      setRes(ANIMATED_MAX_RES);
      refresh();
    }
  });

  // Image position offset within the panel, in panel-texel units.
  let dx = props.editing?.transform.dx ?? 0;
  let dy = props.editing?.transform.dy ?? 0;
  // Contain-fit baseline draw size (recomputed whenever an image loads).
  let baseDw = PANEL.w;
  let baseDh = PANEL.h;

  let frameSrc: FrameSource | null = null;
  let sourceBytes: Uint8Array | null = null;
  let sourceMime = "image/png";

  let workspaceCanvas: HTMLCanvasElement | undefined;
  let previewCanvas: HTMLCanvasElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let viewer: SkinViewer | undefined;
  // Reused offscreen canvas for the HD bake — avoids allocating one per drag
  // frame. Passed straight to loadCape (a canvas is a TextureSource, so the
  // load is synchronous with no per-frame PNG encode/decode).
  let bakeCanvas: HTMLCanvasElement | undefined;

  // ─── Compositing ───

  /** Bake the full cape texture into the reused offscreen canvas via the shared
   *  compositor. Returns the canvas, or null when no image is loaded yet. */
  const bakeCapeCanvas = (): HTMLCanvasElement | null => {
    if (!frameSrc && !solid()) return null;
    const c = bakeCanvas ?? (bakeCanvas = document.createElement("canvas"));
    bakeCape(c, solid() ? null : frameSrc!.current(), frameSrc?.width ?? 1, frameSrc?.height ?? 1, {
      dx,
      dy,
      scale: scale(),
      rot: rot(),
      bg: bg(),
      res: res(),
      solid: solid(),
    });
    return c;
  };

  /** Push the freshly-baked cape into the 3D preview. Passing the canvas
   *  (not a data URL) keeps loadCape synchronous, so dragging stays smooth.
   *  Rendered with skinview3d's default nearest filtering so each cape texel
   *  is a crisp block — the chosen resolution then directly controls how
   *  pixelated the cape looks, matching how the game draws cape textures. */
  const updatePreview = () => {
    if (!viewer) return;
    const cv = bakeCapeCanvas();
    if (!cv) {
      viewer.resetCape();
      return;
    }
    try {
      viewer.loadCape(cv, { backEquipment: "cape" });
    } catch (e) {
      console.error("Cape preview failed:", e);
    }
  };
  // The workspace shows the cape unfolded as a cross-net: the front panel in
  // the centre, with the 1-texel side/top/bottom faces around it. Because
  // those faces sit adjacent to the front here, a single continuous image draw
  // (at the front's position, offset by the net's 1-texel border) previews
  // exactly how the art wraps onto each face in the bake. The corners and the
  // inner/back face aren't part of the net — they stay background.
  const NET_W = PANEL.w + 2; // left + front + right  = 12
  const NET_H = PANEL.h + 2; // top  + front + bottom = 18
  const FX = 1; // front-panel offset within the net, in texels
  const FY = 1;

  const redrawWorkspace = () => {
    const cv = workspaceCanvas;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = NET_W * DISP;
    const H = NET_H * DISP;
    ctx.clearRect(0, 0, W, H);

    // The cross shape: a full-width band for left+front+right, plus the top and
    // bottom strips above/below the front. Used for both the bg fill and the
    // image clip so only the real faces are painted (corners stay transparent).
    const crossPath = () => {
      ctx.beginPath();
      ctx.rect(0, FY * DISP, NET_W * DISP, PANEL.h * DISP); // left+front+right band
      ctx.rect(FX * DISP, 0, PANEL.w * DISP, FY * DISP); // top strip
      ctx.rect(FX * DISP, (FY + PANEL.h) * DISP, PANEL.w * DISP, DISP); // bottom strip
    };

    // Background fill across the cross.
    ctx.save();
    crossPath();
    ctx.clip();
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);

    // Positioned image — drawn once at the front's position (shifted by the
    // net border). The clip keeps it inside the cross; the edge faces show the
    // image's continuation past the front, matching the baked cape.
    if (frameSrc) {
      const dw = baseDw * scale() * DISP;
      const dh = baseDh * scale() * DISP;
      drawPlacedImage(
        ctx,
        frameSrc.current(),
        (FX + dx) * DISP,
        (FY + dy) * DISP,
        dw,
        dh,
        rot(),
      );
    }
    ctx.restore();

    // Guide grid — one line per texel across the net.
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= NET_W; gx++) {
      ctx.beginPath();
      ctx.moveTo(gx * DISP + 0.5, 0);
      ctx.lineTo(gx * DISP + 0.5, H);
      ctx.stroke();
    }
    for (let gy = 0; gy <= NET_H; gy++) {
      ctx.beginPath();
      ctx.moveTo(0, gy * DISP + 0.5);
      ctx.lineTo(W, gy * DISP + 0.5);
      ctx.stroke();
    }

    // Outline the front panel so it's clear which region is the visible face
    // vs the thin wrap edges around it.
    ctx.strokeStyle = "rgba(139,92,246,0.9)"; // --accent
    ctx.lineWidth = 2;
    ctx.strokeRect(FX * DISP, FY * DISP, PANEL.w * DISP, PANEL.h * DISP);
  };

  const refresh = () => {
    redrawWorkspace(); // cheap (220×352) — keep immediate so dragging feels live
    schedulePreview(); // expensive (HD bake + GPU upload) — coalesce to one/frame
  };

  // The 3D preview re-bakes an HD texture and re-uploads it to the GPU, which
  // is too heavy to run on every pointermove/slider tick (a 32× cape is a
  // 2048×1024 texture). Coalesce updates to at most one per animation frame.
  let previewRaf = 0;
  const schedulePreview = () => {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      updatePreview();
    });
  };

  // Animation loop for animated sources (GIF / APNG / WebP). The source <img>
  // advances frames natively; we re-bake the current frame and re-draw the
  // workspace at a capped rate so the editor previews the motion. Throttled to
  // ~24fps to bound the per-frame HD re-upload.
  let animRaf = 0;
  let animLast = 0;
  const ANIM_FPS = 24;
  const animTick = (ts: number) => {
    animRaf = requestAnimationFrame(animTick);
    if (ts - animLast < 1000 / ANIM_FPS) return;
    animLast = ts;
    redrawWorkspace();
    updatePreview();
  };
  const startAnim = () => {
    if (!animRaf) animRaf = requestAnimationFrame(animTick);
  };
  const stopAnim = () => {
    if (animRaf) {
      cancelAnimationFrame(animRaf);
      animRaf = 0;
    }
  };

  // ─── Upload ───

  const handleUploadClick = () => fileInput?.click();

  const loadImageFromDataUrl = async (dataUrl: string): Promise<void> => {
    // FrameSource decodes animated formats into discrete frames (reliable on
    // WebView2) or wraps a still image. Dispose the previous one first.
    frameSrc?.dispose();
    frameSrc = await FrameSource.load(dataUrl);
    const fit = computeBaseFit(frameSrc.width, frameSrc.height);
    baseDw = fit.baseDw;
    baseDh = fit.baseDh;
  };

  const handleFileSelected = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      sourceBytes = new Uint8Array(buf);
      sourceMime = file.type || "image/png";
      const reader = new FileReader();
      const dataUrl: string = await new Promise((res, rej) => {
        reader.onload = () => res(reader.result as string);
        reader.onerror = () => rej(new Error("File read failed"));
        reader.readAsDataURL(file);
      });
      await loadImageFromDataUrl(dataUrl);
      // Reset position/scale to a centred fit for the new image.
      dx = (PANEL.w - baseDw) / 2;
      dy = (PANEL.h - baseDh) / 2;
      setScale(1);
      setRot(0);
      setHasImage(true);
      // Drive a live frame loop for animated sources; a static one bakes once.
      const animated = frameSrc?.animated ?? false;
      setIsAnimated(animated);
      if (animated) startAnim();
      else stopAnim();
      if (!name().trim() || name() === "Custom Cape") {
        const stem = file.name.replace(/\.[^.]+$/, "");
        if (stem) setName(stem);
      }
      refresh();
    } catch (err) {
      showToast({ title: "Couldn't load image", message: String(err), type: "error" });
    }
  };

  // ─── Drag to position ───

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    dx += (e.clientX - lastX) / DISP;
    dy += (e.clientY - lastY) / DISP;
    lastX = e.clientX;
    lastY = e.clientY;
    refresh();
  };

  const onPointerUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const onWorkspacePointerDown = (e: PointerEvent) => {
    if (!frameSrc) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onWorkspaceWheel = (e: WheelEvent) => {
    if (!frameSrc) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.08 : -0.08;
    handleScale(clampScale(scale() + step));
  };

  const handleScale = (v: number) => {
    setScale(v);
    refresh();
  };

  const handleRot = (v: number) => {
    setRot(clampRot(v));
    refresh();
  };

  /** Quarter-turn step — the common case (uprighting a portrait/landscape
   *  source) is fiddly to hit by dragging a 0–359 slider. */
  const rotateQuarter = () => handleRot(rot() + 90);

  const handleBg = (v: string) => {
    setBg(v);
    refresh();
  };

  /** Switch between a solid-colour cape and an image/animated cape. */
  const setMode = (asSolid: boolean) => {
    setSolid(asSolid);
    refresh();
  };

  const handleRes = (v: string) => {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) {
      setRes(n);
      refresh();
    }
  };

  const handleCenter = () => {
    if (!frameSrc) return;
    dx = (PANEL.w - baseDw * scale()) / 2;
    dy = (PANEL.h - baseDh * scale()) / 2;
    refresh();
  };

  // ─── Save ───

  const handleSave = async () => {
    if (!solid() && (!frameSrc || !sourceBytes)) {
      showToast({ title: "Add an image first", type: "info" });
      return;
    }
    const cv = bakeCapeCanvas();
    if (!cv) {
      showToast({ title: "Couldn't render cape", type: "error" });
      return;
    }
    const baked = cv.toDataURL("image/png");
    // Solid capes have no uploaded image — store a 1×1 colour swatch as the
    // source so the backend round-trips something; re-edit reads the colour
    // from the transform.
    const srcBytes = solid() ? makeSolidSourcePng(bg()) : sourceBytes!;
    const srcMime = solid() ? "image/png" : sourceMime;
    setSaving(true);
    try {
      const transform: CapeTransform = {
        dx,
        dy,
        scale: scale(),
        rot: rot(),
        bg: bg(),
        res: res(),
        animated: !solid() && isAnimated(),
        solid: solid(),
      };
      const cape = await saveCustomCape(
        props.editing?.id ?? null,
        name().trim() || "Custom Cape",
        baked,
        srcBytes,
        srcMime,
        transform,
      );
      showToast({ title: "Cape saved", message: cape.name, type: "success" });
      props.onSaved(cape);
      props.onClose();
    } catch (e) {
      showToast({ title: "Save failed", message: String(e), type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // ─── Lifecycle ───

  onMount(async () => {
    if (previewCanvas) {
      viewer = new SkinViewer({ canvas: previewCanvas, width: 240, height: 360 });
      viewer.controls.enableZoom = false;
      viewer.zoom = 0.78;
      // Rotate the body so the cape's outer face points at the camera.
      viewer.playerObject.rotation.y = Math.PI;
      if (props.skinTexture) {
        try {
          viewer.loadSkin(props.skinTexture);
        } catch (e) {
          console.error("Preview skin load failed:", e);
        }
      }
    }

    // Re-editing: pull the stored source image on demand (it isn't inlined in
    // the cape list) and reapply the saved transform. Solid capes have no real
    // image — just restore the colour/mode from the transform.
    if (props.editing) {
      if (props.editing.transform.solid) {
        setSolid(true);
      } else {
        try {
          const sourceUrl = await readCustomCapeSource(props.editing.id);
          await loadImageFromDataUrl(sourceUrl);
          // computeBaseFit set baseDw/baseDh; the stored dx/dy/scale are in the
          // same panel-texel space so they reapply directly.
          sourceBytes = dataUrlToBytes(sourceUrl);
          sourceMime = sourceUrl.slice(5, sourceUrl.indexOf(";"));
          const animated = frameSrc?.animated ?? false;
          setIsAnimated(animated);
          if (animated) startAnim();
          setHasImage(true);
        } catch (e) {
          console.error("Failed to load cape for editing:", e);
          showToast({ title: "Couldn't load cape for editing", message: String(e), type: "error" });
        }
      }
    }
    refresh();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // If an inner popover (like the color picker) is open, let it handle Escape first
    if (document.querySelector(".color-picker-panel")) return;
    if (saving()) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    props.onClose();
  };

  window.addEventListener("keydown", onKeyDown, true);

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (previewRaf) cancelAnimationFrame(previewRaf);
    stopAnim();
    frameSrc?.dispose();
    viewer?.dispose();
    viewer = undefined;
  });

  return (
    <div
      class="modal-overlay cape-editor-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving()) {
          props.onClose();
        }
      }}
    >
      <div class="modal cape-editor-modal">
        {/* Header */}
        <div class="cape-editor-header">
          <div class="cape-editor-header-left">
            <span class="card-section-tag tag-settings-skins">CAPE STUDIO</span>
            <span class="cape-editor-title">
              {props.editing ? `Edit Cape: ${props.editing.name}` : "Design Custom Cape"}
            </span>
          </div>
        </div>

        <div class="modal-body cape-editor-body">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            style="display:none"
            onChange={handleFileSelected}
          />

          <div class="cape-editor-stage-grid">
            {/* 2D Positioning Workspace */}
            <div class="cape-stage-card">
              <div class="cape-stage-header">
                <div class="cape-stage-title-wrap">
                  <span class="cape-stage-tag">2D CANVAS NET</span>
                  <span class="cape-stage-hint">Drag to move · Scroll to scale</span>
                </div>
                <Show when={hasImage() && !solid()}>
                  <span class="skins-count-badge">{(PANEL.w + 2)}×{(PANEL.h + 2)}</span>
                </Show>
              </div>

              <div class="cape-stage-well cape-workspace-well">
                <canvas
                  ref={workspaceCanvas}
                  class="cape-workspace-canvas"
                  width={(PANEL.w + 2) * DISP}
                  height={(PANEL.h + 2) * DISP}
                  onPointerDown={onWorkspacePointerDown}
                  onWheel={onWorkspaceWheel}
                  style={{ cursor: hasImage() ? "move" : "default" }}
                />
                <Show when={!hasImage() && !solid()}>
                  <button class="cape-workspace-dropzone" onClick={handleUploadClick}>
                    <div class="cape-dropzone-icon">
                      <IconUpload />
                    </div>
                    <span class="cape-dropzone-title">Upload Image or GIF</span>
                    <span class="cape-dropzone-sub">PNG · JPG · GIF · WEBP</span>
                  </button>
                </Show>
              </div>
            </div>

            {/* Live 3D Preview */}
            <div class="cape-stage-card">
              <div class="cape-stage-header">
                <div class="cape-stage-title-wrap">
                  <span class="cape-stage-tag">3D FIGURINE PREVIEW</span>
                  <span class="cape-stage-hint">Drag to rotate stand</span>
                </div>
                <Show when={isAnimated() && !solid()}>
                  <span class="skins-animated-badge">Animated</span>
                </Show>
              </div>

              <div class="cape-stage-well cape-preview-well">
                <canvas ref={previewCanvas} class="cape-preview-canvas" />
              </div>
            </div>
          </div>

          {/* Controls Section */}
          <div class="cape-controls-section">
            {/* Top Properties Bar: Name & Mode Toggle */}
            <div class="cape-properties-bar">
              <div class="cape-prop-group cape-name-group">
                <label class="cape-prop-label">Cape Name</label>
                <input
                  class="cape-text-input"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="Custom Cape"
                />
              </div>

              <div class="cape-prop-group cape-mode-group">
                <label class="cape-prop-label">Cape Type</label>
                <div class="skins-segmented-switch">
                  <button
                    class="skins-segment-btn"
                    classList={{ active: !solid() }}
                    onClick={() => setMode(false)}
                  >
                    Image / Animated
                  </button>
                  <button
                    class="skins-segment-btn"
                    classList={{ active: solid() }}
                    onClick={() => setMode(true)}
                  >
                    Solid Color
                  </button>
                </div>
              </div>
            </div>

            {/* Solid Color Mode Settings */}
            <Show when={solid()}>
              <div class="cape-solid-settings-card">
                <div class="cape-solid-header">
                  <span class="cape-prop-label">Fabric Color</span>
                  <span class="cape-color-hex">{bg()}</span>
                </div>
                <div class="cape-color-row">
                  <ColorPicker value={bg()} onInput={handleBg} label="Cape colour" />
                  <div class="cape-color-hint">
                    Choose a base tint or custom shade. Renders as a clean solid cloth in-game and on your 3D model.
                  </div>
                </div>
              </div>
            </Show>

            {/* Image / Animated Mode Controls */}
            <Show when={!solid()}>
              {/* Action Toolbar */}
              <div class="cape-actions-toolbar">
                <div class="cape-toolbar-left">
                  <button class="skins-action-btn skins-action-btn--secondary cape-tool-btn" onClick={handleUploadClick}>
                    <IconUpload />
                    <span>{hasImage() ? "Replace File" : "Upload File"}</span>
                  </button>
                  <button
                    class="skins-action-btn skins-action-btn--secondary cape-tool-btn"
                    onClick={rotateQuarter}
                    disabled={!hasImage()}
                  >
                    <IconRotate />
                    <span>Rotate 90°</span>
                  </button>
                  <button
                    class="skins-action-btn skins-action-btn--secondary cape-tool-btn"
                    onClick={handleCenter}
                    disabled={!hasImage()}
                  >
                    <span>Center Art</span>
                  </button>
                </div>

                <div class="cape-toolbar-right">
                  <div class="cape-res-selector">
                    <label class="cape-prop-label">Export Resolution</label>
                    <Dropdown
                      value={String(res())}
                      options={resChoices()}
                      onChange={handleRes}
                      width="155px"
                      openUp
                    />
                  </div>
                </div>
              </div>

              {/* Sliders Grid */}
              <div class="cape-sliders-grid">
                {/* Scale Slider Plate */}
                <div class="cape-slider-plate" classList={{ disabled: !hasImage() }}>
                  <div class="cape-slider-header">
                    <span class="cape-slider-label">Scale Multiplier</span>
                    <span class="cape-slider-readout">{fmtScale(scale())}×</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={SCALE_STEPS}
                    step="1"
                    value={scaleToPos(scale())}
                    disabled={!hasImage()}
                    style={`--slider-pct:${(scaleToPos(scale()) / SCALE_STEPS) * 100}%`}
                    onInput={(e) => handleScale(posToScale(parseFloat(e.currentTarget.value)))}
                  />
                </div>

                {/* Rotation Slider Plate */}
                <div class="cape-slider-plate" classList={{ disabled: !hasImage() }}>
                  <div class="cape-slider-header">
                    <span class="cape-slider-label">Rotation Angle</span>
                    <span class="cape-slider-readout">{Math.round(rot())}°</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="359"
                    step="1"
                    value={rot()}
                    disabled={!hasImage()}
                    style={`--slider-pct:${(rot() / 359) * 100}%`}
                    onInput={(e) => handleRot(snapAngle(parseFloat(e.currentTarget.value)))}
                  />
                </div>
              </div>
            </Show>
          </div>
        </div>

        {/* Modal Footer */}
        <div class="cape-editor-footer">
          <div class="cape-footer-meta">
            <Show when={isAnimated() && !solid()}>
              <span class="skins-animated-badge">Animated</span>
            </Show>
            <Show when={solid()}>
              <span class="cape-format-pill">Solid Color</span>
            </Show>
            <span class="cape-format-pill">{res()}× Resolution</span>
            <Show when={hasImage() && !solid()}>
              <span class="cape-format-pill">{sourceMime.split("/")[1]?.toUpperCase() ?? "IMG"}</span>
            </Show>
          </div>

          <div class="cape-footer-actions">
            <button class="skins-action-btn skins-action-btn--secondary cape-footer-btn" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class="skins-action-btn skins-action-btn--primary cape-footer-btn"
              onClick={handleSave}
              disabled={(!solid() && !hasImage()) || saving()}
            >
              <IconCheck />
              <span>{saving() ? "Saving…" : "Save Cape"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CustomCapeEditor;
