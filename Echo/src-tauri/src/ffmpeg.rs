// FFmpeg discovery, download, and path management.
// FFmpeg is provided by the user, either through an automatic download,
// an existing executable, or the setup screen. The selected path is stored
// as JSON in the app data directory.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Where we store the ffmpeg path (in the app data dir).
const CONFIG_FILE: &str = "ffmpeg-config.json";

/// Pinned static Windows build (gyan.dev, release 9.0.2 essentials).
/// Bump both constants together when updating FFmpeg.
const FFMPEG_DOWNLOAD_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip";
/// SHA-256 of the pinned archive, verified before anything is extracted.
const FFMPEG_SHA256: &str = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";

/// Progress payload for `ffmpeg://download-progress` events.
#[derive(Debug, Serialize, Clone)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// In-memory path cache; a valid entry avoids another lookup.
static CACHED_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

// ---------- Types ----------

#[derive(Debug, Serialize, Clone)]
pub struct FfmpegStatus {
    /// Whether FFmpeg is available and working.
    pub available: bool,
    /// The resolved path (if found), for display.
    pub path: Option<String>,
    /// Where it was found: "user", "path", or none.
    pub source: Option<String>,
    /// FFmpeg version string (if available).
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FfmpegConfig {
    path: Option<String>,
}

// ---------- Path resolution ----------

/// Resolve the FFmpeg executable path.
///
/// Order:
///   1. Cached path (in-memory)
///   2. User-configured path (from config file)
///   3. System PATH
pub fn resolve_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    // Try the in-memory path first.
    if let Ok(cache) = CACHED_PATH.lock() {
        if let Some(ref p) = *cache {
            if p.exists() {
                return Some(p.clone());
            }
        }
    }

    // Then try the path saved by the user.
    if let Some(path_str) = load_config_path(app) {
        let p = PathBuf::from(&path_str);
        if p.exists() && validate_ffmpeg(&p) {
            if let Ok(mut cache) = CACHED_PATH.lock() {
                *cache = Some(p.clone());
            }
            return Some(p);
        }
    }

    // Finally, look on the system PATH.
    let exe_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if Command::new(exe_name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        let p = PathBuf::from(exe_name);
        if let Ok(mut cache) = CACHED_PATH.lock() {
            *cache = Some(p.clone());
        }
        return Some(p);
    }

    None
}

/// Validate that a path points to a working ffmpeg executable.
fn validate_ffmpeg(path: &Path) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// Get the path to the config file in the app data directory.
fn config_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CONFIG_FILE))
}

/// Load the user-configured FFmpeg path from the config file.
fn load_config_path(app: &AppHandle) -> Option<String> {
    let path = config_file_path(app)?;
    let contents = std::fs::read_to_string(&path).ok()?;
    let config: FfmpegConfig = serde_json::from_str(&contents).ok()?;
    config.path
}

/// Save the user-configured FFmpeg path to the config file.
fn save_config_path(app: &AppHandle, path: Option<String>) -> Result<(), String> {
    let config_path = config_file_path(app)
        .ok_or_else(|| "Could not determine config directory".to_string())?;

    // Create the config directory if needed.
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }

    let config = FfmpegConfig { path };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&config_path, json)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

// ---------- Tauri commands ----------

/// Get the current FFmpeg status (available, path, source, version).
#[tauri::command]
pub fn get_ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    // Prefer the saved user path.
    if let Some(path_str) = load_config_path(&app) {
        let p = PathBuf::from(&path_str);
        if p.exists() && validate_ffmpeg(&p) {
            let version = get_ffmpeg_version(&p);
            if let Ok(mut cache) = CACHED_PATH.lock() {
                *cache = Some(p.clone());
            }
            return FfmpegStatus {
                available: true,
                path: Some(path_str),
                source: Some("user".into()),
                version,
            };
        }
    }

    // Fall back to the system PATH.
    let exe_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if Command::new(exe_name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        let version = get_ffmpeg_version(Path::new(exe_name));
        let p = PathBuf::from(exe_name);
        if let Ok(mut cache) = CACHED_PATH.lock() {
            *cache = Some(p.clone());
        }
        return FfmpegStatus {
            available: true,
            path: Some(exe_name.to_string()),
            source: Some("path".into()),
            version,
        };
    }

    FfmpegStatus {
        available: false,
        path: None,
        source: None,
        version: None,
    }
}

/// Validate and save a user-selected FFmpeg path.
#[tauri::command]
pub fn set_ffmpeg_path(app: AppHandle, path: String) -> Result<FfmpegStatus, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    if !validate_ffmpeg(&p) {
        return Err("This file exists but doesn't appear to be a working FFmpeg executable.".into());
    }

    save_config_path(&app, Some(path.clone()))?;

    if let Ok(mut cache) = CACHED_PATH.lock() {
        *cache = Some(p.clone());
    }

    let version = get_ffmpeg_version(&p);
    Ok(FfmpegStatus {
        available: true,
        path: Some(path),
        source: Some("user".into()),
        version,
    })
}

/// Clear the stored FFmpeg path (revert to PATH lookup).
#[tauri::command]
pub fn clear_ffmpeg_path(app: AppHandle) -> FfmpegStatus {
    let _ = save_config_path(&app, None);
    if let Ok(mut cache) = CACHED_PATH.lock() {
        *cache = None;
    }
    get_ffmpeg_status(app)
}

/// Download FFmpeg to a user-chosen directory.
/// Returns the path to the extracted ffmpeg.exe.
#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle, target_dir: String) -> Result<FfmpegStatus, String> {
    let target = PathBuf::from(&target_dir);
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create directory: {e}"))?;

    let zip_path = target.join("ffmpeg-download.zip");
    let extract_dir = target.join("ffmpeg");

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20 * 60)) // ~100 MB on slow links
        .user_agent(concat!("echo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut response = client
        .get(FFMPEG_DOWNLOAD_URL)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total = response.content_length();
    let mut received: u64 = 0;
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to write zip: {e}"))?;

    // Stream to disk, hashing as we go so a corrupt or truncated
    // transfer is caught before anything is extracted.
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk) {
                    drop(file);
                    cleanup_artifacts(&zip_path, &extract_dir);
                    return Err(format!("Failed to write zip: {e}"));
                }
                hasher.update(&chunk);
                received += chunk.len() as u64;
                let _ = app.emit(
                    "ffmpeg://download-progress",
                    DownloadProgress { received, total },
                );
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                cleanup_artifacts(&zip_path, &extract_dir);
                return Err(format!("Download failed: {e}"));
            }
        }
    }
    drop(file);

    // Verify the pinned checksum before extracting anything.
    let digest = format!("{:x}", hasher.finalize());
    if digest != FFMPEG_SHA256 {
        cleanup_artifacts(&zip_path, &extract_dir);
        return Err("Downloaded archive failed checksum verification".into());
    }

    // Extract the zip (with zip-slip protection per entry).
    if let Err(e) = extract_zip(&zip_path, &extract_dir) {
        cleanup_artifacts(&zip_path, &extract_dir);
        return Err(format!("Failed to extract zip: {e}"));
    }

    // Clean up the zip
    let _ = std::fs::remove_file(&zip_path);

    // Find ffmpeg.exe in the extracted directory
    let ffmpeg_path = match find_ffmpeg_in_dir(&extract_dir) {
        Some(p) => p,
        None => {
            cleanup_artifacts(&zip_path, &extract_dir);
            return Err("FFmpeg executable not found in the downloaded archive".to_string());
        }
    };

    // Store the path
    let ffmpeg_str = ffmpeg_path.to_string_lossy().to_string();
    save_config_path(&app, Some(ffmpeg_str.clone()))?;

    // Validate
    if !validate_ffmpeg(&ffmpeg_path) {
        cleanup_artifacts(&zip_path, &extract_dir);
        return Err("Downloaded FFmpeg doesn't appear to be working".into());
    }

    if let Ok(mut cache) = CACHED_PATH.lock() {
        *cache = Some(ffmpeg_path.clone());
    }

    let version = get_ffmpeg_version(&ffmpeg_path);
    Ok(FfmpegStatus {
        available: true,
        path: Some(ffmpeg_str),
        source: Some("download".into()),
        version,
    })
}

// ---------- Helpers ----------

/// Delete the partial download and extraction directory after any
/// failure so a broken attempt never leaves artifacts behind.
fn cleanup_artifacts(zip_path: &Path, extract_dir: &Path) {
    let _ = std::fs::remove_file(zip_path);
    if extract_dir.exists() {
        let _ = std::fs::remove_dir_all(extract_dir);
    }
}

fn get_ffmpeg_version(path: &Path) -> Option<String> {
    let output = Command::new(path)
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next().map(|s| s.to_string())
}

/// Recursively search for ffmpeg.exe in a directory.
fn find_ffmpeg_in_dir(dir: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    // Direct child
    let direct = dir.join(exe_name);
    if direct.exists() {
        return Some(direct);
    }

    // bin/ subdirectory
    let bin = dir.join("bin").join(exe_name);
    if bin.exists() {
        return Some(bin);
    }

    // Search recursively (one level deep — the gyan.dev zip has
    // ffmpeg-*/bin/ffmpeg.exe structure)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let candidate = path.join("bin").join(exe_name);
                if candidate.exists() {
                    return Some(candidate);
                }
                let candidate = path.join(exe_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

/// Extract a zip file to a directory (minimal implementation).
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Read zip: {e}"))?;

    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Create extract dir: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Read zip entry {i}: {e}"))?;

        // enclosed_name() returns None for entries whose path would
        // escape dest (absolute paths, "..") — skip them entirely.
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let display = name.display().to_string();

        if entry.is_dir() {
            std::fs::create_dir_all(dest.join(&name))
                .map_err(|e| format!("Create dir {display}: {e}"))?;
            continue;
        }

        let out_path = dest.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Create parent dir: {e}"))?;
        }

        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("Create file {display}: {e}"))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("Extract {display}: {e}"))?;
    }

    Ok(())
}
