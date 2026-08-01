// ============================================================
// Shift — shared/shared_commands.rs
// File I/O wrappers shared with the frontend.
// ============================================================

use std::fs;
use std::path::Path;

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
        }
    }
    fs::write(&path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))
}

#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat {path}: {e}"))?;
    Ok(meta.len())
}

#[tauri::command]
pub fn file_modified(path: String) -> Result<Option<i64>, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat {path}: {e}"))?;
    match meta.modified() {
        Ok(t) => {
            let secs = t
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Ok(Some(secs))
        }
        Err(_) => Ok(None),
    }
}
