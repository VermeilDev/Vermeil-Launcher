// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/* Runnable self-check for the cape transform maths — the logarithmic scale
 * slider mapping, the untrusted-value clamps, and the rotation geometry.
 * No framework — run with:
 *   npx tsx src/lib/capeTransform.selfcheck.ts
 * Exits non-zero (throws) on the first failed case. */
import {
  PANEL,
  SCALE_MIN,
  SCALE_MAX,
  SCALE_STEPS,
  posToScale,
  scaleToPos,
  clampScale,
  clampRot,
  snapAngle,
  SNAP_STEP,
  computeBaseFit,
  drawPlacedImage,
} from "./cape";

let failed = 0;
const check = (label: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${label}`);
  }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// ─── Scale slider mapping ───

check("pos 0 → SCALE_MIN", near(posToScale(0), SCALE_MIN));
check("pos SCALE_STEPS → SCALE_MAX", near(posToScale(SCALE_STEPS), SCALE_MAX));

// Round-trips both ways, so a future edit can't invert one half of the pair.
for (const pos of [0, 1, 137, 500, 763, SCALE_STEPS]) {
  check(`round-trip pos ${pos}`, near(scaleToPos(posToScale(pos)), pos, 1e-6));
}
for (const s of [SCALE_MIN, 0.5, 1, 2.5, 5, SCALE_MAX]) {
  check(`round-trip scale ${s}`, near(posToScale(scaleToPos(s)), s, 1e-6));
}
// Out of range doesn't round-trip — it clamps to the nearest bound, so a cape
// saved under a wider ceiling reopens at the current one instead of off-slider.
check("scale above the ceiling clamps to SCALE_MAX", near(posToScale(scaleToPos(SCALE_MAX * 10)), SCALE_MAX, 1e-6));
check("scale below the floor clamps to SCALE_MIN", near(posToScale(scaleToPos(0)), SCALE_MIN, 1e-6));
check("clamped position stays on the track", scaleToPos(SCALE_MAX * 10) <= SCALE_STEPS);

// Monotonic increasing — a sign slip would make the slider run backwards.
let prev = -Infinity;
for (let pos = 0; pos <= SCALE_STEPS; pos += 25) {
  const s = posToScale(pos);
  check(`monotonic at pos ${pos}`, s > prev);
  prev = s;
}

// The defining property of a log track: equal position deltas give equal
// ratios, which is what keeps precision near 1x while allowing a high ceiling.
const d = 100;
const r1 = posToScale(d) / posToScale(0);
const r2 = posToScale(500 + d) / posToScale(500);
check("equal position deltas give equal ratios", near(r1, r2, 1e-9));

// 1x must be reachable and sit near the middle of the travel — not crammed
// against either end, which is what keeps the common range easy to hit.
const posAt1x = scaleToPos(1);
check("1x is reachable", near(posToScale(posAt1x), 1, 1e-9));
check(
  "1x sits in the middle of the travel",
  posAt1x > SCALE_STEPS * 0.3 && posAt1x < SCALE_STEPS * 0.7,
);

// Regression guard on the bounds themselves. A contain-fit image starts at one
// panel dimension, so the ceiling must overflow the panel enough to crop into a
// detail of the source, and the floor must shrink well inside it.
const square = computeBaseFit(512, 512);
check("SCALE_MAX overflows the panel several times over", square.baseDw * SCALE_MAX >= PANEL.w * 4);
check("SCALE_MIN shrinks to a fraction of the panel", square.baseDw * SCALE_MIN <= PANEL.w * 0.2);
// Deliberate limit, recorded so it reads as a choice and not an oversight: an
// extreme-aspect source can't be scaled up to fill the panel's long axis.
const wide = computeBaseFit(4000, 100);
check("extreme-aspect sources are not expected to fill the panel", wide.baseDh * SCALE_MAX < PANEL.h);

// ─── Clamps (transform blob is opaque to the backend → untrusted) ───

check("clampScale(undefined) → 1", clampScale(undefined) === 1);
check("clampScale(NaN) → 1", clampScale(NaN) === 1);
check("clampScale(Infinity) → 1", clampScale(Infinity) === 1);
check("clampScale(0) → SCALE_MIN", clampScale(0) === SCALE_MIN);
check("clampScale(-5) → SCALE_MIN", clampScale(-5) === SCALE_MIN);
check("clampScale(1e9) → SCALE_MAX", clampScale(1e9) === SCALE_MAX);
check("clampScale passes a valid value through", clampScale(2.5) === 2.5);

check("clampRot(undefined) → 0", clampRot(undefined) === 0);
check("clampRot(NaN) → 0", clampRot(NaN) === 0);
check("clampRot(0) → 0", clampRot(0) === 0);
check("clampRot(90) → 90", clampRot(90) === 90);
check("clampRot(360) → 0", clampRot(360) === 0);
check("clampRot(370) → 10", clampRot(370) === 10);
check("clampRot(-90) → 270", clampRot(-90) === 270);
check("clampRot(-450) → 270", clampRot(-450) === 270);

// ─── Rotation snapping ───
// The reason this exists: the track is ~2 degrees per pixel, so dragging toward
// a quarter turn lands on 89 or 91. Near-misses must resolve to the round angle.

for (const target of [0, 45, 90, 135, 180, 225, 270, 315]) {
  check(`snapAngle(${target}) is already exact`, snapAngle(target) === target);
  for (const off of [-4, -3, -1, 1, 3, 4]) {
    const raw = target + off;
    if (raw < 0) continue; // slider can't produce a negative
    check(`snapAngle(${raw}) → ${target}`, snapAngle(raw) === clampRot(target));
  }
}

// Outside the window every angle stays settable — snapping must not quantize
// the whole track to eighth-turns.
for (const free of [5, 20, 30, 40, 50, 60, 70, 84, 96, 110, 200, 300]) {
  check(`snapAngle(${free}) passes through`, snapAngle(free) === free);
}

// Snap windows must not swallow the midpoint between two targets.
check("snapAngle(22) stays free (midpoint of 0 and 45)", snapAngle(22) === 22);
check("snapAngle(23) stays free", snapAngle(23) === 23);

// Wrap-around: the top of the track is the same rotation as the bottom.
check("snapAngle(359) → 0", snapAngle(359) === 0);
check("snapAngle(357) → 0", snapAngle(357) === 0);
check("snapAngle(350) stays free", snapAngle(350) === 350);
check("snapAngle(NaN) → 0", snapAngle(NaN) === 0);

// Snapping is idempotent — re-applying it to its own output can't drift.
for (const v of [0, 1, 22, 46, 89, 91, 180, 271, 359]) {
  check(`snapAngle is idempotent at ${v}`, snapAngle(snapAngle(v)) === snapAngle(v));
}

// Every snap target is a multiple of the declared step, and quarter turns —
// the ones users actually aim for — are all reachable.
for (const q of [0, 90, 180, 270]) {
  check(`quarter turn ${q} is a snap target`, q % SNAP_STEP === 0 && snapAngle(q + 2) === q);
}

// ─── Rotation geometry ───

/** Minimal recording stand-in for a 2D context — drawPlacedImage only needs
 *  these five calls, so the geometry is checkable with no canvas/DOM. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    save: () => void calls.push("save"),
    restore: () => void calls.push("restore"),
    translate: (x: number, y: number) => void calls.push(`translate ${x} ${y}`),
    rotate: (a: number) => void calls.push(`rotate ${a.toFixed(6)}`),
    drawImage: (_s: unknown, x: number, y: number, w: number, h: number) =>
      void calls.push(`drawImage ${x} ${y} ${w} ${h}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
const IMG = {} as CanvasImageSource;

// rot 0 must stay on the cheap path: a single plain drawImage, no transform.
{
  const { ctx, calls } = recorder();
  drawPlacedImage(ctx, IMG, 3, 5, 10, 20, 0);
  check("rot 0 → one plain drawImage", calls.length === 1 && calls[0] === "drawImage 3 5 10 20");
}
{
  const { ctx, calls } = recorder();
  drawPlacedImage(ctx, IMG, 3, 5, 10, 20); // rot omitted entirely
  check("rot omitted → one plain drawImage", calls.length === 1 && calls[0] === "drawImage 3 5 10 20");
}

// Rotation pivots on the rect's own centre and draws centred on that pivot.
// This is the invariant "Center" relies on: position and rotation stay
// independent, so a centred image is still centred at any angle.
{
  const { ctx, calls } = recorder();
  drawPlacedImage(ctx, IMG, 3, 5, 10, 20, 90);
  check(
    "rot 90 → save/translate-to-centre/rotate/centred-draw/restore",
    calls.join(" | ") ===
      `save | translate 8 15 | rotate ${(Math.PI / 2).toFixed(6)} | drawImage -5 -10 10 20 | restore`,
  );
}

// Degrees → radians, clockwise, for the quarter turns users actually hit.
for (const [deg, rad] of [
  [90, Math.PI / 2],
  [180, Math.PI],
  [270, (3 * Math.PI) / 2],
] as const) {
  const { ctx, calls } = recorder();
  drawPlacedImage(ctx, IMG, 0, 0, 4, 4, deg);
  check(`rot ${deg} → ${rad.toFixed(4)} rad`, calls.includes(`rotate ${rad.toFixed(6)}`));
}

// Every rotated draw must balance save/restore, or the clip regions the bake
// sets up around it would leak into later draws.
for (const deg of [0, 45, 90, 200, 359]) {
  const { ctx, calls } = recorder();
  drawPlacedImage(ctx, IMG, 1, 2, 8, 8, deg);
  const saves = calls.filter((c) => c === "save").length;
  const restores = calls.filter((c) => c === "restore").length;
  check(`rot ${deg} balances save/restore`, saves === restores);
}

if (failed > 0) {
  throw new Error(`${failed} cape-transform case(s) failed`);
}
console.log("capeTransform: all cases passed");
