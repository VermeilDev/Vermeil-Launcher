// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onCleanup } from "solid-js";
import { currentThemeLogo } from "../App";

/**
 * Boot splash — the turning logo cube + shimmering "Vermeil" wordmark shown
 * once the launcher window appears. Ported from the marketing site's loader.
 *
 * The window is created hidden and only revealed after App's init completes
 * (`showWindow()`), so the countdown starts when `start` flips true — that's
 * the moment the splash is actually on screen. It holds for a minimum so the
 * animation reads, drives the progress bar to 100%, fades, then calls
 * {@link SplashProps.onDone} to unmount itself. Honors reduced-motion.
 */
interface SplashProps {
  /** Begin the dismissal countdown (set true once the window is shown). */
  start: boolean;
  /** Called after the fade-out completes so the parent can unmount the splash. */
  onDone: () => void;
}

const REDUCE =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const MIN_MS = REDUCE ? 200 : 2300; // on-screen time / bar fill duration
const FADE_MS = 600; // matches .splash transition in splash.css

const Splash: Component<SplashProps> = (props) => {
  // { pct, ms } drives the progress bar fill width + its transition duration.
  const [fill, setFill] = createSignal({ pct: 0, ms: 0 });
  const [done, setDone] = createSignal(false);
  let started = false;

  createEffect(() => {
    if (!props.start || started) return;
    started = true;

    // Fill smoothly from 0 to 100% across the whole on-screen time — one
    // continuous motion, no ease-to-92-then-snap.
    requestAnimationFrame(() => setFill({ pct: 100, ms: MIN_MS }));

    const minTimer = setTimeout(() => {
      setDone(true); // bar has reached 100% — fade out
      const removeTimer = setTimeout(() => props.onDone(), FADE_MS + 100);
      onCleanup(() => clearTimeout(removeTimer));
    }, MIN_MS);
    onCleanup(() => clearTimeout(minTimer));
  });

  return (
    <div class={`splash ${done() ? "is-done" : ""}`} role="status" aria-label="Loading Vermeil">
      <div class="splash-inner">
        <div class="splash-stage">
          <div class="splash-cube" aria-hidden="true">
            <span class="splash-cube-face front" />
            <span class="splash-cube-face back" />
            <span class="splash-cube-face right" />
            <span class="splash-cube-face left" />
            <span class="splash-cube-face top cap" />
            <span class="splash-cube-face bottom cap" />
            <span class="splash-cube-logo"><img src={currentThemeLogo()} alt="" /></span>
          </div>
        </div>
        <div class="splash-word">Vermeil</div>
      </div>
      <div class="splash-bar" aria-hidden="true">
        <div
          class="splash-bar-fill"
          style={`width:${fill().pct}%; transition: width ${fill().ms}ms cubic-bezier(0.25, 0.6, 0.3, 1)`}
        />
      </div>
    </div>
  );
};

export default Splash;
