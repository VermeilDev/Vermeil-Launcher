// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";
import { setActiveScreen } from "../App";
import {
  IconSettings,
  IconLayers,
  IconDownload,
  IconCheck,
  IconArrowRight,
  IconShieldCheck,
  IconCpu,
} from "../components/Icons";

const CreateChoose: Component = () => {
  return (
    <div class="screen-enter create-choose-screen">
      <div class="create-hub-container">
        {/* Hub Header */}
        <div class="create-hub-header">
          <div class="create-hub-tag">
            DISCOVERY &amp; LAUNCH
          </div>
          <div class="create-hub-title">Create or Import Instance</div>
          <div class="create-hub-subtitle">
            Choose how you want to build, discover, or import your Minecraft sandbox
          </div>
        </div>

        {/* 3 Bento Hero Pillars */}
        <div class="create-hub-pillars">
          {/* Pillar 1: Custom Setup */}
          <div class="create-hero-card" onClick={() => setActiveScreen("create-custom")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--accent">
                <IconSettings />
              </div>
              <span class="create-hero-badge create-hero-badge--accent">MANUAL CONFIG</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Custom Setup</div>
              <div class="create-hero-desc">
                Configure your loader, Minecraft version, JVM runtime, and memory parameters manually with full control.
              </div>
              <div class="create-hero-features">
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Vanilla, Fabric, NeoForge, Forge, Quilt</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Granular build picker &amp; auto-suggest</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Automatic Companion mod injection</span>
                </div>
              </div>
            </div>
            <div class="create-hero-action create-hero-action--accent">
              <span>CONFIGURE INSTANCE</span>
              <IconArrowRight />
            </div>
          </div>

          {/* Pillar 2: Install Modpack */}
          <div class="create-hero-card" onClick={() => setActiveScreen("create-modpack")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--info">
                <IconLayers />
              </div>
              <span class="create-hero-badge create-hero-badge--info">RECOMMENDED</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Install Modpack</div>
              <div class="create-hero-desc">
                Browse, search, and download thousands of curated community modpacks from Modrinth and CurseForge.
              </div>
              <div class="create-hero-features">
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Modrinth &amp; CurseForge live catalog</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>1-click automated dependency resolver</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Smart update tracking &amp; lockfile parity</span>
                </div>
              </div>
            </div>
            <div class="create-hero-action create-hero-action--info">
              <span>EXPLORE MODPACKS</span>
              <IconArrowRight />
            </div>
          </div>

          {/* Pillar 3: Import Archive */}
          <div class="create-hero-card" onClick={() => setActiveScreen("create-import")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--warn">
                <IconDownload />
              </div>
              <span class="create-hero-badge create-hero-badge--warn">PORTABILITY</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Import Archive</div>
              <div class="create-hero-desc">
                Ingest existing Modrinth (.mrpack) or CurseForge (.zip) archives, or restore via instant serverless share code.
              </div>
              <div class="create-hero-features">
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Modrinth (.mrpack) &amp; CurseForge (.zip)</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Serverless VML Share Code blueprints</span>
                </div>
                <div class="create-hero-feature-item">
                  <IconCheck />
                  <span>Zero-network offline manifest extraction</span>
                </div>
              </div>
            </div>
            <div class="create-hero-action create-hero-action--warn">
              <span>IMPORT ARCHIVE</span>
              <IconArrowRight />
            </div>
          </div>
        </div>

        {/* Lower Bento Feature Shelf */}
        <div class="create-hub-shelf">
          <div class="create-shelf-tile">
            <div class="create-shelf-icon">
              <IconShieldCheck />
            </div>
            <div class="create-shelf-content">
              <div class="create-shelf-title">
                <span>Instance Sandboxes</span>
                <span class="create-shelf-tag">ISOLATION</span>
              </div>
              <div class="create-shelf-desc">
                Separate mod folders, configs, worlds, and runtimes per instance. Zero cross-contamination.
              </div>
            </div>
          </div>

          <div class="create-shelf-tile">
            <div class="create-shelf-icon">
              <img src="/logo.png" alt="Vermeil" class="create-shelf-logo" draggable={false} />
            </div>
            <div class="create-shelf-content">
              <div class="create-shelf-title">
                <span>Vermeil Companion</span>
                <span class="create-shelf-tag create-shelf-tag--accent">IN-GAME SYNC</span>
              </div>
              <div class="create-shelf-desc">
                Automatic zero-network animated capes, skin sync, Discord RPC, and telemetry hooks.
              </div>
            </div>
          </div>

          <div class="create-shelf-tile">
            <div class="create-shelf-icon">
              <IconCpu />
            </div>
            <div class="create-shelf-content">
              <div class="create-shelf-title">
                <span>Adaptive Memory</span>
                <span class="create-shelf-tag">JVM OPTIMIZED</span>
              </div>
              <div class="create-shelf-desc">
                Hardware-aware dynamic RAM bounds that scale with installed mod density to prevent OOM.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateChoose;
