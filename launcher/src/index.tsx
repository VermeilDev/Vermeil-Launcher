/* @refresh reload */
// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { render } from "solid-js/web";
import App from "./App";
import LogsPopout from "./screens/LogsPopout";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/logs.css";
import "./styles/notifications.css";
import "./styles/modals.css";
import "./styles/screens.css";
import "./styles/dock.css";
import "./styles/splash.css";
import "./styles/themes.css";
import { openUrl } from "@tauri-apps/plugin-opener";

// Early theme hydration: Read saved theme synchronously before DOM mount to prevent theme flash
try {
  const savedTheme = localStorage.getItem("vermeil-theme");
  if (savedTheme) {
    document.documentElement.setAttribute("data-theme", savedTheme);
  }
} catch {}

// Native app behavior: suppress browser shortcuts and context menu in production
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    // Suppress find-in-page, view-source, and dev tools
    if (
      (e.ctrlKey && e.key === "f") ||
      (e.ctrlKey && e.key === "u") ||
      e.key === "F12"
    ) {
      e.preventDefault();
    }
  });
}

// Intercept all external link clicks — open in system browser, not webview
document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement)?.closest("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
    e.preventDefault();
    openUrl(href);
  }
});

// The logs popout loads this same bundle in a separate window (label "logs").
// Branch on the window label and render only the standalone log viewer there,
// never the full launcher UI (which would spin up a second copy of all the
// app's state). Label is set at window creation, so it's reliable in
// production where URL query strings on tauri:// URLs are easy to mishandle.
const isLogsPopout = getCurrentWindow().label === "logs";

render(
  () => (isLogsPopout ? <LogsPopout /> : <App />),
  document.getElementById("root")!,
);
