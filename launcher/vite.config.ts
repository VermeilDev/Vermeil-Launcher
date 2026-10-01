import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const isDebug = !!process.env.TAURI_ENV_DEBUG;
// @ts-expect-error process is a nodejs global
const platform = process.env.TAURI_ENV_PLATFORM;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Mirrors the recommended Tauri 2 vite config:
  // - `target` is set to the webview engine that Tauri actually ships, so we
  //   skip transpiling for browsers we'll never run in. Windows uses WebView2
  //   (Chromium ≥105). macOS Big Sur (Tauri 2's minimum) ships Safari 14, and
  //   webkit2gtk 2.32+ on Linux is roughly equivalent — but esbuild 0.28
  //   removed destructuring transforms for safari14, so we use `esnext` for
  //   all platforms (Tauri's webview always supports modern ES).
  // - `minify` / `sourcemap` flip on `TAURI_ENV_DEBUG` so debug builds keep
  //   readable stack traces without paying the cost in release.
  // - `chunkSizeWarningLimit` is raised to 1000 because we ship as an MSI
  //   (the bundle never travels over the network), and the only chunk that
  //   exceeds Vite's default is the lazy-loaded `Skins` chunk containing
  //   skinview3d + three.js — already split off the main bundle.
  build: {
    target: "esnext",
    minify: !isDebug,
    sourcemap: isDebug,
    chunkSizeWarningLimit: 1000,
  },

  // esbuild target for dev mode (HMR transform + dependency pre-bundling).
  // Must match build.target so dev and production use identical syntax rules.
  esbuild: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
}));
