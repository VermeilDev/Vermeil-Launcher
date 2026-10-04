// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";

export interface TactileSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  tip?: string;
  tipClass?: string;
  "aria-label"?: string;
  class?: string;
}

export const TactileSwitch: Component<TactileSwitchProps> = (props) => (
  <button
    type="button"
    role="switch"
    aria-checked={props.checked}
    aria-label={props["aria-label"]}
    disabled={props.disabled}
    class={`tactile-switch ${props.checked ? "active" : ""} ${props.tipClass ?? ""} ${props.class ?? ""}`}
    data-tip={props.tip}
    onClick={(e) => {
      e.stopPropagation();
      if (!props.disabled) props.onChange(!props.checked);
    }}
  />
);

export default TactileSwitch;
