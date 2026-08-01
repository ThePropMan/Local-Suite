// ============================================================
// @local/ui — rust/shared_commands.rs
// Common Tauri commands every Local app needs: reading/writing
// file bytes and querying file size. Apps include this with:
//
//   #[path = "shared/shared_commands.rs"]
//   mod shared_commands;
//
// then in their `run()`:
//   .invoke_handler(tauri::generate_handler![
//       shared_commands::read_file_bytes,
//       shared_commands::write_file_bytes,
//       shared_commands::file_size,
//       // ...app-specific commands
//   ])
// ============================================================

use std::fs;
use std::path::Path;

/// Read a file's raw bytes. Errors propagate to the JS caller.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Write bytes to a path, creating parent directories as needed.
#[tauri::command]
pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
        }
    }
    fs::write(&path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Return a file's size in bytes.
#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat {path}: {e}"))?;
    Ok(meta.len())
}
