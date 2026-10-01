// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createEffect, createSignal, onCleanup } from "solid-js";

/**
 * 2D head crop of a Minecraft skin texture. Renders the 8×8 face block
 * (pixels 8,8 → 16,16 of the standard skin layout) plus the matching hat
 * overlay (40,8 → 48,16) on a tiny canvas.
 *
 * Reused everywhere a user avatar is shown — titlebar pill, Account screen
 * account rows, Home greeting — so the launcher feels personalized rather
 * than generic.
 *
 * Skin URLs always arrive as `data:image/png;base64,...` data URLs from
 * the Rust backend (see `services/skins.rs`). The `<img>` element loads
 * them synchronously and the canvas crops the head out. No CORS / scheme
 * concerns since nothing leaves the webview.
 *
 * Falls back to a colored block with the username's first letter when no
 * skin URL is available (offline accounts, profile hasn't loaded yet, or
 * the data URL is malformed).
 */
interface Props {
  /**
   * `data:image/png;base64,...` URL of a Minecraft skin texture, or any
   * other PNG src the browser can decode. Pass `undefined` / `""` /
   * `null` to render the fallback.
   */
  skinUrl?: string | null;
  /** Username — used for the fallback initial and as deterministic color seed. */
  name?: string | null;
  /** Pixel size of the rendered avatar. Defaults to 28. */
  size?: number;
  /** Extra class names to apply to the wrapping element. */
  class?: string;
}

const HEAD_SIZE = 8; // skin "head" block is 8×8 pixels in texture space
const HAT_SIZE = 8; // hat overlay same dimensions

const PlayerHead: Component<Props> = (props) => {
  const [loaded, setLoaded] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;

  // Pick a deterministic background color for the fallback so the same
  // username always gets the same color. Cheap hash.
  const fallbackColor = () => {
    const name = props.name ?? "";
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 50%, 35%)`;
  };

  const fallbackInitial = () =>
    (props.name?.trim()?.[0] ?? "?").toUpperCase();

  // Whenever the URL changes, decode and crop. The image is loaded into
  // memory by the browser and drawn onto the canvas at the requested size.
  createEffect(() => {
    const url = props.skinUrl;
    setLoaded(false);
    if (!canvasRef || !url || url.startsWith("/dummy_skin")) return;

    const img = new Image();

    img.onload = () => {
      if (!canvasRef) return;
      const ctx = canvasRef.getContext("2d");
      if (!ctx) return;

      const target = props.size ?? 28;
      canvasRef.width = target;
      canvasRef.height = target;
      ctx.imageSmoothingEnabled = false;

      // Face: top-left 8×8 block at (8,8)
      ctx.drawImage(img, 8, 8, HEAD_SIZE, HEAD_SIZE, 0, 0, target, target);
      // Hat overlay: (40,8) — only present if alpha > 0 there
      ctx.drawImage(img, 40, 8, HAT_SIZE, HAT_SIZE, 0, 0, target, target);

      setLoaded(true);
    };

    img.onerror = () => setLoaded(false);
    img.src = url;

    onCleanup(() => {
      img.onload = null;
      img.onerror = null;
    });
  });

  const size = () => props.size ?? 28;

  return (
    <div
      class={`player-head ${props.class ?? ""}`}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        background: loaded() ? "transparent" : fallbackColor(),
      }}
    >
      <canvas
        ref={canvasRef}
        class="player-head-canvas"
        style={{
          opacity: loaded() ? 1 : 0,
        }}
      />
      {!loaded() && <span class="player-head-fallback">{fallbackInitial()}</span>}
    </div>
  );
};

export default PlayerHead;
