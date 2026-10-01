// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::Serialize;

/// Centralized error type for the Vermeil launcher backend.
/// All commands return `Result<T, AppError>` which Tauri serializes to a string for the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Network error: {0}")]
    Network(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("Launch error: {0}")]
    Launch(String),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Download error: {0}")]
    Download(String),

    #[error("{0}")]
    Other(String),
}

/// Tauri requires errors to implement Serialize to pass them to the frontend.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Allow converting from String errors (for gradual migration).
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

/// Allow converting from reqwest errors.
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

/// Allow converting from serde_json errors.
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Parse(e.to_string())
    }
}
