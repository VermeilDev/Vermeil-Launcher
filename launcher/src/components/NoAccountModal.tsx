// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, Show } from "solid-js";
import { setActiveScreen } from "../App";
import { IconUser } from "./Icons";

const NoAccountModal: Component<{ open: boolean; onClose: () => void }> = (props) => {
  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal panel panel--bracketed" style="width: 440px;" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="card-section-tag tag-settings-account">ACCOUNT REQUIRED</span>
              <span class="modal-title">Sign In to Launch</span>
            </div>
          </div>
          <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
            <div style="font-size: 13px; color: var(--text); line-height: 1.5;">
              You need an active Minecraft account before launching the game.
            </div>
            <div style="background: var(--surface-sunken); border: 1px solid var(--border); border-left: 3px solid var(--accent); padding: 12px 14px; font-size: 12px; color: var(--text-muted); line-height: 1.5; display: flex; gap: 10px; align-items: flex-start;">
              <span style="color: var(--accent); margin-top: 1px; flex-shrink: 0;"><IconUser /></span>
              <div>
                Sign in with your official <strong style="color: var(--text);">Microsoft</strong> account to verify your Minecraft: Java Edition license and launch the game.
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn--subtle" onClick={props.onClose}>Cancel</button>
            <button class="btn btn--primary" onClick={() => { props.onClose(); setActiveScreen("account"); }}>
              <IconUser />
              <span>Go to Accounts</span>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default NoAccountModal;
