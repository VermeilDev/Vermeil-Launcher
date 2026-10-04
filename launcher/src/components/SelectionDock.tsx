/* SPDX-FileCopyrightText: 2026 VermeilDev
 * SPDX-License-Identifier: GPL-3.0-or-later */

import { Component, JSX, Show } from "solid-js";
import { dockPagination, paginationPosition, isDockHidden } from "../App";
import { IconX } from "./Icons";

export interface SelectionDockProps {
  count: number;
  mode?: "install" | "delete";
  primaryLabel: string;
  onPrimary: () => void;
  onClear: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  clearLabel?: string;
  icon?: JSX.Element;
  children?: JSX.Element;
}

export const SelectionDock: Component<SelectionDockProps> = (props) => {
  const isDelete = () => props.mode === "delete";

  const hasBottomPagination = () => {
    const p = dockPagination();
    return paginationPosition() === "bottom" && p !== null && p.total > 1;
  };

  const formattedCount = () => String(props.count).padStart(2, "0");

  return (
    <div
      class={`selection-dock ${isDelete() ? "selection-dock--delete" : "selection-dock--install"}`}
      classList={{
        "has-pagination-bottom": hasBottomPagination(),
        "dock-hidden": isDockHidden(),
      }}
      role="toolbar"
      aria-label="Multi-select actions"
    >
      {/* Monospace Status Chip (static, non-blinking) */}
      <div class="selection-dock-chip">
        <span class="selection-dock-count">{formattedCount()}</span>
        <span class="selection-dock-label">SELECTED</span>
      </div>

      {/* Extra actions slot (e.g. Select All or confirm input) */}
      <Show when={props.children}>
        <div class="selection-dock-extra">
          {props.children}
        </div>
      </Show>

      {/* Primary Action Button */}
      <button
        class={`btn ${isDelete() ? "btn--danger" : "btn--primary"} ${props.primaryLoading ? "loading" : ""}`}
        disabled={props.primaryDisabled}
        onClick={() => props.onPrimary()}
      >
        <Show when={props.icon}>
          {props.icon}
        </Show>
        <span>{props.primaryLabel}</span>
      </button>

      {/* Dismiss / Clear Action */}
      <button
        class="btn btn--ghost btn--sm"
        disabled={props.primaryLoading}
        onClick={() => props.onClear()}
      >
        <IconX />
        <span>{props.clearLabel || (isDelete() ? "Cancel" : "Clear")}</span>
      </button>
    </div>
  );
};

export default SelectionDock;
