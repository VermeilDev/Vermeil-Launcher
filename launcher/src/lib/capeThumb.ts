// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared offscreen renderer that turns a cape texture into a small 3D-model
 * thumbnail (the cape — or the elytra — as it looks on the player, front-on),
 * for the Skins screen's cape chips. Replaces the flat UV-atlas swatch that
 * looked like a texture map rather than a cape.
 *
 * One WebGL context is shared across every chip: browsers cap live WebGL
 * contexts (~16), so we can't give each chip its own viewer. Instead a single
 * hidden skinview3d scene renders each request to a PNG data URL, which the
 * chip then shows as a plain image. Results are cached by texture+mode.
 *
 * Capture uses our own `WebGLRenderer` with `preserveDrawingBuffer: true` so
 * `toDataURL()` reliably returns pixels (skinview3d's own renderer doesn't
 * guarantee a readable buffer after a frame). The camera auto-frames the
 * cape/elytra via its bounding box, so we don't hardcode coordinates that
 * would drift if skinview3d's geometry changes.
 */
import { SkinViewer } from "skinview3d";
import { Box3, Vector3, WebGLRenderer } from "three";

/** Render resolution (square). The chip CSS downsamples; 2× a ~80px chip. */
const SIZE = 160;
/** Fraction of the frame the model fills (1 = edge-to-edge; <1 leaves margin). */
const FILL = 0.82;
const FOV_DEG = 40;

let viewer: SkinViewer | undefined;
let renderer: WebGLRenderer | undefined;
let canvas: HTMLCanvasElement | undefined;
/** Serializes renders — one shared viewer can only draw one cape at a time. */
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, string>();

function ensureViewer(): void {
  if (viewer) return;
  const viewerCanvas = document.createElement("canvas");
  viewer = new SkinViewer({ canvas: viewerCanvas, width: SIZE, height: SIZE });
  // We drive rendering ourselves; stop skinview3d's rAF loop so it doesn't
  // fight our manual camera framing.
  (viewer as unknown as { renderPaused: boolean }).renderPaused = true;
  // Show only the back equipment (cape / elytra), not the body.
  viewer.playerObject.skin.visible = false;
  // Flat, even lighting for icons: the camera-following point light brightens
  // surfaces that face it and gets *closer* when we frame the smaller elytra,
  // which made the elytra render blown-out vs the cape. Drop it and keep only
  // the ambient global light so both render at the same texture-accurate
  // brightness regardless of how close the camera is.
  viewer.cameraLight.intensity = 0;

  canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearAlpha(0); // transparent so the chip background shows through
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("cape image failed to load"));
    img.src = url;
  });
}

/** Frame the camera on `mode`'s object via its bounding box, then render. */
function snapshot(mode: "cape" | "elytra"): string {
  const v = viewer!;
  const target = mode === "elytra" ? v.playerObject.elytra : v.playerObject.cape;
  target.updateWorldMatrix(true, true);

  const box = new Box3().setFromObject(target);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const span = Math.max(size.x, size.y, 0.001);

  const cam = v.camera;
  cam.aspect = 1;
  cam.fov = FOV_DEG;
  // Distance that makes `span / FILL` fit vertically in the FOV.
  const dist = (span / FILL) / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
  // The cape's decorated face points away from the player's front (world -z) —
  // its design faces outward from the back — so we view it from the -z side.
  // (Viewing from +z showed the plain inner/back face.)
  cam.position.set(center.x, center.y, center.z - dist - size.z);
  cam.lookAt(center);
  cam.updateProjectionMatrix();

  renderer!.render(v.scene, cam);
  return canvas!.toDataURL("image/png");
}

/**
 * Render `texture` (a data URL or image URL) as a cape or elytra model
 * thumbnail, returning a PNG data URL. Cached; calls are serialized.
 */
export function renderCapeModel(texture: string, mode: "cape" | "elytra"): Promise<string> {
  const key = `${mode}|${texture}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const run = async (): Promise<string> => {
    ensureViewer();
    const img = await loadImage(texture);
    // Draw to a canvas so loadCape is synchronous (a canvas is a valid source).
    const tex = document.createElement("canvas");
    tex.width = img.naturalWidth || 64;
    tex.height = img.naturalHeight || 32;
    tex.getContext("2d")!.drawImage(img, 0, 0);
    viewer!.loadCape(tex, { backEquipment: mode });
    const url = snapshot(mode);
    cache.set(key, url);
    return url;
  };

  // Chain so renders never overlap on the single shared viewer. Recover on
  // either branch so one failure doesn't wedge the queue.
  const next = queue.then(run, run) as Promise<string>;
  queue = next.catch(() => undefined);
  return next;
}
