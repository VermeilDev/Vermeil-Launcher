// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, For, Show, createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { IconChevronDown } from "./Icons";

export interface DropdownOption {
  value: string;
  label: string;
  badge?: string;
}

export interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  /** Optional width constraint */
  width?: string;
  /** When true, the control is greyed out and can't be opened. */
  disabled?: boolean;
  /** Open the options panel upward (above the trigger) instead of downward.
   *  Use when the dropdown sits near the bottom of its container so the list
   *  doesn't overflow and trigger a scrollbar. */
  openUp?: boolean;
  /** Enable search filtering within options list */
  searchable?: boolean;
  searchPlaceholder?: string;
}

/**
 * Custom styled dropdown that matches the game version selector design.
 * Replaces native <select> elements for consistent cross-platform appearance.
 */
const Dropdown: Component<DropdownProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const selectedLabel = () => {
    const opt = props.options.find(o => o.value === props.value);
    return opt?.label ?? (props.value || "Any");
  };

  const filteredOptions = createMemo(() => {
    if (!props.searchable) return props.options;
    const q = searchQuery().trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(o =>
      o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
  });

  createEffect(() => {
    if (!open()) return;
    setSearchQuery("");
    if (props.searchable) {
      setTimeout(() => searchInputRef?.focus(), 40);
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    onCleanup(() => window.removeEventListener("mousedown", handleClickOutside));
  });

  return (
    <div
      ref={containerRef}
      class="custom-dropdown"
      classList={{ disabled: props.disabled, open: open() }}
      style={props.width ? `width:${props.width}` : "width:auto;min-width:120px"}
      tabIndex={props.disabled ? -1 : 0}
      onBlur={(e) => {
        if (containerRef && containerRef.contains(e.relatedTarget as Node)) return;
        setTimeout(() => setOpen(false), 150);
      }}
    >
      <div
        class="custom-dropdown-selected"
        onClick={() => { if (!props.disabled) setOpen(!open()); }}
      >
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          {props.prefix ? props.prefix : ""}{selectedLabel()}
        </span>
        <span class="custom-dropdown-arrow" classList={{ open: open() }}><IconChevronDown /></span>
      </div>
      <Show when={open() && !props.disabled}>
        <div
          class="custom-dropdown-options"
          classList={{ up: props.openUp }}
          style={props.searchable ? "max-height:240px; display:flex; flex-direction:column; overflow:hidden;" : "max-height:180px"}
        >
          <Show when={props.searchable}>
            <input
              ref={searchInputRef}
              class="custom-dropdown-search"
              placeholder={props.searchPlaceholder || "Search..."}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </Show>
          <div class={props.searchable ? "custom-dropdown-scroll" : undefined} style={props.searchable ? "overflow-y:auto; flex:1;" : undefined}>
            <For each={filteredOptions()}>
              {(opt) => (
                <div
                  class="custom-dropdown-option"
                  classList={{ selected: props.value === opt.value }}
                  onClick={() => { props.onChange(opt.value); setOpen(false); }}
                  style={opt.badge ? "display:flex; justify-content:space-between; align-items:center;" : undefined}
                >
                  <span>{opt.label}</span>
                  <Show when={opt.badge}>
                    <span style="font-size:10px; color:var(--accent); font-weight:700; opacity:0.9; margin-left:8px;">
                      {opt.badge}
                    </span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={filteredOptions().length === 0}>
              <div class="custom-dropdown-empty">No matching versions</div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Dropdown;
