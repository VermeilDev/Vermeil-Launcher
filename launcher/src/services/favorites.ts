// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

import { createSignal, createMemo } from "solid-js";
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

/**
 * Optimistically toggle a favorite item.
 * Adds or removes immediately from the local signal for 0ms UI feedback,
 * then persists atomically via Rust IPC in the background.
 */
export async function toggleFavoriteItem(item: FavoriteItem): Promise<boolean> {
  const current = favorites();
  const id = item.id || `${item.platform}:${item.project_id}`;
  const existingIdx = current.findIndex((i) => i.id === id || (i.platform === item.platform && i.project_id === item.project_id));

  const payload: FavoriteItem = {
    ...item,
    id,
    date_added: item.date_added || new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    // Optimistic remove
    setFavorites(current.filter((_, idx) => idx !== existingIdx));
    try {
      await toggleFavorite(payload);
      return false;
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      // Rollback
      setFavorites(current);
      return true;
    }
  } else {
    // Optimistic add (to top)
    setFavorites([payload, ...current]);
    try {
      await toggleFavorite(payload);
      return true;
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      // Rollback
      setFavorites(current);
      return false;
    }
  }
}

export async function removeFavoriteItem(id: string): Promise<boolean> {
  const current = favorites();
  setFavorites(current.filter((i) => i.id !== id));
  try {
    return await removeFavorite(id);
  } catch (err) {
    console.error("Failed to remove favorite:", err);
    setFavorites(current);
    return false;
  }
}

// Auto-load favorites upon module initialization
if (typeof window !== "undefined") {
  loadFavorites();
}
