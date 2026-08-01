// ============================================================
// Shift — commands/rename.rs
// Batch rename logic: preview, apply, undo, presets, and the
// stackable rename operations defined in the product plan.
// ============================================================

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::Manager;
use std::fs;
use std::path::{Path, PathBuf};

const UNDO_FILE: &str = "shift_undo_manifest.json";
const PRESETS_FILE: &str = "shift_presets.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RenameOp {
    FindReplace {
        find: String,
        replace: String,
        #[serde(default)]
        use_regex: bool,
    },
    AddPrefix {
        text: String,
    },
    AddSuffix {
        text: String,
    },
    InsertAt {
        position: usize,
        text: String,
    },
    RemoveRange {
        start: usize,
        #[serde(default = "default_usize_max")]
        end: usize,
    },
    RemovePattern {
        pattern: String,
        #[serde(default)]
        use_regex: bool,
    },
    ChangeCase {
        mode: CaseMode,
    },
    Number {
        start: u32,
        #[serde(default = "default_one_u32")]
        step: u32,
        #[serde(default)]
        padding: usize,
    },
    DateStamp {
        format: String,
        #[serde(default)]
        from_modified: bool,
    },
    WebSafe {
        #[serde(default = "default_underscore")]
        replace_char: String,
    },
    Truncate {
        max_length: usize,
    },
    ChangeExtension {
        new_ext: String,
    },
}

fn default_one_u32() -> u32 { 1 }
fn default_usize_max() -> usize { usize::MAX }
fn default_underscore() -> String { "_".to_string() }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseMode {
    Upper,
    Lower,
    Title,
    Sentence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameItem {
    pub old_path: String,
    pub new_path: String,
    pub old_name: String,
    pub new_name: String,
    pub conflict: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
    pub items: Vec<RenameItem>,
    pub conflict_count: usize,
    pub change_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyResult {
    pub renamed: usize,
    pub errors: Vec<String>,
    pub can_undo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoResult {
    pub restored: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub operations: Vec<RenameOp>,
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
pub fn collect_file_paths(paths: Vec<String>, recursive: bool) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if path.is_dir() {
            if recursive {
                collect_dir_recursive(&path, &mut out)?;
            } else {
                for entry in fs::read_dir(&path).map_err(|e| format!("{e}"))? {
                    let entry = entry.map_err(|e| format!("{e}"))?;
                    let p = entry.path();
                    if p.is_file() {
                        out.push(p.to_string_lossy().to_string());
                    }
                }
            }
        } else if path.is_file() {
            out.push(path.to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

fn collect_dir_recursive(dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("{e}"))? {
        let entry = entry.map_err(|e| format!("{e}"))?;
        let p = entry.path();
        if p.is_dir() {
            collect_dir_recursive(&p, out)?;
        } else if p.is_file() {
            out.push(p.to_string_lossy().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn preview_rename(paths: Vec<String>, operations: Vec<RenameOp>) -> Result<PreviewResult, String> {
    let mut items = Vec::new();

    for (idx, path) in paths.iter().enumerate() {
        let new_name = apply_operations(path, &operations, idx, paths.len())?;
        let new_path = replace_file_name(path, &new_name)?;
        let old_name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path)
            .to_string();
        items.push(RenameItem {
            old_path: path.clone(),
            new_path: new_path.clone(),
            old_name,
            new_name,
            conflict: false,
            status: if normalize_path(&new_path) == normalize_path(path) { "no_change".to_string() } else { "ok".to_string() },
        });
    }

    let input_set: HashSet<String> = paths.iter().map(|p| normalize_path(p)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut conflict_count = 0;
    let mut change_count = 0;

    for item in items.iter_mut() {
        let norm_new = normalize_path(&item.new_path);
        let norm_old = normalize_path(&item.old_path);

        // An unchanged file cannot conflict. Leave it out of `seen` so it does
        // not collide with another item that is moving to the same path.
        if norm_new == norm_old {
            continue;
        }

        change_count += 1;

        // Duplicate within batch
        if !seen.insert(norm_new.clone()) {
            item.conflict = true;
            item.status = "conflict".to_string();
            conflict_count += 1;
            continue;
        }

        // Would overwrite another input file (only safe if it's the same file)
        if input_set.contains(&norm_new) {
            item.conflict = true;
            item.status = "conflict".to_string();
            conflict_count += 1;
            continue;
        }

        // Would overwrite an existing file not in the batch
        if Path::new(&item.new_path).exists() {
            item.conflict = true;
            item.status = "conflict".to_string();
            conflict_count += 1;
        }
    }

    Ok(PreviewResult { items, conflict_count, change_count })
}

#[tauri::command]
pub fn apply_rename(plan: Vec<RenameItem>, app: tauri::AppHandle) -> Result<ApplyResult, String> {
    let mut manifest: Vec<RenameItem> = Vec::new();
    let mut renamed = 0;
    let mut errors = Vec::new();

    for item in plan.iter().filter(|i| !i.conflict && i.old_path != i.new_path) {
        if Path::new(&item.new_path).exists() {
            errors.push(format!("{} already exists", item.new_name));
            continue;
        }
        if let Some(parent) = Path::new(&item.new_path).parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
            }
        }
        match fs::rename(&item.old_path, &item.new_path) {
            Ok(_) => {
                renamed += 1;
                manifest.push(item.clone());
            }
            Err(e) => errors.push(format!("Failed to rename {}: {e}", item.old_name)),
        }
    }

    // Persist manifest for a single-level undo
    if !manifest.is_empty() {
        let path = data_file(&app, UNDO_FILE)?;
        let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("Failed to write undo manifest: {e}"))?;
    }

    Ok(ApplyResult { renamed, errors, can_undo: !manifest.is_empty() })
}

#[tauri::command]
pub fn undo_rename(app: tauri::AppHandle) -> Result<UndoResult, String> {
    let path = data_file(&app, UNDO_FILE)?;
    if !path.exists() {
        return Ok(UndoResult { restored: 0, errors: vec!["No undo available".to_string()] });
    }
    let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read undo manifest: {e}"))?;
    let manifest: Vec<RenameItem> =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse undo manifest: {e}"))?;
    let mut restored = 0;
    let mut errors = Vec::new();
    for item in manifest.iter().rev() {
        if Path::new(&item.old_path).exists() {
            errors.push(format!("{} already exists", item.old_name));
            continue;
        }
        if let Err(e) = fs::rename(&item.new_path, &item.old_path) {
            errors.push(format!("Failed to undo {}: {e}", item.new_name));
        } else {
            restored += 1;
        }
    }
    if restored > 0 {
        fs::remove_file(&path).ok();
    }
    Ok(UndoResult { restored, errors })
}

#[tauri::command]
pub fn save_preset(name: String, operations: Vec<RenameOp>, app: tauri::AppHandle) -> Result<(), String> {
    let path = data_file(&app, PRESETS_FILE)?;
    let mut file: PresetFile = if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read presets: {e}"))?;
        serde_json::from_str(&json).unwrap_or(PresetFile { presets: vec![] })
    } else {
        PresetFile { presets: vec![] }
    };
    file.presets.retain(|p| p.name != name);
    file.presets.push(Preset { name, operations });
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

/// Normalize path separators to forward slashes so that comparisons are
/// consistent regardless of the OS separator used by `Path::join` or supplied
/// by the caller. This makes conflict detection robust on Windows where
/// `replace_file_name` reconstructs paths with `\` while tests/callers may
/// pass `/`-separated paths.
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn replace_file_name(path: &str, new_name: &str) -> Result<String, String> {
    let p = Path::new(path);
    let parent = p.parent().and_then(|x| if x.as_os_str().is_empty() { None } else { Some(x) });
    if let Some(parent) = parent {
        Ok(parent.join(new_name).to_string_lossy().to_string())
    } else {
        Ok(new_name.to_string())
    }
}

fn split_name(name: &str) -> (String, String) {
    if let Some(dot) = name.rfind('.') {
        let (base, ext_with_dot) = name.split_at(dot);
        let ext = ext_with_dot.strip_prefix('.').unwrap_or(ext_with_dot);
        (base.to_string(), format!(".{ext}"))
    } else {
        (name.to_string(), String::new())
    }
}

fn apply_operations(path: &str, ops: &[RenameOp], idx: usize, _total: usize) -> Result<String, String> {
    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    let (mut base, ext) = split_name(name);
    let metadata = std::fs::metadata(path);

    for op in ops {
        if !op.enabled() {
            continue;
        }
        match op {
            RenameOp::FindReplace { find, replace, use_regex } => {
                if *use_regex {
                    let re = Regex::new(find.as_str()).map_err(|e| format!("Invalid regex: {e}"))?;
                    base = re.replace_all(&base, replace.as_str()).to_string();
                } else {
                    base = base.replace(find.as_str(), replace.as_str());
                }
            }
            RenameOp::AddPrefix { text } => {
                base = format!("{text}{base}");
            }
            RenameOp::AddSuffix { text } => {
                base = format!("{base}{text}");
            }
            RenameOp::InsertAt { position, text } => {
                let chars: Vec<char> = base.chars().collect();
                let pos = (*position).min(chars.len());
                let mut new = String::with_capacity(base.len() + text.len());
                for (i, c) in chars.iter().enumerate() {
                    if i == pos {
                        new.push_str(text);
                    }
                    new.push(*c);
                }
                if pos == chars.len() {
                    new.push_str(text);
                }
                base = new;
            }
            RenameOp::RemoveRange { start, end } => {
                let chars: Vec<char> = base.chars().collect();
                let s = (*start).min(chars.len());
                let e = (*end).min(chars.len());
                base = chars.iter().enumerate().filter(|(i, _)| *i < s || *i >= e).map(|(_, c)| *c).collect();
            }
            RenameOp::RemovePattern { pattern, use_regex } => {
                if *use_regex {
                    let re = Regex::new(pattern.as_str()).map_err(|e| format!("Invalid regex: {e}"))?;
                    base = re.replace_all(&base, "").to_string();
                } else {
                    base = base.replace(pattern.as_str(), "");
                }
            }
            RenameOp::ChangeCase { mode } => {
                base = match mode {
                    CaseMode::Upper => base.to_uppercase(),
                    CaseMode::Lower => base.to_lowercase(),
                    CaseMode::Title => title_case(&base),
                    CaseMode::Sentence => sentence_case(&base),
                };
            }
            RenameOp::Number { start, step, padding } => {
                let n = *start + (idx as u32) * (*step);
                base = format!("{:0>width$}", n, width = *padding);
            }
            RenameOp::DateStamp { format, from_modified } => {
                let local = chrono::Local;
                let dt = if *from_modified {
                    metadata
                        .as_ref()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                        .map(|d| d.with_timezone(&local))
                } else {
                    Some(chrono::Local::now())
                };
                let formatted = dt
                    .map(|d| d.format(format.as_str()).to_string())
                    .unwrap_or_else(|| "date".to_string());
                base = formatted;
            }
            RenameOp::WebSafe { replace_char } => {
                let ch = replace_char.chars().next().unwrap_or('_');
                let mut out = String::with_capacity(base.len());
                for c in base.chars() {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                        out.push(c);
                    } else {
                        out.push(ch);
                    }
                }
                // collapse consecutive replacement chars
                let re = Regex::new(&format!("{}+", regex::escape(&ch.to_string()))).unwrap();
                base = re.replace_all(&out, ch.to_string()).to_string();
                base = base.trim_matches(ch).to_string();
            }
            RenameOp::Truncate { max_length } => {
                base = base.chars().take(*max_length).collect();
            }
            RenameOp::ChangeExtension { .. } => {
                // not applied to base; handled after the loop
            }
        }
    }

    // Change extension is always last so it overrides any accidental extension edits
    let final_ext = ops.iter().find_map(|op| match op {
        RenameOp::ChangeExtension { new_ext } => Some(new_ext.clone()),
        _ => None,
    });

    let ext = if let Some(new_ext) = final_ext {
        let e = new_ext.trim().trim_start_matches('.');
        if e.is_empty() { String::new() } else { format!(".{e}") }
    } else {
        ext
    };

    Ok(format!("{base}{ext}"))
}

impl RenameOp {
    fn enabled(&self) -> bool { true }
}

fn title_case(s: &str) -> String {
    s.split(|c: char| !c.is_alphanumeric())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn sentence_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op_path(name: &str) -> String {
        format!("x/{name}")
    }

    #[test]
    fn find_replace_plain() {
        let ops = vec![RenameOp::FindReplace { find: "cat".to_string(), replace: "dog".to_string(), use_regex: false }];
        assert_eq!(apply_operations(&op_path("cat_photo.jpg"), &ops, 0, 1).unwrap(), "dog_photo.jpg");
    }

    #[test]
    fn find_replace_regex() {
        let ops = vec![RenameOp::FindReplace { find: r"\d+".to_string(), replace: "NUM".to_string(), use_regex: true }];
        assert_eq!(apply_operations(&op_path("file_123.jpg"), &ops, 0, 1).unwrap(), "file_NUM.jpg");
    }

    #[test]
    fn prefix_and_suffix() {
        let ops = vec![
            RenameOp::AddPrefix { text: "new_".to_string() },
            RenameOp::AddSuffix { text: "_v1".to_string() },
        ];
        assert_eq!(apply_operations(&op_path("photo.jpg"), &ops, 0, 1).unwrap(), "new_photo_v1.jpg");
    }

    #[test]
    fn insert_and_remove() {
        let ops = vec![
            RenameOp::InsertAt { position: 4, text: "X".to_string() },
            RenameOp::RemoveRange { start: 0, end: 3 },
        ];
        assert_eq!(apply_operations(&op_path("abcdef.jpg"), &ops, 0, 1).unwrap(), "dXef.jpg");
    }

    #[test]
    fn remove_pattern() {
        let ops = vec![RenameOp::RemovePattern { pattern: "copy ".to_string(), use_regex: false }];
        assert_eq!(apply_operations(&op_path("copy image.jpg"), &ops, 0, 1).unwrap(), "image.jpg");
    }

    #[test]
    fn change_case() {
        assert_eq!(apply_operations(&op_path("Hello World.jpg"), &vec![RenameOp::ChangeCase { mode: CaseMode::Upper }], 0, 1).unwrap(), "HELLO WORLD.jpg");
        assert_eq!(apply_operations(&op_path("HELLO WORLD.jpg"), &vec![RenameOp::ChangeCase { mode: CaseMode::Lower }], 0, 1).unwrap(), "hello world.jpg");
    }

    #[test]
    fn number_sequence() {
        let ops = vec![RenameOp::Number { start: 5, step: 3, padding: 4 }];
        assert_eq!(apply_operations(&op_path("file.jpg"), &ops, 0, 1).unwrap(), "0005.jpg");
        assert_eq!(apply_operations(&op_path("file.jpg"), &ops, 2, 1).unwrap(), "0011.jpg");
    }

    #[test]
    fn web_safe_and_truncate() {
        let ops = vec![
            RenameOp::WebSafe { replace_char: "-".to_string() },
            RenameOp::Truncate { max_length: 10 },
        ];
        assert_eq!(apply_operations(&op_path("my file name!!.jpg"), &ops, 0, 1).unwrap(), "my-file-na.jpg");
    }

    #[test]
    fn change_extension() {
        let ops = vec![
            RenameOp::ChangeExtension { new_ext: "png".to_string() },
        ];
        assert_eq!(apply_operations(&op_path("photo.jpg"), &ops, 0, 1).unwrap(), "photo.png");
    }

    #[test]
    fn preview_detects_conflicts() {
        let result = preview_rename(
            vec!["x/A.txt".to_string(), "x/a.txt".to_string()],
            vec![RenameOp::ChangeCase { mode: CaseMode::Lower }],
        ).unwrap();
        assert_eq!(result.items.len(), 2);
        assert!(result.items[0].conflict);  // A.txt -> a.txt collides with existing input
        assert!(!result.items[1].conflict); // a.txt stays a.txt
    }
}
