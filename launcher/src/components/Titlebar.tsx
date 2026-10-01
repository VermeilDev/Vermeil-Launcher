// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings } from "../ipc/commands";
import { account, activeSkinUrl } from "../App";
import PlayerHead from "./PlayerHead";

const Titlebar: Component<{ title: string }> = (props) => {
  const appWindow = getCurrentWindow();

  const handleClose = (e: MouseEvent) => {
    e.stopPropagation();
    appWindow.close();
  };

  const handleMinimize = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const settings = await getSettings();
      if (settings.close_on_launch) {
        appWindow.hide();
      } else {
        appWindow.minimize();
      }
    } catch {
      appWindow.minimize();
    }
  };

  const handleMaximize = (e: MouseEvent) => {
    e.stopPropagation();
    appWindow.toggleMaximize();
  };

  return (
    <div class="titlebar" onMouseDown={() => appWindow.startDragging()}>
      <div class="win-btns">
        <button class="win-btn win-close" onClick={handleClose} onMouseDown={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/>
          </svg>
        </button>
        <button class="win-btn win-minimize" onClick={handleMinimize} onMouseDown={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2.5" y1="6" x2="9.5" y2="6"/>
          </svg>
        </button>
        <button class="win-btn win-maximize" onClick={handleMaximize} onMouseDown={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2.5" y="2.5" width="7" height="7" rx="1"/>
          </svg>
        </button>
      </div>
      <div class="titlebar-title">{props.title}</div>
      <div class="account-pill">
        <PlayerHead
          skinUrl={activeSkinUrl()}
          name={account()?.name ?? "Guest"}
          size={20}
          class="account-pill-head"
        />
        <span>{account()?.name ?? "Not signed in"}</span>
      </div>
    </div>
  );
};

export default Titlebar;
