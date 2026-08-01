// ============================================================
// Reel — commands/convert.rs
// Video conversion commands. Dispatches to the appropriate codec
// backend based on the output format:
//
//   H.264/H.265 → Media Foundation (mf.rs)
//   AV1          → rav1e (future)
//   GIF          → gif crate (future)
//   VP9/VP8     → libvpx (future, needs native lib)
//
// Probe (metadata reading) uses Media Foundation source reader.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum OutputFormat {
    Mp4H264,
    Mp4H265,
    WebmVp9,
    WebmVp8,
    MkvAv1,
    MkvVp9,
    Gif,
    WebpAnim,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ConvertOptions {
    pub format: OutputFormat,
    pub width: u32,
    pub height: u32,
    pub video_bitrate: u32,
    pub fps: u32,
    pub audio_bitrate: u32,
    pub trim_start: f64,
    pub trim_end: f64,
    pub no_audio: bool,
    pub no_video: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub success: bool,
    pub output_path: String,
    pub output_size: u64,
    pub input_size: u64,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub has_video: bool,
    pub codec_video: String,
    pub codec_audio: String,
    pub container: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub input_path: String,
    pub output_path: String,
    pub options: ConvertOptions,
}

// ---------- Commands ----------

/// Convert a single video file.
#[tauri::command]
pub fn convert_video(
    input_path: String,
    output_path: String,
    options: ConvertOptions,
) -> Result<ConvertResult, String> {
    let start = Instant::now();
    let input_size = std::fs::metadata(&input_path)
        .map(|m| m.len())
        .unwrap_or(0);

    #[cfg(target_os = "windows")]
    {
        return convert_dispatch(input_path, output_path, options, input_size, start);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (output_path, options);
        Ok(ConvertResult {
            success: false,
            output_path: String::new(),
            output_size: 0,
            input_size,
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some("Reel currently only supports Windows (Media Foundation)".into()),
        })
    }
}

#[cfg(target_os = "windows")]
fn convert_dispatch(
    input_path: String,
    output_path: String,
    options: ConvertOptions,
    input_size: u64,
    start: Instant,
) -> Result<ConvertResult, String> {
    match options.format {
        OutputFormat::Mp4H264 | OutputFormat::Mp4H265 => {
            Ok(crate::mf::convert_with_mf(&input_path, &output_path, &options))
        }
        OutputFormat::Gif => {
            Ok(crate::gif_encoder::convert_to_gif(
                &input_path,
                &output_path,
                &options,
                input_size,
                start,
            ))
        }
        _ => Ok(ConvertResult {
            success: false,
            output_path,
            output_size: 0,
            input_size,
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some("This format is not yet implemented".into()),
        }),
    }
}

/// Convert a batch of video files.
#[tauri::command]
pub fn convert_batch(
    items: Vec<BatchItem>,
) -> Result<Vec<ConvertResult>, String> {
    let results: Vec<ConvertResult> = items
        .into_iter()
        .filter_map(|item| {
            convert_video(item.input_path, item.output_path, item.options).ok()
        })
        .collect();
    Ok(results)
}

/// Probe a video file for metadata.
#[tauri::command]
pub fn probe_video(path: String) -> Result<ProbeResult, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(crate::mf::probe_with_mf(&path))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(ProbeResult {
            duration_sec: 0.0,
            width: 0,
            height: 0,
            fps: 0.0,
            has_audio: false,
            has_video: false,
            codec_video: "unknown".into(),
            codec_audio: "unknown".into(),
            container: "unknown".into(),
        })
    }
}

/// Report which output formats are currently available.
#[tauri::command]
pub fn codecs_available() -> Result<HashMap<String, bool>, String> {
    let mut map = HashMap::new();
    #[cfg(target_os = "windows")]
    {
        map.insert("mp4_h264".into(), true);
        map.insert("mp4_h265".into(), true);
        map.insert("gif".into(), true);
    }
    #[cfg(not(target_os = "windows"))]
    {
        map.insert("mp4_h264".into(), false);
        map.insert("mp4_h265".into(), false);
        map.insert("gif".into(), false);
    }
    map.insert("webm_vp9".into(), false);
    map.insert("webm_vp8".into(), false);
    map.insert("mkv_av1".into(), false);
    map.insert("mkv_vp9".into(), false);
    map.insert("webp_anim".into(), false);
    Ok(map)
}
