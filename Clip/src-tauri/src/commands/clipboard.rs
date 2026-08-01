// ============================================================
// Clip — commands/clipboard.rs
// Clipboard monitoring, SQLite storage, AES-256-GCM encryption
// at rest, fuzzy search, and the Tauri commands consumed by the
// popup UI. Text-only for v1; image support is deferred to v1.1.
// ============================================================

use std::sync::{Arc, Mutex};
use std::time::Duration;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use chrono::Utc;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use rand::RngCore;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------- Tunables ----------

/// Poll interval for clipboard monitoring.
const POLL_MS: u64 = 800;
/// Default max entries kept in history (pruned to this count).
const DEFAULT_LIMIT: i64 = 500;
/// Max bytes of clipboard text we store per entry (larger is truncated).
const MAX_CONTENT_BYTES: usize = 256 * 1024;
/// Preview length returned to the UI.
const PREVIEW_CHARS: usize = 240;
/// Default global hotkey.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Shift+V";

// ---------- Types ----------

#[derive(Debug, Clone, Serialize)]
pub struct ClipboardEntry {
    pub id: i64,
    /// Full decrypted text content.
    pub content: String,
    /// Short preview (first PREVIEW_CHARS chars), single-lined.
    pub preview: String,
    /// Unix-epoch milliseconds.
    pub created_at: i64,
    pub pinned: bool,
    /// Source application name, when known. Null in v1.
    pub source: Option<String>,
    pub char_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipSettings {
    pub history_limit: i64,
    pub monitoring_enabled: bool,
    pub hotkey: String,
    pub paste_as_plain_text: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipStats {
    pub total: i64,
    pub pinned: i64,
    pub limit: i64,
}

/// Shared SQLite handle. WAL mode allows the monitor thread and the
/// command handlers to use separate connections safely; here we keep a
/// single connection behind a Mutex for simplicity.
pub type SharedDb = Arc<Mutex<Connection>>;

/// App state managed by Tauri: the DB connection plus the precomputed
/// AES key (derived once at startup via Argon2id, not per-command).
pub struct AppState {
    pub db: SharedDb,
    pub key: [u8; 32],
}

// ---------- Encryption ----------

/// Derive a 32-byte AES key from a machine identity string and a
/// per-install salt using Argon2id. The identity is the Windows
/// MachineGuid (falls back to env-based identity on non-Windows or
/// read failure). The salt is generated once and stored in the DB meta
/// table, so the key is unique per install even on shared hardware.
fn derive_key(identity: &str, salt: &[u8]) -> [u8; 32] {
    // m=16MiB, t=3, p=4, out=32. Derived once at startup and cached.
    let params = Params::new(16 * 1024, 3, 4, Some(32)).unwrap_or_else(|_| Params::default());
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    // hash_password_into expects a salt of at least 8 bytes.
    let mut padded_salt = vec![0u8; 16];
    let n = salt.len().min(16);
    padded_salt[..n].copy_from_slice(&salt[..n]);
    let _ = argon.hash_password_into(identity.as_bytes(), &padded_salt, &mut key);
    key
}

/// Read a stable machine identity. On Windows this is the registry
/// MachineGuid; elsewhere it falls back to USERNAME + COMPUTERNAME.
#[cfg(windows)]
fn machine_identity() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hkcr = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(sub) = hkcr.open_subkey("SOFTWARE\\Microsoft\\Cryptography") {
        if let Ok(guid) = sub.get_value::<String, _>("MachineGuid") {
            return guid;
        }
    }
    env_identity()
}

#[cfg(not(windows))]
fn machine_identity() -> String {
    env_identity()
}

fn env_identity() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "host".into());
    format!("{user}@{host}")
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    match cipher.encrypt(nonce, plaintext) {
        Ok(ct) => {
            let mut out = Vec::with_capacity(12 + ct.len());
            out.extend_from_slice(&nonce_bytes);
            out.extend_from_slice(&ct);
            out
        }
        Err(_) => Vec::new(),
    }
}

fn decrypt(key: &[u8; 32], blob: &[u8]) -> Option<String> {
    if blob.len() < 13 {
        return None;
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .ok()
        .and_then(|pt| String::from_utf8(pt).ok())
}

// ---------- Database ----------

fn db_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("clip_history.db")
}

pub fn init_db(app: &AppHandle) -> Result<AppState, String> {
    let path = db_path(app);
    let conn = Connection::open_with_flags(&path, OpenFlags::default())
        .map_err(|e| format!("open db: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("wal: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            content     BLOB NOT NULL,
            char_count  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            pinned      INTEGER NOT NULL DEFAULT 0,
            source      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_pinned ON entries(pinned DESC, created_at DESC);
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("schema: {e}"))?;

    // Ensure a salt exists for key derivation.
    let _salt: Vec<u8> = match conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'key_salt'",
            [],
            |r| r.get::<_, String>(0),
        ) {
        Ok(hexstr) => hex::decode(&hexstr).unwrap_or_default(),
        Err(_) => {
            let mut s = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut s);
            let h = hex::encode(s);
            let _ = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('key_salt', ?1)",
                params![h],
            );
            s.to_vec()
        }
    };

    // Fill in any missing settings with their defaults.
    ensure_meta(&conn, "history_limit", &DEFAULT_LIMIT.to_string());
    ensure_meta(&conn, "monitoring_enabled", "1");
    ensure_meta(&conn, "hotkey", DEFAULT_HOTKEY);
    ensure_meta(&conn, "paste_as_plain_text", "1");

    let db = Arc::new(Mutex::new(conn));

    // Derive the AES key once. Argon2id takes about 0.3 seconds, so doing it
    // for every command would make the clipboard feel sluggish.
    let salt_hex = db
        .lock()
        .ok()
        .and_then(|c| meta_get(&c, "key_salt"))
        .unwrap_or_default();
    let salt = hex::decode(&salt_hex).unwrap_or_default();
    let key = derive_key(&machine_identity(), &salt);

    Ok(AppState { db, key })
}

fn ensure_meta(conn: &Connection, key: &str, default: &str) {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, default],
    );
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

/// Read the persisted hotkey (used at startup to register the shortcut).
pub fn read_hotkey(db: &SharedDb) -> String {
    db.lock()
        .ok()
        .and_then(|c| meta_get(&c, "hotkey"))
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

// ---------- Storage ops ----------

fn preview_of(s: &str) -> String {
    let collapsed: String = s.chars().filter(|c| *c != '\r').collect();
    let single: String = collapsed
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("  ");
    let mut p = single;
    if p.chars().count() > PREVIEW_CHARS {
        let kept: String = p.chars().take(PREVIEW_CHARS).collect();
        p = format!("{kept}…");
    }
    p
}

fn store_entry(db: &SharedDb, key: &[u8; 32], text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let mut content = text.to_string();
    if content.len() > MAX_CONTENT_BYTES {
        let cut = content.char_indices().nth(MAX_CONTENT_BYTES).map(|(i, _)| i).unwrap_or(content.len());
        content.truncate(cut);
    }

    let conn = db.lock().unwrap();

    // Dedup against the most recent entry (handles paste-restore + repeats).
    if let Some(last_blob) = conn
        .query_row(
            "SELECT content FROM entries ORDER BY created_at DESC, id DESC LIMIT 1",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .ok()
    {
        if let Some(last) = decrypt(key, &last_blob) {
            if last == content {
                return Ok(());
            }
        }
    }

    let blob = encrypt(key, content.as_bytes());
    let now = Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO entries (content, char_count, created_at, pinned, source) VALUES (?1, ?2, ?3, 0, NULL)",
        params![blob, content.chars().count() as i64, now],
    )
    .map_err(|e| format!("insert: {e}"))?;

    prune(&conn)?;
    Ok(())
}

fn prune(conn: &Connection) -> Result<(), String> {
    let limit: i64 = meta_get(conn, "history_limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_LIMIT);
    // Delete oldest non-pinned entries that fall beyond the limit.
    conn.execute(
        "DELETE FROM entries
         WHERE id IN (
            SELECT id FROM entries
            WHERE pinned = 0
            ORDER BY created_at DESC
            LIMIT -1 OFFSET ?1
         )",
        params![limit],
    )
    .map_err(|e| format!("prune: {e}"))?;
    Ok(())
}

fn row_to_entry(key: &[u8; 32], row: &rusqlite::Row) -> rusqlite::Result<ClipboardEntry> {
    let id: i64 = row.get("id")?;
    let blob: Vec<u8> = row.get("content")?;
    let created_at: i64 = row.get("created_at")?;
    let pinned: i64 = row.get("pinned")?;
    let source: Option<String> = row.get("source")?;
    let char_count: i64 = row.get("char_count")?;
    let content = decrypt(key, &blob).unwrap_or_default();
    let preview = preview_of(&content);
    Ok(ClipboardEntry {
        id,
        preview,
        content,
        created_at,
        pinned: pinned != 0,
        source,
        char_count: char_count.max(0) as usize,
    })
}

// ---------- Sensitive content detection ----------

/// Heuristic: skip entries that look like generated passwords.
/// - length >= 12
/// - has upper, lower, digit, and symbol
/// - is a single token (no internal whitespace) OR very few words
/// - not obviously a URL / email / file path
pub fn is_sensitive(text: &str) -> bool {
    let t = text.trim();
    let len = t.chars().count();
    if len < 12 {
        return false;
    }
    if len > 4096 {
        return false; // long text isn't a password
    }
    let lower = t.starts_with("http://") || t.starts_with("https://") || t.starts_with("ftp://");
    if lower {
        return false;
    }
    if t.contains('@') && t.split_whitespace().count() == 1 && !t.contains(' ') {
        // could be an email; not a password
        return false;
    }
    if t.contains("\\\\") || (t.contains(':') && t.contains('\\')) {
        return false; // windows path
    }

    let has_upper = t.chars().any(|c| c.is_uppercase());
    let has_lower = t.chars().any(|c| c.is_lowercase());
    let has_digit = t.chars().any(|c| c.is_ascii_digit());
    let has_symbol = t.chars().any(|c| !c.is_alphanumeric() && !c.is_whitespace());
    if !(has_upper && has_lower && has_digit && has_symbol) {
        return false;
    }

    // Single token (no whitespace) is the strongest password signal.
    let words = t.split_whitespace().count();
    words <= 1
}

// ---------- Monitor loop ----------

pub fn monitor_loop(db: SharedDb, key: [u8; 32], app: AppHandle) {
    // Create the clipboard handle lazily inside the loop so a failure
    // (e.g. COM init issue) doesn't kill the thread permanently.
    let mut clipboard: Option<arboard::Clipboard> = None;
    loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));

        // Re-check monitoring flag.
        let enabled = db
            .lock()
            .ok()
            .and_then(|c| meta_get(&c, "monitoring_enabled"))
            .and_then(|s| s.parse::<i64>().ok())
            .map(|v| v != 0)
            .unwrap_or(true);
        if !enabled {
            continue;
        }

        if clipboard.is_none() {
            clipboard = arboard::Clipboard::new().ok();
        }
        let Some(cb) = clipboard.as_mut() else { continue };

        let text = match cb.get_text() {
            Ok(t) => t,
            Err(_) => continue, // clipboard empty / locked / non-text
        };
        if text.trim().is_empty() {
            continue;
        }
        if is_sensitive(&text) {
            continue;
        }
        match store_entry(&db, &key, &text) {
            Ok(()) => {
                let _ = app.emit("clip://new-entry", ());
            }
            Err(e) => eprintln!("[clip] store error: {e}"),
        }
    }
}

// ---------- Window helpers ----------

pub fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_window(app, &win);
    }
}

fn show_window(app: &AppHandle, win: &tauri::WebviewWindow) {
    // Position near the cursor, clamped to the primary monitor.
    if let Ok(pos) = app.cursor_position() {
        let size = win.outer_size().unwrap_or(tauri::PhysicalSize {
            width: 480,
            height: 560,
        });
        let mut x = (pos.x - 40.0) as i32;
        let mut y = (pos.y - 40.0) as i32;
        if let Ok(mon) = win.current_monitor() {
            if let Some(m) = mon {
                let ms = m.size();
                let mp = m.position();
                if x + size.width as i32 > mp.x + ms.width as i32 {
                    x = mp.x + ms.width as i32 - size.width as i32 - 8;
                }
                if y + size.height as i32 > mp.y + ms.height as i32 {
                    y = mp.y + ms.height as i32 - size.height as i32 - 8;
                }
                if x < mp.x + 4 {
                    x = mp.x + 4;
                }
                if y < mp.y + 4 {
                    y = mp.y + 4;
                }
            }
        }
        let _ = win.set_position(tauri::PhysicalPosition { x, y });
    }
    let _ = win.show();
    let _ = win.set_focus();
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn get_recent(limit: Option<i64>, state: State<'_, AppState>) -> Result<Vec<ClipboardEntry>, String> {
    let key = &state.key;
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let mut stmt = conn
        .prepare("SELECT id, content, char_count, created_at, pinned, source FROM entries ORDER BY pinned DESC, created_at DESC LIMIT ?1")
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map(params![limit], |r| row_to_entry(&key, r))
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(e) = r {
            out.push(e);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn search_history(query: String, limit: Option<i64>, state: State<'_, AppState>) -> Result<Vec<ClipboardEntry>, String> {
    let key = &state.key;
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let matcher = SkimMatcherV2::default().ignore_case();
    let limit = limit.unwrap_or(200).clamp(1, 1000);

    let mut stmt = conn
        .prepare("SELECT id, content, char_count, created_at, pinned, source FROM entries ORDER BY pinned DESC, created_at DESC")
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| row_to_entry(&key, r))
        .map_err(|e| format!("query: {e}"))?;

    let q = query.trim();
    let mut scored: Vec<(i64, ClipboardEntry)> = Vec::new();
    for r in rows.flatten() {
        if q.is_empty() {
            scored.push((r.created_at, r));
            continue;
        }
        // Score against the full content; pinned entries get a small boost.
        let base = matcher.fuzzy_match(&r.content, q).or_else(|| matcher.fuzzy_match(&r.preview, q));
        if let Some(s) = base {
            let boost = if r.pinned { 500 } else { 0 };
            scored.push((s + boost, r));
        }
    }
    if q.is_empty() {
        // most recent first (pinned already first via SQL order)
        scored.sort_by(|a, b| b.1.created_at.cmp(&a.1.created_at));
    } else {
        scored.sort_by(|a, b| b.0.cmp(&a.0));
    }
    Ok(scored.into_iter().take(limit as usize).map(|(_, e)| e).collect())
}

#[tauri::command]
pub fn pin_entry(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute("UPDATE entries SET pinned = 1 WHERE id = ?1", params![id])
        .map_err(|e| format!("update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn unpin_entry(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute("UPDATE entries SET pinned = 0 WHERE id = ?1", params![id])
        .map_err(|e| format!("update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_entry(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute("DELETE FROM entries WHERE pinned = 0", [])
        .map_err(|e| format!("clear: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn paste_entry(id: i64, plain: Option<bool>, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let key = &state.key;
    let content = {
        let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let blob: Vec<u8> = conn
            .query_row("SELECT content FROM entries WHERE id = ?1", params![id], |r| r.get::<_, Vec<u8>>(0))
            .map_err(|e| format!("fetch: {e}"))?;
        decrypt(key, &blob).ok_or_else(|| "decrypt failed".to_string())?
    };

    let plain = plain.unwrap_or(true);
    let to_set = if plain {
        content.replace('\r', "")
    } else {
        content
    };

    let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    cb.set_text(&to_set)
        .map_err(|e| format!("set clipboard: {e}"))?;

    // Hide the popup so the user can paste into their target app.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<ClipSettings, String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    Ok(ClipSettings {
        history_limit: meta_get(&conn, "history_limit").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_LIMIT),
        monitoring_enabled: meta_get(&conn, "monitoring_enabled").and_then(|s| s.parse::<i64>().ok()).map(|v| v != 0).unwrap_or(true),
        hotkey: meta_get(&conn, "hotkey").unwrap_or_else(|| DEFAULT_HOTKEY.to_string()),
        paste_as_plain_text: meta_get(&conn, "paste_as_plain_text").and_then(|s| s.parse::<i64>().ok()).map(|v| v != 0).unwrap_or(true),
    })
}

#[tauri::command]
pub fn set_settings(settings: ClipSettings, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    meta_set(&conn, "history_limit", &settings.history_limit.to_string());
    meta_set(&conn, "monitoring_enabled", if settings.monitoring_enabled { "1" } else { "0" });
    meta_set(&conn, "hotkey", &settings.hotkey);
    meta_set(&conn, "paste_as_plain_text", if settings.paste_as_plain_text { "1" } else { "0" });
    // Apply the new limit immediately.
    prune(&conn)?;
    Ok(())
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Result<ClipStats, String> {
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap_or(0);
    let pinned: i64 = conn.query_row("SELECT COUNT(*) FROM entries WHERE pinned = 1", [], |r| r.get(0)).unwrap_or(0);
    let limit: i64 = meta_get(&conn, "history_limit").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_LIMIT);
    Ok(ClipStats { total, pinned, limit })
}

/// Re-register the global hotkey. Called from the frontend when the
/// user changes the hotkey in settings. Returns the now-active hotkey.
#[tauri::command]
pub fn set_hotkey(hotkey: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    // Unregister everything, then register the new one.
    let _ = gs.unregister_all();
    gs.register(hotkey.as_str()).map_err(|e| format!("register hotkey: {e}"))?;
    let conn = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    meta_set(&conn, "hotkey", &hotkey);
    Ok(hotkey)
}
