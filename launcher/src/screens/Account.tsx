// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { Component, createSignal, createResource, createEffect, onCleanup, Show, For } from "solid-js";
import {
  account,
  activeSkinUrl,
  refetchAccount,
  showToast,
  cloudConnected,
  refetchCloudStatus,
  refreshPinnedInstanceIds,
  refreshActiveSkin,
  setActiveScreen,
} from "../App";
import {
  startMsLogin,
  getAllAccounts,
  setActiveAccount,
  removeAccount,
  getAccountSkin,
  connectGoogleCloud,
  cancelGoogleCloud,
  disconnectGoogleCloud,
  signOutGoogleCloud,
  backupToGoogleCloud,
  getLastCloudBackupTime,
} from "../ipc/commands";
import PlayerHead from "../components/PlayerHead";
import {
  IconX,
  IconTrash,
  IconPlus,
  IconUser,
  IconShieldCheck,
  IconAlertTriangle,
  IconGoogleCloud,
  IconRefresh,
  IconShirt,
  IconClipboard,
  IconClock,
  IconMicrosoft,
  IconCloud,
  IconCloudSync,
} from "../components/Icons";
import type { MinecraftProfile } from "../ipc/commands";

/**
 * Cache of skin data URLs per account ID, keyed by Microsoft account UUID.
 * Lives at module scope so re-renders don't blow it away. Each entry is
 * fetched lazily on first render and reused thereafter — without this,
 * switching the active account would clear all the inactive accounts' skin
 * heads back to the colored-initial fallback.
 */
const [skinCache, setSkinCache] = createSignal<Record<string, string>>({});

/** Force-refresh a specific account's cached skin, e.g. after a skin upload. */
export function invalidateAccountSkin(accountId: string) {
  setSkinCache(prev => {
    const next = { ...prev };
    delete next[accountId];
    return next;
  });
}

const Account: Component = () => {
  const [loggingIn, setLoggingIn] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [refreshingProfile, setRefreshingProfile] = createSignal(false);
  const [accounts, { refetch: refetchAccounts }] = createResource(getAllAccounts);
  const [lastBackup, { refetch: refetchBackupTime }] = createResource(getLastCloudBackupTime);
  const [cloudBusy, setCloudBusy] = createSignal(false);

  const formatBackupDate = (iso: string | null | undefined): string => {
    if (!iso) return "No cloud backup found yet";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const handleConnectGoogle = async () => {
    if (cloudBusy()) return;
    setCloudBusy(true);
    showToast({
      title: "Authorizing with Google",
      message: "Check your browser to approve Google Cloud access...",
      type: "info",
    });
    try {
      const summary = await connectGoogleCloud();
      await refetchCloudStatus();
      await refetchBackupTime();
      await refreshPinnedInstanceIds();
      if (summary.restored) {
        await refetchAccount();
        await refetchAccounts();
      }
      showToast({
        title: summary.restored ? "Settings Restored from Cloud" : "Google Cloud Connected",
        message: summary.details,
        type: "success",
      });
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Google Cloud sign-in failed";
      if (!msg.toLowerCase().includes("cancel")) {
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
      setCloudBusy(false);
    }
  };

  const handleCancelGoogle = async () => {
    try {
      await cancelGoogleCloud();
    } catch {}
    setCloudBusy(false);
  };

  onCleanup(() => {
    if (cloudBusy()) {
      cancelGoogleCloud().catch(() => {});
    }
  });

  const handleSyncCloudNow = async () => {
    if (cloudBusy()) return;
    setCloudBusy(true);
    try {
      await backupToGoogleCloud();
      await refetchCloudStatus();
      await refetchBackupTime();
      showToast({
        title: "Backup Complete",
        message: "Preferences synchronized to Google Drive.",
        type: "success",
      });
    } catch (e: any) {
      showToast({
        title: "Backup Failed",
        message: String(e),
        type: "error",
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    if (cloudBusy()) return;
    setCloudBusy(true);
    try {
      await disconnectGoogleCloud();
      await refetchCloudStatus();
      await refetchBackupTime();
      showToast({
        title: "Unlinked & Disconnected",
        message: "Google authorization revoked from Google account and local tokens removed.",
        type: "info",
      });
    } catch (e: any) {
      showToast({
        title: "Disconnect Error",
        message: String(e),
        type: "error",
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleSignOutGoogle = async () => {
    if (cloudBusy()) return;
    setCloudBusy(true);
    try {
      await signOutGoogleCloud();
      await refetchCloudStatus();
      await refetchBackupTime();
      showToast({
        title: "Signed Out",
        message: "Signed out of Google Cloud. Local access & refresh tokens removed.",
        type: "info",
      });
    } catch (e: any) {
      showToast({
        title: "Sign-Out Error",
        message: String(e),
        type: "error",
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleRefreshProfile = async () => {
    if (refreshingProfile()) return;
    setRefreshingProfile(true);
    try {
      await refetchAccount();
      await refetchAccounts();
      await refreshActiveSkin();
      const a = account();
      if (a) {
        invalidateAccountSkin(a.id);
      }
      showToast({
        title: "Profile Refreshed",
        message: "Mojang profile and skin cache refreshed.",
        type: "success",
      });
    } catch (e: any) {
      showToast({
        title: "Refresh Error",
        message: String(e),
        type: "error",
      });
    } finally {
      setRefreshingProfile(false);
    }
  };

  const copyUuid = (uuid: string) => {
    navigator.clipboard.writeText(uuid);
    showToast({
      title: "UUID Copied",
      message: "Player UUID copied to clipboard.",
      type: "info",
    });
  };

  // Cache skins for each account in the list
  createEffect(() => {
    const list = accounts();
    if (!list) return;
    for (const acc of list) {
      if (skinCache()[acc.id]) continue;
      getAccountSkin(acc.id)
        .then((url) => {
          if (url) {
            setSkinCache(prev => ({ ...prev, [acc.id]: url }));
          }
        })
        .catch(() => {});
    }
  });

  // Mirror active skin into cache
  createEffect(() => {
    const activeUrl = activeSkinUrl();
    const a = account();
    if (activeUrl && a) {
      setSkinCache(prev => ({ ...prev, [a.id]: activeUrl }));
    }
  });

  const handleLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await startMsLogin();
      await refetchAccount();
      await refetchAccounts();
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message || "Login failed";
      if (msg !== "Login cancelled") {
        setError(msg);
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const handleSwitch = async (id: string) => {
    await setActiveAccount(id);
    await refetchAccount();
    await refetchAccounts();
  };

  const handleRemove = async (id: string) => {
    await removeAccount(id);
    await refetchAccount();
    await refetchAccounts();
    setSkinCache(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const skinFor = (acc: MinecraftProfile): string | null => {
    return skinCache()[acc.id] ?? null;
  };

  const isAccountExpired = (acc: MinecraftProfile): boolean => {
    const a = account();
    if (a && a.id === acc.id && a.needs_reauth) return true;
    return !!acc.needs_reauth;
  };

  return (
    <div class="screen-enter account-screen">
      {/* Page Header with Telemetry Meta Readout */}
      <div class="page-header account-page-header">
        <div class="page-title-group">
          <div class="page-title">Accounts</div>
          <div class="page-subtitle">// Manage saved profiles, active identities, and authentication methods</div>
        </div>
        <div class="account-header-meta">
          <div class="header-meta-pill tip-below" data-tip="Active profile authentication">
            <Show
              when={account()}
              fallback={
                <>
                  <IconUser class="header-pill-icon" />
                  <span>Account: <strong>Not Signed In</strong></span>
                </>
              }
            >
              <IconMicrosoft class="header-pill-icon" />
              <span>Microsoft: <strong>{account()!.name}</strong></span>
            </Show>
          </div>
          <div class="header-meta-pill tip-below tip-right" data-tip="Google Cloud Settings Sync">
            <Show
              when={cloudConnected()}
              fallback={
                <>
                  <span style="opacity: 0.6; display: inline-flex;"><IconCloud class="header-pill-icon" /></span>
                  <span>Cloud: <strong>Off</strong></span>
                </>
              }
            >
              <span style="color: #34d399; display: inline-flex;"><IconCloudSync class="header-pill-icon" /></span>
              <span>Cloud: <strong style="color: #34d399;">Synced</strong></span>
            </Show>
          </div>
        </div>
      </div>

      {/* Error alert banner */}
      <Show when={error()}>
        <div class="account-error-banner">
          <IconAlertTriangle />
          <div class="account-error-msg">{error()}</div>
          <button type="button" class="account-error-dismiss tip-right" onClick={() => setError(null)} data-tip="Dismiss">
            <IconX />
          </button>
        </div>
      </Show>

      {/* ═══ BENTO STUDIO GRID ═══ */}
      <div class="account-bento-grid">

        {/* ── CARD 1: ACTIVE IDENTITY HERO (SPAN 2) ── */}
        <div class="card-gamemode-section account-bento-span-2">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconUser />
              <span>Active Identity</span>
            </div>
          </div>

          <div class="card-section-body">
            <Show
              when={account()}
              fallback={
                <div class="account-empty-hero">
                  <div class="account-empty-hero-icon">
                    <IconUser />
                  </div>
                  <div class="account-empty-hero-text">
                    <div class="account-empty-title">No Active Identity</div>
                    <div class="account-empty-desc">
                      Sign in with an official Microsoft account to authenticate and start playing.
                    </div>
                  </div>
                </div>
              }
            >
              <div class="account-hero-content">
                <div class="account-hero-avatar-frame">
                  <PlayerHead
                    skinUrl={activeSkinUrl()}
                    name={account()!.name}
                    size={56}
                  />
                </div>

                <div class="account-hero-info">
                  <div class="account-hero-name-row">
                    <span class="account-hero-name">{account()!.name}</span>
                    <span class="bento-badge bento-badge-accent">MINECRAFT: JAVA EDITION</span>
                  </div>

                  <div class="account-hero-specs">
                    <span>Account UUID:</span>
                    <button
                      type="button"
                      class="account-uuid-chip tip-below"
                      data-tip="Click to copy full UUID"
                      onClick={() => copyUuid(account()!.id)}
                    >
                      <span>{account()!.id}</span>
                      <IconClipboard />
                    </button>
                  </div>
                </div>
              </div>

              <div class="account-hero-actions">
                <button
                  type="button"
                  class="btn btn--primary btn--sm"
                  onClick={() => setActiveScreen("skins")}
                >
                  <IconShirt />
                  <span>Character Studio</span>
                </button>

                <button
                  type="button"
                  class="btn btn--neutral btn--sm"
                  onClick={handleRefreshProfile}
                  disabled={refreshingProfile()}
                >
                  <span class={refreshingProfile() ? "icon-spin" : ""} style="display: inline-flex; align-items: center; justify-content: center;">
                    <IconRefresh />
                  </span>
                  <span>{refreshingProfile() ? "Refreshing..." : "Refresh Profile"}</span>
                </button>
              </div>
            </Show>
          </div>
        </div>

        {/* ── CARD 2: GOOGLE CLOUD BAY (SPAN 1) ── */}
        <div class="card-gamemode-section">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconGoogleCloud />
              <span>Google Cloud Sync</span>
            </div>
          </div>

          <div class="card-section-body account-cloud-body">
            <div class="account-cloud-info-plate">
              <div class="account-cloud-title">Sandboxed Drive Backup</div>
              <div class="account-cloud-desc">
                Themes, keybinds, and monotonic playtime are safely preserved across devices without telemetry servers.
              </div>
              <div class="account-cloud-timestamp">
                <IconClock />
                <span>LAST: {cloudConnected() ? (lastBackup() ? formatBackupDate(lastBackup()!) : "Pending First Sync") : "Not Connected"}</span>
              </div>
            </div>

            <div class="account-cloud-actions">
              <Show
                when={cloudConnected()}
                fallback={
                  <Show
                    when={cloudBusy()}
                    fallback={
                      <button
                        type="button"
                        class="btn btn--primary btn--sm"
                        style="width: 100%;"
                        onClick={handleConnectGoogle}
                      >
                        <IconGoogleCloud />
                        <span>Connect Google Drive</span>
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="btn btn--neutral btn--sm"
                      style="width: 100%;"
                      onClick={handleCancelGoogle}
                    >
                      Cancel Authorization
                    </button>
                  </Show>
                }
              >
                <Show
                  when={cloudBusy()}
                  fallback={
                    <>
                      <button
                        type="button"
                        class="btn btn--neutral btn--sm"
                        style="flex: 1;"
                        onClick={handleSyncCloudNow}
                      >
                        <IconRefresh />
                        <span>Sync Now</span>
                      </button>
                      <button
                        type="button"
                        class="btn btn--neutral btn--sm"
                        onClick={handleSignOutGoogle}
                        data-tip="Sign out locally"
                      >
                        Sign Out
                      </button>
                      <button
                        type="button"
                        class="btn btn--danger btn--sm tip-right"
                        onClick={handleDisconnectGoogle}
                        data-tip="Unlink Google account"
                      >
                        Disconnect
                      </button>
                    </>
                  }
                >
                  <div style="display: flex; gap: 8px; width: 100%;">
                    <button
                      type="button"
                      class="btn btn--neutral btn--sm"
                      style="flex: 1;"
                      disabled
                    >
                      <span class="icon-spin" style="display: inline-flex; align-items: center; justify-content: center;">
                        <IconRefresh />
                      </span>
                      <span>Working...</span>
                    </button>
                    <button
                      type="button"
                      class="btn btn--neutral btn--sm tip-right"
                      onClick={handleCancelGoogle}
                      data-tip="Abort cloud operation"
                    >
                      Cancel
                    </button>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        {/* ── CARD 3: SAVED PROFILES DOCK (SPAN 1) ── */}
        <div class="card-gamemode-section">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconUser />
              <span>Saved Profiles</span>
            </div>
            <span class="bento-badge">{accounts() ? `${accounts()!.length} PROFILES` : "0 PROFILES"}</span>
          </div>

          <div class="card-section-body account-profiles-body">
            <div class="account-profiles-list">
              <Show
                when={accounts() && accounts()!.length > 0}
                fallback={
                  <div class="account-empty-profiles-sub">
                    No saved profiles yet.
                  </div>
                }
              >
                <For each={accounts()}>
                  {(acc: MinecraftProfile) => (
                    <div
                      class={`account-profile-item ${acc.active ? "active" : ""}`}
                      onClick={() => !acc.active && handleSwitch(acc.id)}
                    >
                      <div class="account-profile-item-left">
                        <div class="account-profile-item-avatar">
                          <PlayerHead skinUrl={skinFor(acc)} name={acc.name} size={22} />
                        </div>
                        <div class="account-profile-item-text">
                          <div class="account-profile-item-name">{acc.name}</div>
                          <div class="account-profile-item-sub">MICROSOFT OAUTH</div>
                        </div>
                      </div>

                      <div class="account-profile-item-right">
                        <Show
                          when={isAccountExpired(acc)}
                          fallback={
                            <Show when={acc.active}>
                              <span class="bento-badge bento-badge-accent">ACTIVE</span>
                            </Show>
                          }
                        >
                          <span class="bento-badge bento-badge-warn tip-right" data-tip="Session expired. Re-authenticate with Microsoft.">
                            EXPIRED
                          </span>
                        </Show>

                        <Show when={!acc.active}>
                          <button
                            type="button"
                            class="btn btn--ghost btn--xs"
                            onClick={(e) => { e.stopPropagation(); handleSwitch(acc.id); }}
                          >
                            Switch
                          </button>
                        </Show>

                        <button
                          type="button"
                          class="account-card-remove-btn tip-right"
                          data-tip={`Remove ${acc.name}`}
                          onClick={(e) => { e.stopPropagation(); handleRemove(acc.id); }}
                        >
                          <IconTrash />
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <button
              type="button"
              class="btn btn--neutral btn--sm"
              style="width: 100%; margin-top: auto;"
              onClick={handleLogin}
              disabled={loggingIn()}
            >
              <IconPlus />
              <span>{loggingIn() ? "Signing in via browser..." : "Add Microsoft Account"}</span>
            </button>
          </div>
        </div>

        {/* ── CARD 4: CRYPTOGRAPHIC STORAGE CONSOLE (SPAN 2) ── */}
        <div class="card-gamemode-section account-bento-span-2">
          <div class="card-section-header">
            <div class="bento-card-title">
              <IconShieldCheck />
              <span>Security & Credential Storage</span>
            </div>
            <span class="bento-badge">HARDWARE ENCRYPTED</span>
          </div>

          <div class="card-section-body">
            <div class="account-security-grid">
              <div class="account-security-pillar">
                <div class="account-security-pillar-header">
                  <IconShieldCheck />
                  <span>Official OAuth 2.0 PKCE</span>
                </div>
                <div class="account-security-pillar-desc">
                  Authenticates directly via Microsoft and Mojang in your default browser. Passwords never touch launcher memory.
                </div>
              </div>

              <div class="account-security-pillar">
                <div class="account-security-pillar-header">
                  <IconShieldCheck />
                  <span>OS Keystore Sealing</span>
                </div>
                <div class="account-security-pillar-desc">
                  Refresh tokens are encrypted on disk with DPAPI on Windows and Secret Service on Linux. Protected by your user logon.
                </div>
              </div>

              <div class="account-security-pillar">
                <div class="account-security-pillar-header">
                  <IconShieldCheck />
                  <span>Zero Intermediary Telemetry</span>
                </div>
                <div class="account-security-pillar-desc">
                  Operates zero third-party proxy servers or analytics engines. All skin, cape, and profile calls go direct to official endpoints.
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default Account;
