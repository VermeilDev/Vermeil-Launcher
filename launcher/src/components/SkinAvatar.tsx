// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, onMount, createEffect } from "solid-js";

/**
 * Static front-facing player avatar drawn on a 2D canvas from a skin PNG.
 *
 * Minecraft skin layout (64x64) maps body parts to fixed regions in the
 * texture atlas. We blit just the front faces of each part onto a single
 * canvas so the saved-skins library can show recognizable previews instead
 * of the unwrapped texture sheet.
 *
 * Cheap by design: a plain 2D canvas, no WebGL context. Many of these can
 * render side-by-side without hitting the browser's WebGL context limit.
 */
interface SkinAvatarProps {
  /** Skin texture as a `data:image/png;base64,...` URL. */
  texture: string;
  /** "CLASSIC" (4px arms) or "SLIM" (3px arms). */
  variant: "CLASSIC" | "SLIM" | "Unknown";
  /** Rendered size in CSS pixels. The internal canvas is drawn at 4x for crispness. */
  size?: number;
}

// Front-face rects on the 64x64 skin atlas. [sx, sy, sw, sh]
// All measurements derived from the official Minecraft skin format.
const HEAD_FRONT: [number, number, number, number] = [8, 8, 8, 8];
const HEAD_OVERLAY_FRONT: [number, number, number, number] = [40, 8, 8, 8];
const BODY_FRONT: [number, number, number, number] = [20, 20, 8, 12];
const RIGHT_LEG_FRONT: [number, number, number, number] = [4, 20, 4, 12];
const LEFT_LEG_FRONT: [number, number, number, number] = [20, 52, 4, 12];
// Arms are 4px wide for CLASSIC, 3px wide for SLIM. Y/H are identical.
const RIGHT_ARM_FRONT_CLASSIC: [number, number, number, number] = [44, 20, 4, 12];
const RIGHT_ARM_FRONT_SLIM: [number, number, number, number] = [44, 20, 3, 12];
const LEFT_ARM_FRONT_CLASSIC: [number, number, number, number] = [36, 52, 4, 12];
const LEFT_ARM_FRONT_SLIM: [number, number, number, number] = [36, 52, 3, 12];

// Layout on the destination canvas. The full figure is 16 wide x 32 tall in
// "skin units"; we render at 4x scale (64x128) for crisp pixel-art edges.
const SCALE = 4;
const FIGURE_W = 16;
const FIGURE_H = 32;

const SkinAvatar: Component<SkinAvatarProps> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  const draw = () => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = FIGURE_W * SCALE;
    canvas.height = FIGURE_H * SCALE;
    // Disable smoothing so each skin pixel scales as a crisp block.
    ctx.imageSmoothingEnabled = false;

    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);

      const isSlim = props.variant === "SLIM";
      const armWidth = isSlim ? 3 : 4;
      const rightArm = isSlim ? RIGHT_ARM_FRONT_SLIM : RIGHT_ARM_FRONT_CLASSIC;
      const leftArm = isSlim ? LEFT_ARM_FRONT_SLIM : LEFT_ARM_FRONT_CLASSIC;

      // Helper to blit a source rect onto the destination at scaled coords.
      const blit = (
        src: [number, number, number, number],
        dx: number,
        dy: number,
      ) => {
        ctx.drawImage(
          img,
          src[0],
          src[1],
          src[2],
          src[3],
          dx * SCALE,
          dy * SCALE,
          src[2] * SCALE,
          src[3] * SCALE,
        );
      };

      // Body parts, drawn in a stacked figure layout:
      //   head:    cols 4-11, rows 0-7   (centered, 8 wide)
      //   arms:    flanking the body, rows 8-19
      //   body:    cols 4-11, rows 8-19  (8 wide)
      //   legs:    cols 4-11 split, rows 20-31

      // Head (centered)
      blit(HEAD_FRONT, 4, 0);

      // Right arm (player's right = visual left side of front view).
      // SLIM arms are visually offset so they still align flush with the body.
      blit(rightArm, 4 - armWidth, 8);

      // Body
      blit(BODY_FRONT, 4, 8);

      // Left arm
      blit(leftArm, 12, 8);

      // Legs (split down the middle, each 4 wide)
      blit(RIGHT_LEG_FRONT, 4, 20);
      blit(LEFT_LEG_FRONT, 8, 20);

      // Hat / head overlay layer drawn on top of the head. Skins that don't
      // use this layer typically have it transparent, so this is a no-op
      // for them.
      blit(HEAD_OVERLAY_FRONT, 4, 0);
    };
    img.src = props.texture;
  };

  onMount(draw);
  // Redraw when the texture or variant changes (e.g. after re-equip).
  createEffect(() => {
    void props.texture;
    void props.variant;
    draw();
  });

  const cssSize = props.size ?? 96;

  return (
    <canvas
      ref={canvas}
      style={{
        height: `${cssSize}px`,
        // Maintain the figure's aspect ratio (16:32 = 1:2) so it looks
        // proportionally correct at any height.
        width: `${cssSize / 2}px`,
        "image-rendering": "pixelated",
      }}
    />
  );
};

export default SkinAvatar;
