// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createEffect, onCleanup } from "solid-js";
import { renderCapeModel } from "../lib/capeThumb";

/**
 * Cape-chip thumbnail showing a rendered 3D model of the cape (front-on),
 * instead of the flat UV-atlas texture. For capes that have an elytra (Mojang
 * capes — pass `withElytra`), it slideshows between the cape and elytra models
 * every few seconds. Custom capes have no custom elytra, so they stay
 * cape-only.
 *
 * While the model render is in flight it falls back to the raw texture so the
 * chip is never blank, then swaps to the model once ready.
 */
const CapeChipThumb: Component<{ texture: string; withElytra?: boolean }> = (props) => {
  const [capeImg, setCapeImg] = createSignal<string | null>(null);
  const [elytraImg, setElytraImg] = createSignal<string | null>(null);
  const [showElytra, setShowElytra] = createSignal(false);
  const [errored, setErrored] = createSignal(false);

  // Render snapshot(s) whenever the texture changes.
  createEffect(() => {
    const tex = props.texture;
    const wantElytra = !!props.withElytra;
    setCapeImg(null);
    setElytraImg(null);
    setShowElytra(false);
    setErrored(false);
    let alive = true;
    renderCapeModel(tex, "cape")
      .then((u) => alive && setCapeImg(u))
      .catch(() => alive && setErrored(true));
    if (wantElytra) {
      renderCapeModel(tex, "elytra").then((u) => alive && setElytraImg(u)).catch(() => {});
    }
    onCleanup(() => { alive = false; });
  });

  // Slideshow: alternate cape ↔ elytra once both renders exist.
  createEffect(() => {
    if (!props.withElytra || !capeImg() || !elytraImg()) return;
    const id = window.setInterval(() => setShowElytra((v) => !v), 3500);
    onCleanup(() => window.clearInterval(id));
  });

  // The model snapshot once it's ready; while rendering we show nothing (so the
  // raw UV texture never flashes); only if rendering fails do we fall back to
  // the raw texture so the chip isn't permanently blank.
  const modelImg = () => (showElytra() && elytraImg() ? elytraImg()! : capeImg());
  const src = () => modelImg() ?? (errored() ? props.texture : null);
  const isModel = () => !!modelImg();

  return (
    <div
      class="skins-cape-chip-thumb"
      classList={{ "skins-cape-chip-thumb--model": isModel() }}
      style={src() ? { "background-image": `url(${src()})` } : {}}
    />
  );
};

export default CapeChipThumb;
