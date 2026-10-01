/**
 * Minimal ambient types for `gifuct-js` (2.1.x), which ships as plain JS with
 * no bundled declarations. Only the surface we use is declared. Upstream:
 * https://github.com/matt-way/gifuct-js (MIT).
 */
declare module "gifuct-js" {
  /** Logical screen descriptor + decoded frame blocks. */
  export interface ParsedGif {
    lsd: { width: number; height: number };
  }

  /** A single decompressed frame (with `buildPatch` enabled). */
  export interface DecompressedFrame {
    /** Sub-rectangle this frame's patch occupies within the logical screen. */
    dims: { top: number; left: number; width: number; height: number };
    /** Display time in milliseconds. */
    delay: number;
    /** GIF disposal method (1 = leave, 2 = restore-to-background, 3 = restore-to-previous). */
    disposalType: number;
    /** Canvas-ready RGBA pixels for this frame's patch (present when `buildPatch` is true). */
    patch: Uint8ClampedArray;
  }

  export function parseGIF(data: ArrayBuffer | Uint8Array): ParsedGif;
  export function decompressFrames(gif: ParsedGif, buildPatch: boolean): DecompressedFrame[];
}
