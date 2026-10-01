// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, Show, For, onMount, onCleanup, createMemo } from "solid-js";
import { setActiveScreen } from "../App";
import { importCfZip, importMrpack, previewShareCode, importShareCode, ShareCodePreview } from "../ipc/commands";
import { enqueueModpack } from "../services/modpackQueue";
import { open } from "@tauri-apps/plugin-dialog";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { loaderLabel } from "../lib/loader";
import { resolveAssetUrl } from "../lib/assets";
import {
  IconModrinth,
  IconCurseForge,
  IconUpload,
  IconFileText,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconInfo,
  IconShare2,
  IconSearch,
  IconPackage,
  IconPuzzle,
  IconClipboard,
  IconLayers,
} from "../components/Icons";

type ImportPlatform = "modrinth" | "curseforge" | "sharecode";

const ImportInstance: Component = () => {
  const [activePlatform, setActivePlatform] = createSignal<ImportPlatform>("modrinth");
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [shareCodeText, setShareCodeText] = createSignal<string>("");
  const [sharePreview, setSharePreview] = createSignal<ShareCodePreview | null>(null);
  const [isScanned, setIsScanned] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [isDragging, setIsDragging] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const selectedFileName = createMemo(() => {
    const path = selectedPath();
    if (!path) return "";
    return path.split(/[\\/]/).pop() || "";
  });

  const selectedPackName = createMemo(() => {
    return selectedFileName().replace(/\.(mrpack|zip)$/i, "");
  });

  const handleShareCodeInput = (raw: string) => {
    setShareCodeText(raw);
    setIsScanned(false);
    setSharePreview(null);
    setError(null);
  };

  const handleScanCode = async () => {
    const trimmed = shareCodeText().trim();
    if (!trimmed) {
      setError("Please paste a share code to scan.");
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const p = await previewShareCode(trimmed);
      setSharePreview(p);
      setIsScanned(true);
    } catch (e: any) {
      setSharePreview(null);
      setIsScanned(false);
      setError(typeof e === "string" ? e : e?.message || "Invalid or expired share code.");
    } finally {
      setScanning(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await readText();
      if (text && text.trim()) {
        setShareCodeText(text.trim());
        setIsScanned(false);
        setSharePreview(null);
        setError(null);
        return;
      }
    } catch {
      // Fallback to web clipboard if native plugin is unavailable
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          setShareCodeText(text.trim());
          setIsScanned(false);
          setSharePreview(null);
          setError(null);
          return;
        }
      } catch {
        setError("Could not read from clipboard. Please paste with Ctrl+V.");
        return;
      }
    }
    setError("Clipboard is empty.");
  };

  const handleSelectFile = (path: string) => {
    setError(null);
    const lower = path.toLowerCase();
    if (lower.endsWith(".mrpack")) {
      setActivePlatform("modrinth");
      setSelectedPath(path);
    } else if (lower.endsWith(".zip")) {
      setActivePlatform("curseforge");
      setSelectedPath(path);
    } else {
      setError("Unsupported format. Please select a .mrpack (Modrinth) or .zip (CurseForge) file.");
    }
  };

  const handleBrowse = async () => {
    setError(null);
    try {
      const isModrinth = activePlatform() === "modrinth";
      const selected = await open({
        multiple: false,
        filters: isModrinth
          ? [
              { name: "Modrinth Modpack (.mrpack)", extensions: ["mrpack"] },
              { name: "All Supported Archives", extensions: ["mrpack", "zip"] },
            ]
          : [
              { name: "CurseForge Export (.zip)", extensions: ["zip"] },
              { name: "All Supported Archives", extensions: ["zip", "mrpack"] },
            ],
      });

      if (selected && typeof selected === "string") {
        handleSelectFile(selected);
      }
    } catch (e: any) {
      console.error("Failed to open file picker:", e);
      setError(typeof e === "string" ? e : e.message || "Failed to open file browser");
    }
  };

  const handleImport = async () => {
    if (activePlatform() === "sharecode") {
      const code = shareCodeText().trim();
      const preview = sharePreview();
      if (!code || !preview) {
        setError("Please paste a valid share code.");
        return;
      }
      setError(null);
      setImporting(true);
      try {
        setActiveScreen("library");
        enqueueModpack({
          projectId: `sharecode:${Date.now()}`,
          title: preview.name || "Shared Instance",
          category: "modpack",
          meta: {
            iconUrl: preview.icon_url ?? undefined,
            loader: preview.loader_type,
            gameVersion: preview.game_version,
            versionNumber: "VML Share Code",
            author: "Vermeil Share Code",
          },
          execute: () => importShareCode(code),
        });
        setImporting(false);
      } catch (e: any) {
        setError(typeof e === "string" ? e : e?.message || "Failed to initiate share code import");
        setImporting(false);
      }
      return;
    }

    const path = selectedPath();
    if (!path) {
      setError("Please select a file to import.");
      return;
    }

    const lower = path.toLowerCase();
    const isMrpack = lower.endsWith(".mrpack");
    const isZip = lower.endsWith(".zip");

    if (!isMrpack && !isZip) {
      setError("Unsupported format. Please select a .mrpack (Modrinth) or .zip (CurseForge) file.");
      return;
    }

    if (activePlatform() === "modrinth" && !isMrpack) {
      setError("You selected a .zip file while on the Modrinth tab. Please switch to CurseForge or select a .mrpack file.");
      return;
    }

    if (activePlatform() === "curseforge" && !isZip) {
      setError("You selected a .mrpack file while on the CurseForge tab. Please switch to Modrinth or select a .zip file.");
      return;
    }

    setError(null);
    setImporting(true);

    try {
      const platform = activePlatform();
      const title = selectedPackName() || (platform === "modrinth" ? "Modrinth pack" : "CurseForge pack");

      setActiveScreen("library");

      enqueueModpack({
        projectId: path,
        title,
        category: "modpack",
        meta: {
          iconUrl: undefined,
          loader: undefined,
          gameVersion: undefined,
          versionNumber: undefined,
          author: undefined,
        },
        execute: () => {
          if (platform === "modrinth") {
            return importMrpack(path);
          } else {
            return importCfZip(path);
          }
        },
      });

      setImporting(false);
    } catch (e: any) {
      console.error("Import failed:", e);
      setError(typeof e === "string" ? e : e.message || "Failed to initiate import");
      setImporting(false);
    }
  };

  let unlistenDrag: (() => void) | undefined;
  let isUnmounted = false;

  onMount(() => {
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (isUnmounted) return;
        if (event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "leave") {
          setIsDragging(false);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            handleSelectFile(paths[0]);
          }
        }
      })
      .then((unlisten) => {
        if (isUnmounted) {
          unlisten();
        } else {
          unlistenDrag = unlisten;
        }
      })
      .catch((e) => {
        console.warn("Drag-and-drop listener unavailable:", e);
      });
  });

  onCleanup(() => {
    isUnmounted = true;
    if (unlistenDrag) {
      unlistenDrag();
    }
  });

  const isReadyToImport = () =>
    activePlatform() === "sharecode" ? (isScanned() && !!sharePreview()) : !!selectedPath();

  return (
    <div class="screen-enter import-screen">
      {/* Top Header with Status Badges */}
      <div class="page-header" style="margin-bottom: var(--space-4); display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div class="page-title-group">
          <div class="page-title">Import Instance</div>
          <div class="page-subtitle">
            // ARCHIVE EXTRACTION &amp; BLUEPRINT INGESTION
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="bento-badge">
            {activePlatform() === "sharecode" ? "VML TOKEN" : activePlatform() === "modrinth" ? "MRPACK ARCHIVE" : "CF ZIP ARCHIVE"}
          </span>
          <span class="bento-badge" classList={{ "bento-badge-live": isReadyToImport() }}>
            <Show when={isReadyToImport()} fallback="AWAITING">
              <span class="bento-badge-dot" /> READY
            </Show>
          </span>
        </div>
      </div>

      {/* 2-Column Responsive Layout (fills width on all window sizes) */}
      <div class="import-layout">
        {/* Left Column: Form & Dropzone & Guides */}
        <div class="import-main-column">
          {/* ═══ BENTO 1: PLATFORM SELECTOR ═══ */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <div class="bento-card-title">
                <IconLayers />
                <span>Select Source Format</span>
              </div>
              <span class="bento-badge bento-badge-accent">3 PLATFORMS</span>
            </div>
            <div class="card-section-body">
              <div class="import-format-grid">
                {/* Modrinth Card */}
                <div
                  class="format-card"
                  classList={{
                    selected: activePlatform() === "modrinth",
                    "is-modrinth": activePlatform() === "modrinth",
                  }}
                  onClick={() => {
                    setActivePlatform("modrinth");
                    setError(null);
                    if (selectedPath() && selectedPath()!.toLowerCase().endsWith(".zip")) {
                      setSelectedPath(null);
                    }
                  }}
                >
                  <div class="format-card-top">
                    <div class="format-card-icon modrinth">
                      <IconModrinth />
                    </div>
                    <span class="bento-badge">.MRPACK</span>
                  </div>
                  <div class="format-card-title">Modrinth Pack</div>
                  <div class="format-card-desc">
                    Native manifest with indexed hash downloads
                  </div>
                </div>

                {/* CurseForge Card */}
                <div
                  class="format-card"
                  classList={{
                    selected: activePlatform() === "curseforge",
                    "is-curseforge": activePlatform() === "curseforge",
                  }}
                  onClick={() => {
                    setActivePlatform("curseforge");
                    setError(null);
                    if (selectedPath() && selectedPath()!.toLowerCase().endsWith(".mrpack")) {
                      setSelectedPath(null);
                    }
                  }}
                >
                  <div class="format-card-top">
                    <div class="format-card-icon curseforge">
                      <IconCurseForge />
                    </div>
                    <span class="bento-badge">.ZIP</span>
                  </div>
                  <div class="format-card-title">CurseForge Pack</div>
                  <div class="format-card-desc">
                    Exported CurseForge zip archive
                  </div>
                </div>

                {/* Share Code Card */}
                <div
                  class="format-card"
                  classList={{
                    selected: activePlatform() === "sharecode",
                  }}
                  onClick={() => {
                    setActivePlatform("sharecode");
                    setError(null);
                  }}
                >
                  <div class="format-card-top">
                    <div class="format-card-icon" style="color: var(--accent);">
                      <IconShare2 />
                    </div>
                    <span class="bento-badge bento-badge-accent">VML CODE</span>
                  </div>
                  <div class="format-card-title">Share Code</div>
                  <div class="format-card-desc">
                    Serverless VML instance blueprint token
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ═══ BENTO 2: ARCHIVE INGESTION ═══ */}
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <div class="bento-card-title">
                <IconUpload />
                <span>Archive Ingestion</span>
              </div>
              <span class="bento-badge">
                {activePlatform() === "sharecode" ? "VML CODE" : "FILE DROP"}
              </span>
            </div>
            <div class="card-section-body">
              <Show
                when={activePlatform() === "sharecode"}
                fallback={
                  <>
                    {/* Sunken Dropzone Well */}
                    <div
                      class="dropzone-well"
                      classList={{ dragging: isDragging() }}
                      onClick={handleBrowse}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleBrowse();
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Browse for ${activePlatform() === "modrinth" ? ".mrpack" : ".zip"} file`}
                    >
                      <div class="dropzone-icon">
                        <IconUpload />
                      </div>
                      <div class="dropzone-title">
                        {isDragging()
                          ? "Release to drop file..."
                          : `Drag & drop your ${activePlatform() === "modrinth" ? ".mrpack" : ".zip"} file here`}
                      </div>
                      <div class="dropzone-sub">
                        Supports direct drag-and-drop from Windows Explorer, or click anywhere to browse local files.
                      </div>
                    </div>

                    {/* Selected File Card */}
                    <Show when={selectedPath()}>
                      <div
                        class="import-selected-file"
                        classList={{
                          modrinth: activePlatform() === "modrinth",
                          curseforge: activePlatform() === "curseforge",
                        }}
                      >
                        <div class="import-selected-left">
                          <div
                            class="import-selected-icon"
                            classList={{
                              modrinth: activePlatform() === "modrinth",
                              curseforge: activePlatform() === "curseforge",
                            }}
                          >
                            <IconFileText />
                          </div>
                          <div class="import-selected-meta">
                            <div class="import-selected-name">{selectedFileName()}</div>
                            <div class="import-selected-path">
                              {selectedPath()}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          class="btn btn--sm btn--ghost tip-right"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedPath(null);
                          }}
                          data-tip="Remove selected file"
                          aria-label="Remove selected file"
                          style="color: var(--muted); padding: 4px 8px;"
                        >
                          <IconX />
                        </button>
                      </div>
                    </Show>
                  </>
                }
              >
                <div class="setting-row">
                  <div class="setting-text">
                    <div class="setting-name">Vermeil Share Code Token</div>
                    <div class="setting-desc">Paste a VML compressed blueprint token</div>
                  </div>
                  <div class="setting-control" style="flex: 1; max-width: 320px; display: flex; gap: 8px;">
                    <input
                      type="text"
                      class="field-control field-control--text"
                      style="flex: 1; font-family: var(--font-mono, monospace); font-size: 12px;"
                      placeholder="e.g. VML-XXXX-XXXX"
                      value={shareCodeText()}
                      onInput={(e) => handleShareCodeInput(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!isScanned()) {
                            handleScanCode();
                          } else if (isReadyToImport()) {
                            handleImport();
                          }
                        }
                      }}
                      spellcheck={false}
                    />
                    <Show
                      when={shareCodeText().trim().length > 0}
                      fallback={
                        <button
                          type="button"
                          class="btn btn--neutral tip-right"
                          data-tip="Paste from clipboard"
                          onClick={handlePasteClipboard}
                          disabled={scanning() || importing()}
                          style="display: flex; align-items: center; justify-content: center; width: var(--control-height-md); height: var(--control-height-md); min-width: var(--control-height-md); padding: 0; flex-shrink: 0; align-self: stretch;"
                        >
                          <IconClipboard />
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="btn btn--neutral tip-right"
                        data-tip="Clear code"
                        onClick={() => handleShareCodeInput("")}
                        disabled={scanning() || importing()}
                        style="display: flex; align-items: center; justify-content: center; width: var(--control-height-md); height: var(--control-height-md); min-width: var(--control-height-md); padding: 0; flex-shrink: 0; align-self: stretch;"
                      >
                        <IconX />
                      </button>
                    </Show>
                  </div>
                </div>

                <Show when={sharePreview()}>
                  {(p) => (
                    <Show
                      when={p().is_modpack}
                      fallback={
                        /* ─── CUSTOM INSTANCE: LIST MODS ─── */
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 4px;">
                          <div class="setting-row" style="justify-content: space-between; border-left-color: var(--accent);">
                            <div class="setting-info">
                              <span class="setting-name">{p().name}</span>
                              <span class="setting-desc">
                                Custom Instance · {loaderLabel(p().loader_type)} {p().loader_version || ""} · Minecraft {p().game_version} · {p().total_count} total items
                              </span>
                            </div>
                            <span class="badge" style="background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);">
                              Custom Collection
                            </span>
                          </div>

                          <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 4px;">
                            <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">
                              Mod &amp; Content List ({p().items.length} items)
                            </span>
                            <span class="badge badge--sm" style="font-size: 10px;">
                              {p().mod_count} Mods · {p().shader_count} Shaders · {p().resourcepack_count} Packs
                            </span>
                          </div>

                          <div style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 2px;">
                            <For each={p().items}>
                              {(item) => (
                                <div
                                  class="setting-row"
                                  style={`padding: 7px 10px; font-size: 11px; align-items: center; justify-content: space-between; border-left-color: ${item.enabled ? "var(--accent)" : "var(--border)"};`}
                                >
                                  <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">
                                    <Show
                                      when={resolveAssetUrl(item.icon_url)}
                                      fallback={
                                        <div style="width: 28px; height: 28px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--text-muted);">
                                          <IconPuzzle />
                                        </div>
                                      }
                                    >
                                      {(iconSrc) => (
                                        <img
                                          src={iconSrc()}
                                          alt=""
                                          style="width: 28px; height: 28px; border-radius: 4px; object-fit: contain; background: rgba(0,0,0,0.3); flex-shrink: 0;"
                                        />
                                      )}
                                    </Show>
                                    <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1;">
                                      <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                                        <span style="font-weight: 600; color: var(--text); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-size: 12px;">
                                          {item.name}
                                        </span>
                                        <Show when={item.version}>
                                          <span class="badge badge--sm" style="font-size: 9px; padding: 1px 5px; background: rgba(255,255,255,0.06); color: var(--text-muted); border: 1px solid var(--border); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                            {item.version}
                                          </span>
                                        </Show>
                                      </div>
                                      <div style="display: flex; align-items: center; gap: 6px;">
                                        <span class="badge badge--sm" style="font-size: 8.5px; padding: 0 4px;">
                                          {item.category === "shader" ? "SHADER" : item.category === "resourcepack" ? "PACK" : "MOD"}
                                        </span>
                                        <span style="font-size: 10px; color: var(--text-muted);">{item.source}</span>
                                      </div>
                                    </div>
                                  </div>
                                  <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                                    <Show when={!item.enabled}>
                                      <span class="badge badge--dim" style="font-size: 9px;">DISABLED</span>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      }
                    >
                      {/* ─── MODPACK BLUEPRINT: NO NEED TO LIST 300 MODS, SHOW MODPACK API INFO ─── */}
                      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 4px;">
                        <div class="setting-row" style="justify-content: space-between; border-left-color: #1bd96a;">
                          <div style="display: flex; align-items: center; gap: 12px;">
                            <Show
                              when={resolveAssetUrl(p().icon_url)}
                              fallback={
                                <div style="width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05); border-radius: 4px;">
                                  <IconPackage />
                                </div>
                              }
                            >
                              {(iconSrc) => (
                                <img
                                  src={iconSrc()}
                                  alt="Modpack icon"
                                  style="width: 38px; height: 38px; object-fit: contain; border-radius: 4px; background: rgba(0,0,0,0.3);"
                                />
                              )}
                            </Show>
                            <div class="setting-info">
                              <span class="setting-name">{p().name}</span>
                              <span class="setting-desc">
                                {p().base_pack_platform || "Official"} Modpack · {loaderLabel(p().loader_type)} {p().loader_version || ""} · Minecraft {p().game_version}
                              </span>
                            </div>
                          </div>
                          <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);">
                            {p().base_pack_platform ? `${p().base_pack_platform} Pack` : "Official Modpack"}
                          </span>
                        </div>

                        <div class="spec-callout">
                          <strong>Official Modpack Distribution:</strong>
                          <span>
                            This instance is based on an official modpack ({p().mod_count} mods). All mods, configs, scripts, and overrides will be fetched directly via the official {p().base_pack_platform || "modpack"} API without requiring individual mod resolution.
                          </span>
                        </div>

                        <Show when={p().items.length > 0}>
                          <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                            <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">
                              Custom Modifications (+{p().items.length} mods added on top)
                            </span>
                            <div style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
                              <For each={p().items}>
                                {(item) => (
                                  <div
                                    class="setting-row"
                                    style={`padding: 6px 10px; font-size: 11px; align-items: center; justify-content: space-between; border-left-color: ${item.enabled ? "var(--accent)" : "var(--border)"};`}
                                  >
                                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                                      <Show
                                        when={resolveAssetUrl(item.icon_url)}
                                        fallback={
                                          <div style="width: 24px; height: 24px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--text-muted);">
                                            <IconPuzzle />
                                          </div>
                                        }
                                      >
                                        {(iconSrc) => (
                                          <img
                                            src={iconSrc()}
                                            alt=""
                                            style="width: 24px; height: 24px; border-radius: 4px; object-fit: contain; background: rgba(0,0,0,0.3); flex-shrink: 0;"
                                          />
                                        )}
                                      </Show>
                                      <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;">
                                        <span style="font-weight: 600; color: var(--text); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-size: 11.5px;">
                                          {item.name}
                                        </span>
                                        <Show when={item.version}>
                                          <span class="badge badge--sm" style="font-size: 8.5px; padding: 0 4px; background: rgba(255,255,255,0.06); color: var(--text-muted); border: 1px solid var(--border);">
                                            {item.version}
                                          </span>
                                        </Show>
                                      </div>
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                                      <span class="badge badge--sm" style="font-size: 8.5px; padding: 0 4px;">{item.category.toUpperCase()}</span>
                                      <Show when={!item.enabled}>
                                        <span class="badge badge--dim" style="font-size: 8.5px;">DISABLED</span>
                                      </Show>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  )}
                </Show>
              </Show>
            </div>
          </div>

          {/* ═══ SECTION 3: INSTRUCTIONS & SPECIFICATIONS ═══ */}
          <Show
            when={activePlatform() === "sharecode"}
            fallback={
              <Show
                when={activePlatform() === "modrinth"}
                fallback={
                  <div class="card-gamemode-section">
                    <div class="card-section-header">
                      <div class="bento-card-title">
                        <IconInfo />
                        <span>CurseForge App Export Instructions</span>
                      </div>
                      <span class="bento-badge">GUIDE</span>
                    </div>
                    <div class="card-section-body" style="display: flex; flex-direction: column; gap: 12px;">
                      <div class="import-step-list">
                        <div class="import-step-item">
                          <span class="import-step-number">1</span>
                          <span>Open the <strong>CurseForge App</strong> and click on the Minecraft modpack or profile you want to export.</span>
                        </div>
                        <div class="import-step-item">
                          <span class="import-step-number">2</span>
                          <span>Click the three dots menu (<strong>⋮</strong>) next to the Play button, then click <strong>Export Profile</strong> (or <em>Share Profile → Export as .zip</em>).</span>
                        </div>
                        <div class="import-step-item">
                          <span class="import-step-number">3</span>
                          <span>Ensure all mods and configs are checked, click <strong>Export</strong>, and drop or choose the resulting <code>.zip</code> file above.</span>
                        </div>
                      </div>

                      <div class="spec-callout">
                        <strong>Why .zip exports?</strong>
                        <span>CurseForge share codes are temporary 7-day Overwolf client sessions without a public third-party API. The official <code>.zip</code> export contains your complete modpack manifest, options, and configs, and installs reliably in Vermeil.</span>
                      </div>
                    </div>
                  </div>
                }
              >
                <div class="card-gamemode-section">
                  <div class="card-section-header">
                    <div class="bento-card-title">
                      <IconInfo />
                      <span>Modrinth .mrpack Standard</span>
                    </div>
                    <span class="bento-badge bento-badge-accent">SPECIFICATION</span>
                  </div>
                  <div class="card-section-body" style="display: flex; flex-direction: column; gap: 10px;">
                    <div class="setting-row" style="background: transparent; border: none; padding: 0;">
                      <div class="setting-text">
                        <div class="setting-name">Direct Signed CDN URLs</div>
                        <div class="setting-desc">
                          Unlike other platforms, <code>.mrpack</code> files contain signed CDN download links and SHA hashes for every mod, eliminating API rate-limits and blocked downloads.
                        </div>
                      </div>
                    </div>
                    <div class="setting-row" style="background: transparent; border: none; padding: 0;">
                      <div class="setting-text">
                        <div class="setting-name">Where to find .mrpack files</div>
                        <div class="setting-desc">
                          Download any modpack release directly from <span style="color: #1bd96a; font-weight: 600;">Modrinth.com</span> by choosing "Download .mrpack", or export one from other launchers.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>
            }
          >
            <div class="card-gamemode-section">
              <div class="card-section-header">
                <div class="bento-card-title">
                  <IconInfo />
                  <span>Vermeil Share Codes</span>
                </div>
                <span class="bento-badge">SPECIFICATION</span>
              </div>
              <div class="card-section-body" style="display: flex; flex-direction: column; gap: 10px;">
                <div class="setting-row" style="background: transparent; border: none; padding: 0;">
                  <div class="setting-text">
                    <div class="setting-name">How to generate a Share Code</div>
                    <div class="setting-desc">
                      Open any instance in your Library and click the <strong>Share Code</strong> icon in the top-right action bar to copy its code (e.g. <code>VML-XXXX-XXXX</code> or <code>VML...</code>) to your clipboard.
                    </div>
                  </div>
                </div>
                <div class="setting-row" style="background: transparent; border: none; padding: 0;">
                  <div class="setting-text">
                    <div class="setting-name">Verified Content Resolution</div>
                    <div class="setting-desc">
                      All mods, shaders, and resource packs are fetched directly from official Modrinth and CurseForge CDNs with cryptographic SHA-1 verification. Mods whose authors disabled third-party distribution on CurseForge will prompt for manual download.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </div>

        {/* Right Column: Manifest Blueprint Station & Actions */}
        <div class="import-sidebar-column">
          <div class="card-gamemode-section">
            <div class="card-section-header">
              <div class="bento-card-title">
                <IconFileText />
                <span>Manifest Blueprint</span>
              </div>
              <span class="bento-badge bento-badge-accent">LIVE PREVIEW</span>
            </div>
            <div class="card-section-body" style="gap: 12px;">
              {/* Instance Card Preview */}
              <div class="inst-card-preview">
                <div
                  class={`inst-thumb-avatar ${
                    activePlatform() === "modrinth"
                      ? "green"
                      : activePlatform() === "curseforge"
                        ? "orange"
                        : "purple"
                  }`}
                >
                  <Show
                    when={activePlatform() !== "sharecode"}
                    fallback={<IconShare2 />}
                  >
                    <Show
                      when={activePlatform() === "modrinth"}
                      fallback={<IconCurseForge />}
                    >
                      <IconModrinth />
                    </Show>
                  </Show>
                </div>
                <div class="inst-preview-meta">
                  <div class="inst-preview-title">
                    {activePlatform() === "sharecode"
                      ? sharePreview()?.name || "Vermeil Share Code"
                      : selectedPackName() || (activePlatform() === "modrinth" ? "Modrinth Pack" : "CurseForge Profile")}
                  </div>
                  <div class="inst-preview-sub">
                    {activePlatform() === "sharecode"
                      ? sharePreview()
                        ? `${loaderLabel(sharePreview()!.loader_type)} · MC ${sharePreview()!.game_version}`
                        : "Awaiting share code"
                      : selectedFileName() || "No archive chosen"}
                  </div>
                  <div class="inst-preview-badges">
                    <span class="bento-badge">
                      {activePlatform() === "sharecode"
                        ? sharePreview()?.game_version || "VML"
                        : activePlatform() === "modrinth"
                          ? ".mrpack"
                          : ".zip"}
                    </span>
                    <span
                      class="bento-badge"
                      style={
                        activePlatform() === "modrinth"
                          ? "background:rgba(27,217,106,0.15);color:#4ade80;border:1px solid rgba(27,217,106,0.4);"
                          : activePlatform() === "curseforge"
                            ? "background:rgba(241,100,54,0.15);color:#fb923c;border:1px solid rgba(241,100,54,0.4);"
                            : "background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 40%, transparent);"
                      }
                    >
                      {activePlatform() === "sharecode"
                        ? sharePreview()
                          ? loaderLabel(sharePreview()!.loader_type)
                          : "Blueprint"
                        : activePlatform() === "modrinth"
                          ? "Modrinth"
                          : "CurseForge"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Specification Table */}
              <div class="spec-table">
                <div class="spec-row">
                  <span class="spec-label">Source Platform</span>
                  <span class="spec-val">
                    {activePlatform() === "sharecode"
                      ? "Vermeil Share Code"
                      : activePlatform() === "modrinth"
                        ? "Modrinth"
                        : "CurseForge"}
                  </span>
                </div>
                <div class="spec-row">
                  <span class="spec-label">
                    {activePlatform() === "sharecode" ? "Blueprint Type" : "Package Format"}
                  </span>
                  <span class="spec-val">
                    {activePlatform() === "sharecode"
                      ? sharePreview()
                        ? (sharePreview()!.is_modpack ? `${sharePreview()!.base_pack_platform || "Official"} Modpack` : "Custom Instance")
                        : (isScanned() ? "Unknown" : "Share Code")
                      : activePlatform() === "modrinth"
                        ? ".mrpack archive"
                        : ".zip export"}
                  </span>
                </div>
                <div class="spec-row">
                  <span class="spec-label">
                    {activePlatform() === "sharecode" ? "Content Count" : "Archive File"}
                  </span>
                  <span
                    class="spec-val"
                    style="max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  >
                    {activePlatform() === "sharecode"
                      ? sharePreview()
                        ? `${sharePreview()!.total_count} items (${sharePreview()!.mod_count}M / ${sharePreview()!.shader_count}S / ${sharePreview()!.resourcepack_count}RP)`
                        : "None"
                      : selectedFileName() || "None"}
                  </span>
                </div>
                <div class="spec-row">
                  <span class="spec-label">
                    {activePlatform() === "sharecode" ? "Loader / MC" : "Overrides"}
                  </span>
                  <span class="spec-val active-tag">
                    {activePlatform() === "sharecode"
                      ? sharePreview()
                        ? `${loaderLabel(sharePreview()!.loader_type)} ${sharePreview()!.game_version}`
                        : "—"
                      : "Extracted"}
                  </span>
                </div>
                <div class="spec-row">
                  <span class="spec-label">Status</span>
                  <span
                    class="spec-val"
                    classList={{
                      "active-tag": isReadyToImport(),
                      "spec-val-warning": !isReadyToImport(),
                    }}
                  >
                    {isReadyToImport()
                      ? "Ready to import"
                      : activePlatform() === "sharecode"
                        ? (isScanned() ? "Ready to import" : "Awaiting scan")
                        : "Awaiting archive"}
                  </span>
                </div>
              </div>

              {/* Error Display */}
              <Show when={error()}>
                <div
                  style="display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: var(--danger-soft); border: 1px solid var(--danger); border-left: 3px solid var(--danger); color: var(--danger); font-size: 11px; line-height: 1.4;"
                >
                  <IconAlertTriangle />
                  <span>{error()}</span>
                </div>
              </Show>

              {/* Sandbox Callout Box */}
              <div class="spec-callout">
                <strong>Zero-Friction Sandbox:</strong>
                <span>
                  {activePlatform() === "sharecode"
                    ? "Instances are built in complete isolation with independent configs, client options, and save data."
                    : "Archives are unpacked directly into your local instances directory with all manifest dependencies verified."}
                </span>
              </div>

              {/* Action Buttons */}
              <div class="actions-footer">
                <button
                  type="button"
                  class="btn btn--neutral btn--lg"
                  style="flex: 1;"
                  onClick={() => setActiveScreen("create-choose")}
                  disabled={importing()}
                >
                  <IconX /> Cancel
                </button>
                <Show
                  when={activePlatform() === "sharecode" && !isScanned()}
                  fallback={
                    <button
                      type="button"
                      class="btn btn--primary btn--lg create-submit-btn"
                      style="flex: 2;"
                      onClick={handleImport}
                      disabled={importing() || !isReadyToImport()}
                    >
                      <Show when={importing()} fallback={<><IconCheck /> Import Instance</>}>
                        Import Instance
                      </Show>
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="btn btn--primary btn--lg create-submit-btn"
                    style="flex: 2;"
                    onClick={handleScanCode}
                    disabled={scanning() || shareCodeText().trim().length === 0}
                  >
                    <Show when={scanning()} fallback={<><IconSearch /> Scan Code</>}>
                      Scan Code
                    </Show>
                  </button>
                </Show>
              </div>

              {/* Hint text */}
              <div class="create-hint-text">
                <Show
                  when={isReadyToImport()}
                  fallback={
                    <span>
                      {activePlatform() === "sharecode"
                        ? (isScanned()
                            ? "Code verified. Click Import Instance to begin installation."
                            : "Paste a share code and click Scan Code to inspect.")
                        : "Drop archive or click anywhere in the well to browse."}
                    </span>
                  }
                >
                  Ready to install. Click Import Instance to download all verified content.
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImportInstance;
