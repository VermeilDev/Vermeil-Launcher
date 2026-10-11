// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::services::favorites::{self, FavoriteItem};

#[tauri::command]
pub async fn get_favorites() -> Result<Vec<FavoriteItem>, String> {
    favorites::load_favorites().await
}

#[tauri::command]
pub async fn toggle_favorite(item: FavoriteItem) -> Result<bool, String> {
    favorites::toggle_favorite(item).await
}

#[tauri::command]
pub async fn remove_favorite(id: String) -> Result<bool, String> {
    favorites::remove_favorite(&id).await
}
