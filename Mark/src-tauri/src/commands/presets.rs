// ============================================================
// commands/presets.rs — Save/load/delete reusable QR config
// presets. Presets are stored as JSON in the app data dir,
// mirroring how Shift stores its rename presets.
// ============================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use super::generate::QrOptions;

const PRESETS_FILE: &str = "mark_presets.json";

/// A saved preset: a name plus everything needed to reproduce a QR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub qr_type: String,
    pub field_values: serde_json::Value,
    pub options: QrOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PresetFile {
    presets: Vec<Preset>,
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app_dir(app)?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    }
    Ok(dir.join(name))
}

#[tauri::command]
pub fn save_preset(
    name: String,
    qr_type: String,
    field_values: serde_json::Value,
    options: QrOptions,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = data_file(&app, PRESETS_FILE)?;
    let mut file: PresetFile = if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read presets: {e}"))?;
        serde_json::from_str(&json).unwrap_or(PresetFile { presets: vec![] })
    } else {
        PresetFile { presets: vec![] }
    };
    file.presets.retain(|p| p.name != name);
    file.presets.push(Preset {
        name,
        qr_type,
        field_values,
        options,
    });
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write presets: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_presets(app: tauri::AppHandle) -> Result<Vec<Preset>, String> {
    let path = data_file(&app, PRESETS_FILE)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read presets: {e}"))?;
    let file: PresetFile =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse presets: {e}"))?;
    Ok(file.presets)
}

#[tauri::command]
pub fn delete_preset(name: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = data_file(&app, PRESETS_FILE)?;
    if !path.exists() {
        return Ok(());
    }
    let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read presets: {e}"))?;
    let mut file: PresetFile =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse presets: {e}"))?;
    file.presets.retain(|p| p.name != name);
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write presets: {e}"))?;
    Ok(())
}
