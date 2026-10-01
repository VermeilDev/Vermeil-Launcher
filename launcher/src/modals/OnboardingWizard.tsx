// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, Show, For, onMount, onCleanup, createResource } from "solid-js";
import {
  setActiveScreen,
  refetchAccount,
  account,
  showToast,
  refetchCloudStatus,
  refreshPinnedInstanceIds,
  trackDownload,
  completeDownload,
  failDownload,
} from "../App";
import {
  startMsLogin,
  getSettings,
  saveSettings,
  detectJavaInstallations,
  validateJavaPath,
  setJavaPath,
  installRecommendedJava,
  pruneInvalidJavaPaths,
  JavaInstall,
  getSkinProfile,
  connectGoogleCloud,
  cancelGoogleCloud,
} from "../ipc/commands";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  IconDownload,
  IconSearch,
  IconFolderOpen,
  IconLayers,
  IconSettings,
  IconMicrosoft,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconCube,
  IconChevronDown,
  IconChevronRight,
} from "../components/Icons";
import PlayerHead from "../components/PlayerHead";
import JavaPathInput from "../components/JavaPathInput";
import JavaChooserModal from "./JavaChooserModal";
import Dropdown from "../components/Dropdown";
import { javaActionButtonLabel, javaVendorOwner } from "../lib/java";

/**
 * First-run onboarding wizard.
 *
 * Mounted at app level and gated by `<Show when={onboardingOpen()}>`. App.tsx
 * decides whether to show it by checking `settings.onboarded` and
 * `instances.length === 0` on startup.
 *
 * Three steps:
 *   1. Account     — Active identity detection, branded Microsoft sign-in, or offline profile.
 *   2. Environment — Smart automated Java isolation, system runtime detection, and advanced slot config.
 *   3. Ready       — Choice between curated modpacks, custom instance setup, or archive import.
 *
 * Closing the wizard mid-flow flips `onboarded = true` so we don't pester
 * the user again. They can still revisit Settings to configure things.
 */

type WizardStep = 1 | 2 | 3;

const [open, setOpen] = createSignal(false);
const [step, setStep] = createSignal<WizardStep>(1);

/** Open the onboarding wizard from anywhere (e.g. from App.tsx onMount). */
export function openOnboarding() {
  setStep(1);
  setOpen(true);
}

/** Read by App.tsx to know whether to render the wizard at all. */
export const onboardingOpen = open;

/** Persist `onboarded = true` so the wizard never re-appears for this user. */
async function markOnboarded() {
  try {
    const s = await getSettings();
    s.onboarded = true;
    await saveSettings(s);
  } catch (e) {
    console.error("Failed to persist onboarded flag:", e);
  }
}

/**
 * Java majors shown in the wizard. Same set as Settings → Resources → Java.
 * Newest first because that's what most modern instances need (MC 1.21+ / 26+).
 */
const JAVA_SLOTS: number[] = [25, 21, 17, 8];

const OnboardingWizard: Component = () => {
  const [appVersion] = createResource(getVersion);
  const [loggingIn, setLoggingIn] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showAddAccount, setShowAddAccount] = createSignal(false);
  const [restoringCloud, setRestoringCloud] = createSignal(false);

  // Java step state.
  const [javaDetections, setJavaDetections] = createSignal<JavaInstall[]>([]);
  const [javaPaths, setJavaPaths] = createSignal<Record<number, string>>({});
  const [javaRuntime, setJavaRuntime] = createSignal<string>("adoptium");
  const [javaBusy, setJavaBusy] = createSignal<Record<number, "install" | "detect" | "browse" | null>>({});
  const [detectingAll, setDetectingAll] = createSignal(false);
  const [showAdvancedJava, setShowAdvancedJava] = createSignal(false);

  const handleRuntimeChange = async (val: string) => {
    setJavaRuntime(val);
    try {
      const s = await getSettings();
      s.java_runtime = val;
      await saveSettings(s);
    } catch (e) {
      console.error("Failed to save java_runtime:", e);
    }
  };

  const runtimeDisplayName = () => {
    switch (javaRuntime()) {
      case "zulu": return "Azul Zulu";
      case "corretto": return "Amazon Corretto";
      default: return "Adoptium";
    }
  };

  const setJavaSlotBusy = (m: number, b: "install" | "detect" | "browse" | null) =>
    setJavaBusy((prev) => ({ ...prev, [m]: b }));

  // Chooser modal state — surfaced when Detect returns more than one match for a major.
  const [chooser, setChooser] = createSignal<{ major: number; options: JavaInstall[] } | null>(null);

  // Active account skin texture URL
  const [skinUrl] = createResource(
    () => account(),
    async (acc) => {
      if (!acc) return null;
      try {
        const profile = await getSkinProfile();
        const active = profile.skins.find((s) => s.state === "ACTIVE") ?? profile.skins[0];
        return active?.texture ?? null;
      } catch {
        return null;
      }
    }
  );

  /** Best-known path for a major: user-set > detected. */
  const javaPathFor = (major: number): string => {
    const userSet = javaPaths()[major];
    if (userSet) return userSet;
    return javaDetections().find((i) => i.major === major)?.path ?? "";
  };

  // Initialize configured paths, background detection, and stale path pruning.
  onMount(() => {
    getSettings()
      .then((s) => {
        setJavaPaths(s.java_paths || {});
        setJavaRuntime(s.java_runtime === "auto" ? "adoptium" : (s.java_runtime || "adoptium"));
      })
      .catch(() => {});
    pruneInvalidJavaPaths()
      .then((cleared) => {
        if (cleared.length === 0) return;
        setJavaPaths((prev) => {
          const next = { ...prev };
          for (const m of cleared) delete next[m];
          return next;
        });
        for (const m of cleared) {
          showToast({
            title: `Java ${m} path cleared`,
            message: "The previous file no longer exists on disk.",
            type: "info",
          });
        }
      })
      .catch((e) => console.error("Java path prune failed:", e));
    detectJavaInstallations()
      .then(setJavaDetections)
      .catch(() => {});
  });

  const close = async () => {
    await markOnboarded();
    setOpen(false);
  };

  const handleMicrosoftLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await startMsLogin();
      await refetchAccount();
      setShowAddAccount(false);
      setStep(2);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message || "Login failed";
      if (msg !== "Login cancelled") setError(msg);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleCloudConnect = async () => {
    if (restoringCloud()) return;
    setRestoringCloud(true);
    setError(null);
    showToast({
      title: "Authorizing with Google",
      message: "Check your browser to approve Google Cloud access...",
      type: "info",
    });
    try {
      const summary = await connectGoogleCloud();
      await refetchCloudStatus();
      await refreshPinnedInstanceIds();
      await refetchAccount();
      showToast({
        title: summary.restored ? "Settings Restored from Cloud" : "Google Cloud Connected",
        message: summary.details,
        type: "success",
      });
      if (account()) {
        setStep(2);
      }
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Failed to connect to Google Cloud";
      if (!msg.toLowerCase().includes("cancel")) {
        setError(msg);
        showToast({
          title: "Connection Failed",
          message: msg,
          type: "error",
        });
      } else {
        showToast({
          title: "Sign-In Cancelled",
          message: "Google authorization was cancelled.",
          type: "info",
        });
      }
    } finally {
      setRestoringCloud(false);
    }
  };

  const handleCancelCloud = async () => {
    try {
      await cancelGoogleCloud();
    } catch {}
    setRestoringCloud(false);
  };

  onCleanup(() => {
    if (restoringCloud()) {
      cancelGoogleCloud().catch(() => {});
    }
  });

  // ─── Java step actions ──────────────────────────────────────────────────

  const handleAutoConfigureAll = async () => {
    setDetectingAll(true);
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      let boundCount = 0;
      const nextPaths = { ...javaPaths() };

      for (const major of JAVA_SLOTS) {
        if (!nextPaths[major]) {
          const match = found.find((i) => i.major === major);
          if (match) {
            await setJavaPath(major, match.path);
            nextPaths[major] = match.path;
            boundCount++;
          }
        }
      }

      setJavaPaths(nextPaths);
      if (boundCount > 0) {
        showToast({
          title: "System Runtimes Configured",
          message: `Bound ${boundCount} detected Java installation${boundCount > 1 ? "s" : ""} to your profile.`,
          type: "success",
        });
      } else if (found.length > 0) {
        showToast({
          title: "Already Up to Date",
          message: "Detected runtimes are already configured.",
          type: "info",
        });
      } else {
        showToast({
          title: "No System Java Found",
          message: `Vermeil will automatically download official ${runtimeDisplayName()} JREs when you launch your game.`,
          type: "info",
        });
      }
    } catch (e) {
      showToast({ title: "Detection failed", message: String(e), type: "error" });
    } finally {
      setDetectingAll(false);
    }
  };

  const handleJavaInstall = async (major: number) => {
    if (javaBusy()[major]) return;
    setJavaSlotBusy(major, "install");
    const distroName = runtimeDisplayName();
    const ownerName = javaVendorOwner(javaRuntime());
    const dlId = trackDownload(`Java ${major} (${distroName})`, "java", {
      gameVersion: `Java ${major}`,
      versionNumber: `JDK ${major}`,
      author: ownerName,
    });
    try {
      const install = await installRecommendedJava(major);
      setJavaPaths((prev) => ({ ...prev, [major]: install.path }));
      setJavaDetections((prev) => {
        const without = prev.filter((i) => i.path !== install.path);
        return [...without, install];
      });
      completeDownload(
        dlId,
        `Java ${major} (${distroName})`,
        install.full_version,
        {
          gameVersion: `Java ${major}`,
          author: ownerName,
        }
      );
    } catch (e) {
      failDownload(dlId, String(e));
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const handleJavaDetect = async (major: number) => {
    setJavaSlotBusy(major, "detect");
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      const matches = found.filter((i) => i.major === major);
      if (matches.length === 0) {
        showToast({
          title: `Java ${major} not found`,
          message: "Try Install recommended or Browse to point at a JDK.",
          type: "info",
        });
      } else if (matches.length === 1) {
        await applyDetection(major, matches[0]);
      } else {
        setChooser({ major, options: matches });
      }
    } catch (e) {
      showToast({ title: "Detection failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const applyDetection = async (major: number, install: JavaInstall) => {
    await setJavaPath(major, install.path);
    setJavaPaths((prev) => ({ ...prev, [major]: install.path }));
    setJavaDetections((prev) => {
      const without = prev.filter((i) => i.path !== install.path);
      return [...without, install];
    });
    showToast({ title: `Java ${major} set`, message: install.path, type: "success" });
  };

  const handleJavaBrowse = async (major: number) => {
    setJavaSlotBusy(major, "browse");
    try {
      const isWin = navigator.userAgent.includes("Windows");
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: isWin ? [{ name: "Java executable", extensions: ["exe"] }] : [],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const install = await validateJavaPath(path);
      if (install.major !== major) {
        showToast({
          title: `That's Java ${install.major}, not ${major}`,
          message: "Pick a JRE matching the requested major version.",
          type: "warning",
        });
        return;
      }
      await setJavaPath(major, install.path);
      setJavaPaths((prev) => ({ ...prev, [major]: install.path }));
      setJavaDetections((prev) => {
        const without = prev.filter((i) => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} updated`, message: install.path, type: "success" });
    } catch (e) {
      showToast({ title: "Browse failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  // ─── Final-step navigation ──────────────────────────────────────────────

  const goToModpacks = async () => {
    await markOnboarded();
    setOpen(false);
    setActiveScreen("create-modpack");
  };

  const goToCustom = async () => {
    await markOnboarded();
    setOpen(false);
    setActiveScreen("create-custom");
  };

  const goToImport = async () => {
    await markOnboarded();
    setOpen(false);
    setActiveScreen("create-import");
  };

  const canGoToStep = (target: WizardStep) => {
    if (target === step()) return false;
    if (target < step()) return true;
    if (target === 2) return Boolean(account());
    if (target === 3) return Boolean(account());
    return false;
  };

  return (
    <Show when={open()}>
      <div class="modal-overlay">
        <div class="modal onboarding-modal">
          {/* Tactile Branding Header */}
          <div class="onboarding-header">
            <div class="onboarding-brand">
              <span class="onboarding-brand-title">Vermeil</span>
              <span class="card-section-tag tag-settings-general">
                {appVersion() ? `v${appVersion()}` : "v..."}
              </span>
            </div>
          </div>

          {/* Progress Stepper */}
          <div class="onboarding-stepper">
            <div
              class={`onboarding-step-key ${step() === 1 ? "active" : ""} ${step() > 1 ? "completed" : ""}`}
              onClick={() => canGoToStep(1) && setStep(1)}
            >
              <span class="onboarding-step-num">
                <Show when={step() > 1} fallback="01">
                  <IconCheck />
                </Show>
              </span>
              <span class="onboarding-step-label">Account</span>
            </div>

            <div class={`onboarding-step-divider ${step() >= 2 ? "active" : ""}`} />

            <div
              class={`onboarding-step-key ${step() === 2 ? "active" : ""} ${step() > 2 ? "completed" : ""} ${!canGoToStep(2) && step() < 2 ? "disabled" : ""}`}
              onClick={() => canGoToStep(2) && setStep(2)}
            >
              <span class="onboarding-step-num">
                <Show when={step() > 2} fallback="02">
                  <IconCheck />
                </Show>
              </span>
              <span class="onboarding-step-label">Environment</span>
            </div>

            <div class={`onboarding-step-divider ${step() >= 3 ? "active" : ""}`} />

            <div
              class={`onboarding-step-key ${step() === 3 ? "active" : ""} ${!canGoToStep(3) && step() < 3 ? "disabled" : ""}`}
              onClick={() => canGoToStep(3) && setStep(3)}
            >
              <span class="onboarding-step-num">03</span>
              <span class="onboarding-step-label">Ready</span>
            </div>
          </div>

          {/* Step 1: Account Station */}
          <Show when={step() === 1}>
            <div class="modal-body">
              <div class="onboarding-heading">Account Setup</div>
              <div class="onboarding-subtext">
                Sign in with an official Microsoft account that owns Minecraft Java Edition to link your license and access multiplayer, realms, and skins.
              </div>

              <Show when={account()}>
                <div class="onboarding-active-account">
                  <PlayerHead
                    skinUrl={skinUrl()}
                    name={account()!.name}
                    size={42}
                  />
                  <div class="onboarding-active-info">
                    <div class="onboarding-active-name">{account()!.name}</div>
                    <div class="onboarding-active-badge">
                      <IconMicrosoft />
                      <span>Microsoft Account</span>
                    </div>
                  </div>
                  <div class="onboarding-active-status">
                    <IconCheck />
                    <span>Active</span>
                  </div>
                </div>

                <button
                  class="onboarding-switch-btn"
                  onClick={() => setShowAddAccount(!showAddAccount())}
                >
                  {showAddAccount() ? "Hide account options" : "Switch or add another account..."}
                </button>
              </Show>

              <Show when={!account() || showAddAccount()}>
                <div>
                  <button
                    class="btn btn--primary onboarding-ms-btn"
                    onClick={handleMicrosoftLogin}
                    disabled={loggingIn()}
                  >
                    <IconMicrosoft />
                    <span>{loggingIn() ? "Connecting to Microsoft..." : "Sign in with Microsoft"}</span>
                  </button>

                  <div class="onboarding-or">// OR RESTORE FROM CLOUD</div>

                  <Show
                    when={restoringCloud()}
                    fallback={
                      <button
                        class="btn btn--neutral onboarding-cloud-btn"
                        onClick={handleCloudConnect}
                      >
                        Restore from Google Cloud
                      </button>
                    }
                  >
                    <button
                      class="btn btn--secondary onboarding-cloud-btn"
                      onClick={handleCancelCloud}
                      data-tip="Click to abort Google sign-in"
                    >
                      Cancel
                    </button>
                  </Show>
                </div>
              </Show>

              <Show when={error()}>
                <div class="onboarding-error">
                  <IconAlertTriangle />
                  <span>{error()}</span>
                  <button onClick={() => setError(null)}>
                    <IconX />
                  </button>
                </div>
              </Show>
            </div>

            <div class="modal-footer">
              <button class="btn btn--ghost" onClick={close}>Skip setup</button>
              <button
                class="btn btn--primary"
                onClick={() => setStep(2)}
                disabled={!account()}
              >
                Next: Environment
              </button>
            </div>
          </Show>

          {/* Step 2: Java Runtime Environment */}
          <Show when={step() === 2}>
            <div class="modal-body">
              <div class="onboarding-heading">Java Runtime Environment</div>
              <div class="onboarding-subtext">
                Minecraft versions require matching Java versions (Java 21 for 1.20.5+, Java 17 for 1.18+, Java 8 for 1.16-).
              </div>

              {/* Recommendation card with Distribution Selector */}
              <div class="onboarding-java-hero">
                <div class="onboarding-hero-top">
                  <span class="card-section-tag tag-settings-performance">AUTOMATIC RUNTIME</span>
                  <span class="onboarding-hero-title">Zero-Configuration Isolation (Recommended)</span>
                </div>
                <div class="onboarding-hero-desc">
                  Vermeil automatically detects and downloads isolated OpenJDK runtimes when launching any Minecraft version. Choose your preferred distribution:
                </div>
                <div class="onboarding-runtime-row">
                  <span class="onboarding-runtime-label">Managed Distribution</span>
                  <Dropdown
                    value={javaRuntime()}
                    options={[
                      { value: "adoptium", label: "Adoptium (Temurin · Default)" },
                      { value: "zulu", label: "Azul Zulu" },
                      { value: "corretto", label: "Amazon Corretto" },
                    ]}
                    onChange={handleRuntimeChange}
                  />
                </div>
              </div>

              {/* Detected runtimes banner */}
              <Show when={javaDetections().length > 0}>
                <div class="onboarding-detected-banner">
                  <div class="onboarding-detected-info">
                    <div class="onboarding-detected-title">
                      {javaDetections().length} System Runtime{javaDetections().length > 1 ? "s" : ""} Found
                    </div>
                    <div class="onboarding-detected-list">
                      {javaDetections().map((d) => `Java ${d.major} (${d.source.replace("_", " ")})`).join(" · ")}
                    </div>
                  </div>
                  <button
                    class="btn btn--sm btn--neutral"
                    onClick={handleAutoConfigureAll}
                    disabled={detectingAll()}
                  >
                    <IconSearch />
                    <span>{detectingAll() ? "Configuring..." : "Auto-Bind"}</span>
                  </button>
                </div>
              </Show>

              {/* Advanced toggle */}
              <button
                class="onboarding-accordion-toggle"
                onClick={() => setShowAdvancedJava(!showAdvancedJava())}
              >
                <div style="display:flex;align-items:center;gap:8px">
                  <IconSettings />
                  <span>Configure Specific Slots (Java 25, 21, 17, 8)</span>
                </div>
                <Show when={showAdvancedJava()} fallback={<IconChevronRight />}>
                  <IconChevronDown />
                </Show>
              </button>

              <Show when={showAdvancedJava()}>
                <div class="onboarding-advanced-well">
                  <For each={JAVA_SLOTS}>
                    {(major) => {
                      const det = () => javaDetections().find((i) => i.major === major);
                      const path = () => javaPathFor(major);
                      const installed = () => Boolean(path());
                      const busy = () => javaBusy()[major] ?? null;
                      return (
                        <div class="java-slot" style="margin-bottom:0">
                          <div class="java-slot-title">Java {major} Location</div>
                          <JavaPathInput
                            major={major}
                            value={path()}
                            placeholder="Auto-provisions on first play"
                            disabled={busy() !== null}
                            onCommit={async (newPath) => {
                              setJavaPaths((prev) => {
                                const next = { ...prev };
                                if (newPath) next[major] = newPath;
                                else delete next[major];
                                return next;
                              });
                              if (newPath) {
                                try {
                                  const install = await validateJavaPath(newPath);
                                  setJavaDetections((prev) => {
                                    const without = prev.filter((i) => i.path !== install.path);
                                    return [...without, install];
                                  });
                                } catch {
                                  // Handled in JavaPathInput
                                }
                              }
                            }}
                          />
                          <Show when={det() && installed()}>
                            <div class="java-slot-meta">
                              {det()!.full_version} · {det()!.arch} · {det()!.source.replace("_", " ")}
                            </div>
                          </Show>
                          <div class="java-slot-actions">
                            <button
                              class={`btn btn--sm ${installed() ? "btn--neutral" : "btn--primary"} tip-below`}
                              data-tip={installed() ? `Replace with official ${runtimeDisplayName()} build` : `Download official ${runtimeDisplayName()} JDK`}
                              onClick={() => handleJavaInstall(major)}
                              disabled={busy() !== null}
                            >
                              <IconDownload />
                              <span>{javaActionButtonLabel(installed(), path(), det()?.full_version, javaRuntime(), busy() === "install")}</span>
                            </button>
                            <button
                              class="btn btn--sm btn--neutral tip-below"
                              data-tip={`Search system for Java ${major}`}
                              onClick={() => handleJavaDetect(major)}
                              disabled={busy() !== null}
                            >
                              <IconSearch />
                              <span>{busy() === "detect" ? "Detecting..." : "Detect"}</span>
                            </button>
                            <button
                              class="btn btn--sm btn--neutral tip-below tip-right"
                              data-tip="Browse filesystem for javaw.exe"
                              onClick={() => handleJavaBrowse(major)}
                              disabled={busy() !== null}
                            >
                              <IconFolderOpen />
                              <span>{busy() === "browse" ? "Picking..." : "Browse"}</span>
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="modal-footer">
              <button class="btn btn--ghost" onClick={() => setStep(1)}>Back</button>
              <button class="btn btn--primary" onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </Show>

          {/* Step 3: First instance choice */}
          <Show when={step() === 3}>
            <div class="modal-body">
              <div class="onboarding-heading">Ready to Play</div>
              <div class="onboarding-subtext">
                Your launcher is ready. Choose how you'd like to create your first Minecraft instance:
              </div>

              <div class="onboarding-choices">
                <div
                  class="onboarding-choice-card onboarding-choice-card--modpack"
                  onClick={goToModpacks}
                >
                  <div class="onboarding-choice-icon" style="color:var(--accent)">
                    <IconLayers />
                  </div>
                  <div class="onboarding-choice-info">
                    <div class="onboarding-choice-header">
                      <span class="card-section-tag tag-settings-general">CURATED</span>
                      <span class="onboarding-choice-title">Browse Modpacks</span>
                    </div>
                    <div class="onboarding-choice-desc">
                      Explore and install thousands of community modpacks from Modrinth and CurseForge with one-click setup.
                    </div>
                  </div>
                </div>

                <div
                  class="onboarding-choice-card onboarding-choice-card--custom"
                  onClick={goToCustom}
                >
                  <div class="onboarding-choice-icon" style="color:var(--success)">
                    <IconCube />
                  </div>
                  <div class="onboarding-choice-info">
                    <div class="onboarding-choice-header">
                      <span class="card-section-tag tag-settings-performance">VANILLA & MODDED</span>
                      <span class="onboarding-choice-title">Custom Instance</span>
                    </div>
                    <div class="onboarding-choice-desc">
                      Choose any Minecraft version and configure Fabric, NeoForge, Forge, Quilt, or Vanilla directly.
                    </div>
                  </div>
                </div>

                <div
                  class="onboarding-choice-card onboarding-choice-card--import"
                  onClick={goToImport}
                >
                  <div class="onboarding-choice-icon" style="color:var(--warn)">
                    <IconFolderOpen />
                  </div>
                  <div class="onboarding-choice-info">
                    <div class="onboarding-choice-header">
                      <span class="card-section-tag tag-settings-storage">LOCAL ARCHIVE</span>
                      <span class="onboarding-choice-title">Import Modpack</span>
                    </div>
                    <div class="onboarding-choice-desc">
                      Import an existing .mrpack (Modrinth) or .zip (CurseForge) archive file directly from your computer.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="modal-footer">
              <button class="btn btn--ghost" onClick={() => setStep(2)}>Back</button>
              <button class="btn btn--ghost" onClick={close}>I'll decide later</button>
            </div>
          </Show>
        </div>
      </div>

      {/* Chooser modal — sibling of the wizard's overlay so it stacks on top via DOM order. */}
      <Show when={chooser()}>
        <JavaChooserModal
          major={chooser()!.major}
          options={chooser()!.options}
          onCancel={() => setChooser(null)}
          onPick={async (install) => {
            const major = chooser()!.major;
            setChooser(null);
            await applyDetection(major, install);
          }}
        />
      </Show>
    </Show>
  );
};

export default OnboardingWizard;
