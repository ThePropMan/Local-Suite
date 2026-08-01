// ============================================================
// Vault — commands/vault.rs
// Encrypted password vault: Argon2id KDF + AES-256-GCM.
// Vault file format: JSON envelope with salt, nonce, ciphertext.
// Decrypted entries held in a Mutex<Option<...>> in app state.
// ============================================================

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

// ---------- Types ----------

#[derive(Clone, Serialize, Deserialize, Zeroize)]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub created: i64,
    pub modified: i64,
}

#[derive(Serialize, Deserialize)]
pub struct VaultFile {
    pub version: u32,
    pub salt: String,       // base64
    pub nonce: String,      // base64
    pub ciphertext: String, // base64
}

pub struct VaultState {
    key: Option<[u8; 32]>,
    salt: Option<[u8; 16]>,
    entries: Vec<VaultEntry>,
    vault_path: PathBuf,
}

impl VaultState {
    fn new() -> Self {
        let vault_path = vault_file_path();
        Self {
            key: None,
            salt: None,
            entries: Vec::new(),
            vault_path,
        }
    }
}

// ---------- Helpers ----------

fn vault_file_path() -> PathBuf {
    let mut path = dirs_next::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.local.vault");
    path.push("vault.json");
    path
}

fn derive_key(master_password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(65536, 3, 4, Some(32))
            .map_err(|e| format!("Argon2 params error: {e}"))?,
    );
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

fn encrypt_entries(key: &[u8; 32], salt: &[u8; 16], entries: &[VaultEntry]) -> Result<VaultFile, String> {
    let nonce_bytes = {
        let mut n = [0u8; 12];
        getrandom::getrandom(&mut n).map_err(|e| format!("RNG error: {e}"))?;
        n
    };

    let plaintext = serde_json::to_vec(entries).map_err(|e| format!("Serialize error: {e}"))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    Ok(VaultFile {
        version: 1,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
    })
}

fn decrypt_vault_file(key: &[u8; 32], file: &VaultFile) -> Result<Vec<VaultEntry>, String> {
    let nonce_bytes = B64
        .decode(&file.nonce)
        .map_err(|e| format!("Nonce decode error: {e}"))?;
    let ciphertext = B64
        .decode(&file.ciphertext)
        .map_err(|e| format!("Ciphertext decode error: {e}"))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Invalid master password or corrupted vault".to_string())?;

    serde_json::from_slice(&plaintext).map_err(|e| format!("Deserialize error: {e}"))
}

fn save_vault(state: &VaultState) -> Result<(), String> {
    let key = state
        .key
        .ok_or("Vault is locked")?;
    let salt = state
        .salt
        .ok_or("Vault is locked")?;
    let vault_file = encrypt_entries(&key, &salt, &state.entries)?;
    let json = serde_json::to_vec_pretty(&vault_file).map_err(|e| format!("Serialize error: {e}"))?;
    if let Some(parent) = state.vault_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    fs::write(&state.vault_path, json).map_err(|e| format!("Write error: {e}"))
}

fn read_vault_file(path: &PathBuf) -> Result<VaultFile, String> {
    let data = fs::read(path).map_err(|e| format!("Read vault error: {e}"))?;
    serde_json::from_slice(&data).map_err(|e| format!("Parse vault error: {e}"))
}

// ---------- Tauri state ----------

use tauri::State;

// ---------- Commands ----------

/// Check if a vault file already exists on disk.
#[tauri::command]
pub fn vault_exists() -> bool {
    vault_file_path().exists()
}

/// Create a new empty vault with a master password.
#[tauri::command]
pub fn create_vault(state: State<'_, Mutex<VaultState>>, master_password: String) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if state.vault_path.exists() {
        return Err("Vault already exists".to_string());
    }
    let salt = {
        let mut s = [0u8; 16];
        getrandom::getrandom(&mut s).map_err(|e| format!("RNG error: {e}"))?;
        s
    };
    let key = derive_key(&master_password, &salt)?;
    state.key = Some(key);
    state.salt = Some(salt);
    state.entries = Vec::new();
    save_vault(&state)
}

/// Unlock the vault with a master password. Loads entries into memory.
#[tauri::command]
pub fn unlock_vault(state: State<'_, Mutex<VaultState>>, master_password: String) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if !state.vault_path.exists() {
        return Err("No vault found. Create one first.".to_string());
    }
    let vault_file = read_vault_file(&state.vault_path)?;
    let salt = B64
        .decode(&vault_file.salt)
        .map_err(|e| format!("Salt decode error: {e}"))?;
    if salt.len() != 16 {
        return Err("Corrupted vault: bad salt length".to_string());
    }
    let mut salt_arr = [0u8; 16];
    salt_arr.copy_from_slice(&salt);
    let key = derive_key(&master_password, &salt_arr)?;
    let entries = decrypt_vault_file(&key, &vault_file)?;
    state.key = Some(key);
    state.salt = Some(salt_arr);
    state.entries = entries;
    Ok(())
}

/// Lock the vault: zeroize the key and clear entries from memory.
#[tauri::command]
pub fn lock_vault(state: State<'_, Mutex<VaultState>>) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if let Some(ref mut key) = state.key {
        key.zeroize();
    }
    state.key = None;
    if let Some(ref mut salt) = state.salt {
        salt.zeroize();
    }
    state.salt = None;
    for entry in &mut state.entries {
        entry.zeroize();
    }
    state.entries.clear();
    Ok(())
}

/// Check if the vault is currently unlocked.
#[tauri::command]
pub fn is_unlocked(state: State<'_, Mutex<VaultState>>) -> bool {
    state.lock().unwrap().key.is_some()
}

/// Get all entries (only while unlocked).
#[tauri::command]
pub fn get_entries(state: State<'_, Mutex<VaultState>>) -> Result<Vec<VaultEntry>, String> {
    let state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    Ok(state.entries.clone())
}

/// Add or update an entry, then re-encrypt and save.
#[tauri::command]
pub fn save_entry(state: State<'_, Mutex<VaultState>>, entry: VaultEntry) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    // Update or insert
    if let Some(existing) = state.entries.iter_mut().find(|e| e.id == entry.id) {
        *existing = entry;
    } else {
        state.entries.push(entry);
    }
    save_vault(&state)
}

/// Delete an entry by ID.
#[tauri::command]
pub fn delete_entry(state: State<'_, Mutex<VaultState>>, id: String) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    state.entries.retain(|e| e.id != id);
    save_vault(&state)
}

/// Generate a random password.
#[tauri::command]
pub fn generate_password(
    length: Option<usize>,
    use_uppercase: Option<bool>,
    use_lowercase: Option<bool>,
    use_digits: Option<bool>,
    use_symbols: Option<bool>,
    exclude_ambiguous: Option<bool>,
) -> Result<String, String> {
    let length = length.unwrap_or(20).max(4).min(128);
    let upper = use_uppercase.unwrap_or(true);
    let lower = use_lowercase.unwrap_or(true);
    let digits = use_digits.unwrap_or(true);
    let symbols = use_symbols.unwrap_or(true);
    let exclude_amb = exclude_ambiguous.unwrap_or(false);

    let ambiguous = "Il1O0o`'\"|{}[]()";
    let mut pool = String::new();
    if lower {
        pool.push_str("abcdefghijklmnopqrstuvwxyz");
    }
    if upper {
        pool.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    }
    if digits {
        pool.push_str("0123456789");
    }
    if symbols {
        pool.push_str("!@#$%^&*()-_=+[]{};:,.?/~");
    }
    if exclude_amb {
        let filtered: String = pool.chars().filter(|c| !ambiguous.contains(*c)).collect();
        pool = filtered;
    }
    if pool.is_empty() {
        pool = "abcdefghijklmnopqrstuvwxyz".to_string();
    }

    let pool_bytes: Vec<u8> = pool.bytes().collect();
    let mut idx_bytes = vec![0u8; length];
    getrandom::getrandom(&mut idx_bytes).map_err(|e| format!("RNG error: {e}"))?;

    let password: String = idx_bytes
        .iter()
        .map(|b| pool_bytes[(*b as usize) % pool_bytes.len()] as char)
        .collect();
    Ok(password)
}

/// Estimate password strength in bits of entropy.
#[tauri::command]
pub fn estimate_strength(password: String) -> f64 {
    let mut pool_size: f64 = 0.0;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        pool_size += 26.0;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        pool_size += 26.0;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        pool_size += 10.0;
    }
    if password.chars().any(|c| !c.is_alphanumeric()) {
        pool_size += 32.0;
    }
    if pool_size == 0.0 {
        return 0.0;
    }
    (password.len() as f64) * pool_size.log2()
}

/// Change the master password: re-derive key, re-encrypt with new salt.
#[tauri::command]
pub fn change_master_password(
    state: State<'_, Mutex<VaultState>>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    // Verify old password by re-reading the vault file
    let vault_file = read_vault_file(&state.vault_path)?;
    let old_salt = B64
        .decode(&vault_file.salt)
        .map_err(|e| format!("Salt decode error: {e}"))?;
    let old_key = derive_key(&old_password, &old_salt)?;
    let _ = decrypt_vault_file(&old_key, &vault_file)?; // throws if wrong

    // Derive new key with new salt
    let new_salt = {
        let mut s = [0u8; 16];
        getrandom::getrandom(&mut s).map_err(|e| format!("RNG error: {e}"))?;
        s
    };
    let new_key = derive_key(&new_password, &new_salt)?;
    if let Some(ref mut k) = state.key {
        k.zeroize();
    }
    state.key = Some(new_key);
    save_vault(&state)
}

/// Export all entries to a JSON string (only while unlocked).
#[tauri::command]
pub fn export_vault(state: State<'_, Mutex<VaultState>>, format: String) -> Result<String, String> {
    let state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    match format.as_str() {
        "json" => serde_json::to_string_pretty(&state.entries)
            .map_err(|e| format!("Serialize error: {e}")),
        "csv" => {
            let mut csv = String::from("title,username,password,url,notes,folder,tags\n");
            for e in &state.entries {
                let esc = |s: &str| {
                    if s.contains(',') || s.contains('"') || s.contains('\n') {
                        format!("\"{}\"", s.replace('"', "\"\""))
                    } else {
                        s.to_string()
                    }
                };
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{}\n",
                    esc(&e.title),
                    esc(&e.username),
                    esc(&e.password),
                    esc(e.url.as_deref().unwrap_or("")),
                    esc(e.notes.as_deref().unwrap_or("")),
                    esc(e.folder.as_deref().unwrap_or("")),
                    esc(&e.tags.join(";")),
                ));
            }
            Ok(csv)
        }
        _ => Err("Unknown export format".to_string()),
    }
}

/// Import entries from a JSON string (merges into existing vault).
#[tauri::command]
pub fn import_vault(
    state: State<'_, Mutex<VaultState>>,
    data: String,
    format: String,
) -> Result<usize, String> {
    let mut state = state.lock().unwrap();
    if state.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    let imported: Vec<VaultEntry> = match format.as_str() {
        "json" => {
            // Could be our own format (Vec<VaultEntry>) or a generic array
            let parsed: Vec<serde_json::Value> =
                serde_json::from_str(&data).map_err(|e| format!("Parse error: {e}"))?;
            parsed
                .iter()
                .map(|v| vault_entry_from_json(v))
                .collect::<Result<Vec<_>, _>>()?
        }
        "csv" => {
            let mut entries = Vec::new();
            let mut lines = data.lines();
            let _header = lines.next(); // skip header
            for line in lines {
                if line.trim().is_empty() {
                    continue;
                }
                let fields = parse_csv_line(line);
                if fields.len() >= 3 {
                    let now = chrono_now();
                    entries.push(VaultEntry {
                        id: uuid::Uuid::new_v4().to_string(),
                        title: fields[0].clone(),
                        username: fields[1].clone(),
                        password: fields[2].clone(),
                        url: fields.get(3).filter(|s| !s.is_empty()).cloned(),
                        notes: fields.get(4).filter(|s| !s.is_empty()).cloned(),
                        folder: fields.get(5).filter(|s| !s.is_empty()).cloned(),
                        tags: fields
                            .get(6)
                            .map(|s| s.split(';').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
                            .unwrap_or_default(),
                        created: now,
                        modified: now,
                    });
                }
            }
            entries
        }
        _ => return Err("Unknown import format".to_string()),
    };

    let count = imported.len();
    // Merge: skip entries with duplicate titles+usernames
    for entry in imported {
        let dupe = state.entries.iter().any(|e| {
            e.title == entry.title && e.username == entry.username
        });
        if !dupe {
            state.entries.push(entry);
        }
    }
    save_vault(&state)?;
    Ok(count)
}

fn vault_entry_from_json(v: &serde_json::Value) -> Result<VaultEntry, String> {
    let now = chrono_now();
    Ok(VaultEntry {
        id: v
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        title: v
            .get("title")
            .or_else(|| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string(),
        username: v
            .get("username")
            .or_else(|| v.get("user"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        password: v
            .get("password")
            .or_else(|| v.get("pass"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: v
            .get("url")
            .or_else(|| v.get("website"))
            .or_else(|| v.get("uri"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        notes: v
            .get("notes")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        folder: v
            .get("folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        tags: v
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        created: v
            .get("created")
            .and_then(|v| v.as_i64())
            .unwrap_or(now),
        modified: v
            .get("modified")
            .and_then(|v| v.as_i64())
            .unwrap_or(now),
    })
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else if c == ',' {
            fields.push(current.clone());
            current.clear();
        } else if c == '"' && current.is_empty() {
            in_quotes = true;
        } else {
            current.push(c);
        }
    }
    fields.push(current);
    fields
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- Tauri state setup ----------

pub fn vault_state() -> Mutex<VaultState> {
    Mutex::new(VaultState::new())
}
