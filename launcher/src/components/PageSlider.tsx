// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, Show } from "solid-js";

const PageSlider: Component<{
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");

  const goLeft = () => {
    if (props.currentPage > 1) props.onPageChange(props.currentPage - 1);
  };

  const goRight = () => {
    if (props.currentPage < props.totalPages) props.onPageChange(props.currentPage + 1);
  };

  const startEdit = () => {
    setEditing(true);
    setInputValue(props.currentPage.toString());
    setTimeout(() => {
      const input = document.querySelector('.page-num-input') as HTMLInputElement;
      if (input) { input.focus(); input.select(); }
    }, 10);
  };

  const submitEdit = () => {
    const val = parseInt(inputValue());
    if (val >= 1 && val <= props.totalPages) {
      props.onPageChange(val);
    }
    setEditing(false);
  };

  return (
    <div class="page-nav">
      <button class="page-nav-btn" onClick={goLeft} disabled={props.currentPage <= 1}>‹</button>
      <Show when={!editing()} fallback={
        <input
          class="page-num-input"
          type="text"
          value={inputValue()}
          onInput={(e) => setInputValue(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitEdit(); if (e.key === "Escape") setEditing(false); }}
          onBlur={submitEdit}
        />
      }>
        <span class="page-num" data-tip="Go to page" onDblClick={startEdit}>{props.currentPage} / {props.totalPages}</span>
      </Show>
      <button class="page-nav-btn" onClick={goRight} disabled={props.currentPage >= props.totalPages}>›</button>
    </div>
  );
};

export default PageSlider;
