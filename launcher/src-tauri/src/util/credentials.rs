// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Credential encryption/decryption and secure vault management.
//!
//! - On Windows: uses DPAPI (tied to current Windows logon session).
//! - On Linux/macOS: uses authenticated AEAD (AES-256-GCM via `aes-gcm` / RustCrypto) with key derived
//!   from machine-id + user session, combined with strict Unix file permissions (chmod 600).
//!
//! Provides an isolated, atomic token vault (`credentials.enc`) decoupling
//! sensitive authentication secrets from public account metadata (`accounts.json`).

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use windows_dpapi::{encrypt_data, decrypt_data, Scope};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use sha2::{Sha256, Digest};

const ENC_PREFIX: &str = "enc:";
const AEAD_PREFIX: &str = "aead:";

/// Dedicated storage model for an account's authentication secrets.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct AccountCredentials {
    /// Ephemeral Minecraft Services JWT access token (used for game launch and skin management).
    pub access_token: String,
    /// Durable Microsoft OAuth refresh token (used to silently renew the token chain).
    pub refresh_token: Option<String>,
}

fn derive_platform_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"vermeil-credential-vault-v1:");
    let machine_id = std::fs::read_to_string("/etc/machine-id")
        .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
        .unwrap_or_else(|_| "vermeil-local-machine".to_string());
    hasher.update(machine_id.trim().as_bytes());
    hasher.update(b":");
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "default_user".to_string());
    hasher.update(user.as_bytes());
    hasher.finalize().into()
}

#[cfg(any(test, not(windows)))]
fn encrypt_aead(plaintext: &str) -> Result<String, String> {
    let key_bytes = derive_platform_key();
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("AES-GCM key init failed: {}", e))?;

    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);

    let ciphertext = cipher.encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("AES-GCM encrypt failed: {}", e))?;

    let mut combined = Vec::with_capacity(nonce.len() + ciphertext.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ciphertext);

    Ok(format!("{}{}", AEAD_PREFIX, BASE64.encode(&combined)))
}

fn decrypt_aead(stored: &str) -> Result<String, String> {
    if let Some(b64) = stored.strip_prefix(AEAD_PREFIX) {
        let data = BASE64.decode(b64).map_err(|e| format!("Base64 decode: {}", e))?;
        if data.len() < 12 + 16 {
            return Err("AEAD payload too short".to_string());
        }

        let (nonce_bytes, ciphertext) = data.split_at(12);
        let key_bytes = derive_platform_key();
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| format!("AES-GCM key init failed: {}", e))?;
        let nonce_arr: [u8; 12] = nonce_bytes.try_into()
            .map_err(|_| "Invalid AEAD nonce length".to_string())?;
        let nonce = Nonce::from(nonce_arr);

        let decrypted = cipher.decrypt(&nonce, ciphertext)
            .map_err(|_| "AES-GCM decryption failed (key mismatch or corrupted data)".to_string())?;

        return String::from_utf8(decrypted)
            .map_err(|e| format!("UTF-8 decode failed: {}", e));
    }

    Ok(stored.to_string())
}

/// Encrypt a plaintext credential string for storage.
/// On Windows: uses DPAPI, returns `enc:<base64>`.
/// On Linux/macOS: uses authenticated AES-256-GCM, returns `aead:<base64>`.
pub fn encrypt_credential(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() || plaintext == "offline" || plaintext == "0" {
        return Ok(plaintext.to_string());
    }

    #[cfg(windows)]
    {
        let encrypted = encrypt_data(plaintext.as_bytes(), Scope::User, None)
            .map_err(|e| format!("DPAPI encrypt failed: {}", e))?;
        Ok(format!("{}{}", ENC_PREFIX, BASE64.encode(&encrypted)))
    }

    #[cfg(not(windows))]
    {
        encrypt_aead(plaintext)
    }
}

/// Decrypt a credential string.
/// On Windows: if it has the `enc:` prefix, decrypt via DPAPI.
/// On Linux/macOS: if it has the `aead:` prefix, decrypt via AES-256-GCM.
/// Plaintext values (no prefix) are returned as-is (graceful migration).
pub fn decrypt_credential(stored: &str) -> Result<String, String> {
    let stored = stored.trim();
    if stored.is_empty() || stored == "offline" || stored == "0" {
        return Ok(stored.to_string());
    }

    #[cfg(windows)]
    {
        if let Some(b64) = stored.strip_prefix(ENC_PREFIX) {
            let encrypted = BASE64.decode(b64)
                .map_err(|e| format!("Base64 decode failed: {}", e))?;
            let decrypted = decrypt_data(&encrypted, Scope::User, None)
                .map_err(|e| format!("DPAPI decrypt failed: {}", e))?;
            return String::from_utf8(decrypted)
                .map_err(|e| format!("UTF-8 decode failed: {}", e));
        }
    }

    if stored.starts_with(AEAD_PREFIX) {
        return decrypt_aead(stored);
    }

    // Plaintext — legacy storage or unencrypted fallback
    Ok(stored.to_string())
}

/// Returns true if the value is already encrypted (has `enc:` or `aead:` prefix).
pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(ENC_PREFIX) || stored.starts_with(AEAD_PREFIX)
}

/// Set restrictive permissions (chmod 600, owner read/write only) on Unix.
/// Safe no-op on non-Unix platforms (where DPAPI or OS ACLs protect user files).
pub fn restrict_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let perms = std::fs::Permissions::from_mode(0o600);
            if let Err(e) = std::fs::set_permissions(path, perms) {
                tracing::warn!("Failed to set 0600 permissions on {}: {}", path.display(), e);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Atomically write data to a file by writing to a temporary sibling file,
/// syncing buffers to physical disk, and renaming to the target path.
/// Guarantees that the destination is never left in a corrupted or half-written state.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let tmp_file_name = format!(
        "{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("vault"),
        uuid::Uuid::new_v4()
    );
    let tmp_path = match path.parent() {
        Some(p) => p.join(tmp_file_name),
        None => PathBuf::from(tmp_file_name),
    };

    {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Create temp file {}: {}", tmp_path.display(), e))?;
        file.write_all(data)
            .map_err(|e| format!("Write temp file {}: {}", tmp_path.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Sync temp file {}: {}", tmp_path.display(), e))?;
    }
    restrict_file_permissions(&tmp_path);

    // On Windows, brief file-locking from antivirus scanners can cause rename to fail. Retry with backoff.
    let mut retries = 0;
    loop {
        match std::fs::rename(&tmp_path, path) {
            Ok(_) => break,
            Err(_) if retries < 4 => {
                retries += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * retries));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Atomic rename {} -> {} failed: {}", tmp_path.display(), path.display(), e));
            }
        }
    }
    restrict_file_permissions(path);
    Ok(())
}

// ─── CREDENTIAL VAULT (`credentials.enc`) ─────────────────────────────────────

fn credentials_vault_path() -> PathBuf {
    crate::util::paths::data_dir().join("credentials.enc")
}

type VaultMap = HashMap<String, AccountCredentials>;

fn read_vault_from(path: &Path) -> Result<VaultMap, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    restrict_file_permissions(path);
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Read credentials vault {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let decrypted = decrypt_credential(&raw)?;
    let map: VaultMap = serde_json::from_str(&decrypted)
        .map_err(|e| format!("Parse credentials vault: {}", e))?;
    Ok(map)
}

fn write_vault_to(path: &Path, vault: &VaultMap) -> Result<(), String> {
    let json = serde_json::to_string(vault)
        .map_err(|e| format!("Serialize credentials vault: {}", e))?;
    let encrypted = encrypt_credential(&json)?;
    atomic_write(path, encrypted.as_bytes())
}

fn read_vault() -> Result<VaultMap, String> {
    read_vault_from(&credentials_vault_path())
}

fn write_vault(vault: &VaultMap) -> Result<(), String> {
    write_vault_to(&credentials_vault_path(), vault)
}

/// Retrieve authentication secrets for a specific account UUID.
pub fn get_account_credentials(account_id: &str) -> Result<Option<AccountCredentials>, String> {
    let vault = read_vault()?;
    Ok(vault.get(account_id).cloned())
}

/// Save or update authentication secrets for a specific account UUID in the secure vault.
pub fn save_account_credentials(account_id: &str, creds: &AccountCredentials) -> Result<(), String> {
    let mut vault = read_vault()?;
    vault.insert(account_id.to_string(), creds.clone());
    write_vault(&vault)
}

/// Delete credentials for an account from the secure vault.
pub fn delete_account_credentials(account_id: &str) -> Result<(), String> {
    let mut vault = read_vault()?;
    if vault.remove(account_id).is_some() {
        write_vault(&vault)?;
    }
    Ok(())
}

/// Wipe all stored credentials (used during complete logout).
pub fn clear_all_credentials() -> Result<(), String> {
    let path = credentials_vault_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = "secret_minecraft_token_12345";
        let encrypted = encrypt_credential(plaintext).expect("encryption succeeds");
        assert_ne!(plaintext, encrypted);
        assert!(is_encrypted(&encrypted));
        let decrypted = decrypt_credential(&encrypted).expect("decryption succeeds");
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_offline_and_zero_tokens_unmodified() {
        assert_eq!(encrypt_credential("offline").unwrap(), "offline");
        assert_eq!(encrypt_credential("0").unwrap(), "0");
        assert_eq!(encrypt_credential("").unwrap(), "");
        assert_eq!(decrypt_credential("offline").unwrap(), "offline");
        assert_eq!(decrypt_credential("0").unwrap(), "0");
        assert_eq!(decrypt_credential("").unwrap(), "");
    }

    #[test]
    fn test_atomic_write_creates_valid_file() {
        let dir = std::env::temp_dir().join(format!("vermeil_test_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("test_file.txt");
        let content = b"hello atomic world";
        atomic_write(&target, content).expect("atomic write succeeds");
        let read = std::fs::read(&target).expect("read file");
        assert_eq!(read, content);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_vault_serialization_and_encryption_roundtrip() {
        let dir = std::env::temp_dir().join(format!("vermeil_test_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let vault_file = dir.join("test_credentials.enc");

        let mut map = HashMap::new();
        map.insert(
            "account-uuid-1".to_string(),
            AccountCredentials {
                access_token: "mc_access_token_123".to_string(),
                refresh_token: Some("ms_refresh_token_456".to_string()),
            },
        );

        write_vault_to(&vault_file, &map).expect("write vault succeeds");

        // Verify the file on disk is encrypted (starts with enc: or aead:, not plain json)
        let raw_on_disk = std::fs::read_to_string(&vault_file).expect("read vault on disk");
        assert!(is_encrypted(&raw_on_disk));
        assert!(!raw_on_disk.contains("mc_access_token_123"));

        // Read and verify round-trip
        let loaded = read_vault_from(&vault_file).expect("read vault succeeds");
        assert_eq!(loaded, map);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_aes_gcm_aead_roundtrip() {
        let secret = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.secret_refresh_token_xyz_12345";
        let encrypted = encrypt_aead(secret).expect("AEAD encryption failed");
        assert!(encrypted.starts_with(AEAD_PREFIX));
        assert_ne!(encrypted, secret);

        let decrypted = decrypt_aead(&encrypted).expect("AEAD decryption failed");
        assert_eq!(decrypted, secret);
    }
}

