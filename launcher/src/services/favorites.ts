// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { createSignal, createMemo } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import {
  getFavorites,
  toggleFavorite,
  removeFavorite,
  type FavoriteItem,
} from "../ipc/commands";

export type { FavoriteItem };

const [favorites, setFavorites] = createSignal<FavoriteItem[]>([]);
const [favoritesLoaded, setFavoritesLoaded] = createSignal(false);

export const favoriteList = favorites;
export const isFavoritesLoaded = favoritesLoaded;

/**
 * Keyed index: "platform:project_id" -> FavoriteItem for O(1) lookups.
 */
export const favoriteMap = createMemo(() => {
  const map = new Map<string, FavoriteItem>();
  for (const item of favorites()) {
    map.set(item.id, item);
    // Also index by canonical compound key
    map.set(`${item.platform}:${item.project_id}`, item);
  }
  return map;
});

export function isFavorite(platform: string, projectId: string): boolean {
  return favoriteMap().has(`${platform}:${projectId}`);
}

export function getFavorite(platform: string, projectId: string): FavoriteItem | undefined {
  return favoriteMap().get(`${platform}:${projectId}`);
}

export async function loadFavorites(): Promise<FavoriteItem[]> {
  try {
    const list = await getFavorites();
    setFavorites(list || []);
    setFavoritesLoaded(true);
    return list || [];
  } catch (err) {
    console.error("Failed to load favorites:", err);
    return [];
  }
}

const inFlightToggles = new Set<string>();

/**
 * Optimistically toggle a favorite item.
 * Adds or removes immediately from the local signal for 0ms UI feedback,
 * using functional state updates to prevent race conditions during rapid clicks,
 * then persists atomically via Rust IPC in the background.
 */
export async function toggleFavoriteItem(item: FavoriteItem): Promise<boolean> {
  const id = item.id || `${item.platform}:${item.project_id}`;
  if (inFlightToggles.has(id)) {
    return isFavorite(item.platform, item.project_id);
  }
  inFlightToggles.add(id);

  const payload: FavoriteItem = {
    ...item,
    id,
    date_added: item.date_added || new Date().toISOString(),
  };

  let wasPresent = false;
  setFavorites((prev) => {
    const idx = prev.findIndex((i) => i.id === id || (i.platform === item.platform && i.project_id === item.project_id));
    if (idx >= 0) {
      wasPresent = true;
      return prev.filter((_, i) => i !== idx);
    } else {
      wasPresent = false;
      return [payload, ...prev];
    }
  });

  try {
    const res = await toggleFavorite(payload);
    return res;
  } catch (err) {
    console.error("Failed to toggle favorite:", err);
    // Functional rollback: restore or remove strictly this item
    setFavorites((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (wasPresent && idx === -1) {
        return [payload, ...prev];
      } else if (!wasPresent && idx >= 0) {
        return prev.filter((_, i) => i !== idx);
      }
      return prev;
    });
    return wasPresent;
  } finally {
    inFlightToggles.delete(id);
  }
}

export async function removeFavoriteItem(id: string): Promise<boolean> {
  let removedItem: FavoriteItem | undefined;
  setFavorites((prev) => {
    removedItem = prev.find((i) => i.id === id);
    return prev.filter((i) => i.id !== id);
  });
  try {
    return await removeFavorite(id);
  } catch (err) {
    console.error("Failed to remove favorite:", err);
    if (removedItem) {
      setFavorites((prev) => [removedItem!, ...prev]);
    }
    return false;
  }
}

// Auto-load favorites upon module initialization and re-sync on cloud sync
if (typeof window !== "undefined") {
  loadFavorites();
  listen("cloud-settings-synced", () => {
    loadFavorites().catch(() => {});
  }).catch(() => {});
}
