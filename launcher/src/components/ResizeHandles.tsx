// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

/**
 * Invisible resize handles for frameless windows on Linux/Wayland.
 * Without native decorations, the window manager has no resize grips —
 * these thin edge zones call startResizeDragging to enable resizing.
 */
const ResizeHandles: Component = () => {
  const appWindow = getCurrentWindow();

  const startResize = (direction: ResizeDirection) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    appWindow.startResizeDragging(direction);
  };

  return (
    <>
      <div class="resize-handle resize-n" onMouseDown={startResize("North")} />
      <div class="resize-handle resize-s" onMouseDown={startResize("South")} />
      <div class="resize-handle resize-e" onMouseDown={startResize("East")} />
      <div class="resize-handle resize-w" onMouseDown={startResize("West")} />
      <div class="resize-handle resize-ne" onMouseDown={startResize("NorthEast")} />
      <div class="resize-handle resize-nw" onMouseDown={startResize("NorthWest")} />
      <div class="resize-handle resize-se" onMouseDown={startResize("SouthEast")} />
      <div class="resize-handle resize-sw" onMouseDown={startResize("SouthWest")} />
    </>
  );
};

export default ResizeHandles;
