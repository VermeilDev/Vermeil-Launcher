// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component } from "solid-js";
import { setActiveScreen } from "../App";
import {
  IconSettings,
  IconLayers,
  IconDownload,
  IconArrowRight,
  IconShieldCheck,
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
          <div class="create-hero-card create-hero-card--accent" onClick={() => setActiveScreen("create-custom")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--accent">
                <IconSettings />
              </div>
              <span class="create-hero-badge create-hero-badge--accent">MANUAL CONFIG</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Custom Setup</div>
              <div class="create-hero-desc">
                Build an instance from scratch with your choice of loader and version.
              </div>
              <div class="create-hero-tags">
                <span class="create-tag-chip">Vanilla</span>
                <span class="create-tag-chip">Fabric</span>
                <span class="create-tag-chip">NeoForge</span>
                <span class="create-tag-chip">Forge</span>
                <span class="create-tag-chip">Quilt</span>
              </div>
            </div>
            <button class="create-hero-btn create-hero-btn--accent" type="button">
              <span>Configure Instance</span>
              <IconArrowRight />
            </button>
          </div>

          {/* Pillar 2: Install Modpack */}
          <div class="create-hero-card create-hero-card--info" onClick={() => setActiveScreen("create-modpack")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--info">
                <IconLayers />
              </div>
              <span class="create-hero-badge create-hero-badge--info">COMMUNITY</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Install Modpack</div>
              <div class="create-hero-desc">
                Browse and download curated community modpacks from Modrinth and CurseForge.
              </div>
              <div class="create-hero-tags">
                <span class="create-tag-chip">Modrinth</span>
                <span class="create-tag-chip">CurseForge</span>
                <span class="create-tag-chip">1-Click Install</span>
              </div>
            </div>
            <button class="create-hero-btn create-hero-btn--info" type="button">
              <span>Explore Modpacks</span>
              <IconArrowRight />
            </button>
          </div>

          {/* Pillar 3: Import Archive */}
          <div class="create-hero-card create-hero-card--warn" onClick={() => setActiveScreen("create-import")}>
            <div class="create-hero-card-top">
              <div class="create-hero-icon-box create-hero-icon--warn">
                <IconDownload />
              </div>
              <span class="create-hero-badge create-hero-badge--warn">ARCHIVE</span>
            </div>
            <div class="create-hero-card-body">
              <div class="create-hero-title">Import Archive</div>
              <div class="create-hero-desc">
                Ingest .mrpack or .zip archives, or restore from serverless share codes.
              </div>
              <div class="create-hero-tags">
                <span class="create-tag-chip">.mrpack</span>
                <span class="create-tag-chip">.zip (CurseForge)</span>
                <span class="create-tag-chip">Share Code</span>
              </div>
            </div>
            <button class="create-hero-btn create-hero-btn--warn" type="button">
              <span>Import Archive</span>
              <IconArrowRight />
            </button>
          </div>
        </div>

        {/* Clean Isolation Footer Hint */}
        <div class="create-hub-footer-hint">
          <IconShieldCheck />
          <span>Every instance runs in an isolated sandbox with dedicated mods, configs, and saves.</span>
        </div>
      </div>
    </div>
  );
};

export default CreateChoose;
