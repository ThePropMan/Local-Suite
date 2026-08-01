// Batch audio conversion through FFmpeg.
// Supports MP3, WAV, FLAC, OGG, Opus, AAC, and M4A, with bitrate,
// sample-rate, channel, silence-trimming, normalization, and fade controls.
// FFmpeg comes from the saved user path or the system PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::ffmpeg;

// ---------- Types sent from / to the frontend ----------

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Mp3,
    Wav,
    Flac,
    Ogg,
    Opus,
    Aac,
    M4a,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NormalizeModeTag {
    None,
    Peak,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConvertOptions {
    pub format: OutputFormat,
    pub bitrate: Option<u32>,        // kbps, for lossy formats
    pub sample_rate: Option<u32>,    // 44100, 48000, 96000, etc.
    pub channels: Option<u8>,        // 1 (mono), 2 (stereo)
    pub trim_silence: bool,
    pub trim_threshold_dbfs: f32,    // default -40.0
    pub normalize: NormalizeModeTag,
    pub normalize_target_dbfs: f32,  // default -1.0
    pub fade_in_ms: u32,
    pub fade_out_ms: u32,
}

#[derive(Debug, Serialize)]
pub struct ConvertResult {
    pub input_size: u64,
    pub output_size: u64,
    pub ok: bool,
    pub message: Option<String>,
    pub output_path: String,
    pub format: String,
    pub duration_sec: f64,
}

#[derive(Debug, Serialize)]
pub struct BatchResultItem {
    pub name: String,
    pub input_size: u64,
    pub output_size: u64,
    pub ok: bool,
    pub message: Option<String>,
    pub output_path: String,
    pub format: String,
    pub duration_sec: f64,
}

#[derive(Debug, Serialize)]
pub struct AudioInfo {
    pub format: String,
    pub duration_sec: f64,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u32,
}

// ---------- FFmpeg discovery ----------

/// Locate the FFmpeg executable via the ffmpeg module.
/// Checks: (1) user-configured path, (2) system PATH.
fn resolve_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    ffmpeg::resolve_ffmpeg(app)
}

// ---------- Public commands ----------

#[tauri::command]
pub fn ffmpeg_available(app_handle: AppHandle) -> bool {
    ffmpeg::resolve_ffmpeg(&app_handle).is_some()
}

#[tauri::command]
pub fn probe_audio(path: String, app_handle: AppHandle) -> Result<AudioInfo, String> {
    let ffmpeg = resolve_ffmpeg(&app_handle)
        .ok_or_else(|| "FFmpeg was not found. Open Settings to download or locate FFmpeg.".to_string())?;

    // `ffmpeg -i input` with no output exits non-zero but prints stream
    // info to stderr. We capture and parse that.
    let output = Command::new(&ffmpeg)
        .arg("-i")
        .arg(&path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(parse_probe(&stderr))
}

#[tauri::command]
pub fn convert_audio(
    input_path: String,
    output_path: String,
    options: ConvertOptions,
    app_handle: AppHandle,
) -> Result<ConvertResult, String> {
    convert_one(&input_path, &output_path, &options, &app_handle)
}

#[tauri::command]
pub fn convert_batch(
    input_paths: Vec<String>,
    output_dir: String,
    options: ConvertOptions,
    app_handle: AppHandle,
) -> Result<Vec<BatchResultItem>, String> {
    let out_dir = PathBuf::from(&output_dir);
    let mut results = Vec::with_capacity(input_paths.len());

    for path in input_paths {
        let out_path = build_unique_output_path(&path, &out_dir, &options);
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        match convert_one(&path, &out_path.to_string_lossy(), &options, &app_handle) {
            Ok(r) => results.push(BatchResultItem {
                name,
                input_size: r.input_size,
                output_size: r.output_size,
                ok: r.ok,
                message: r.message,
                output_path: r.output_path,
                format: r.format,
                duration_sec: r.duration_sec,
            }),
            Err(e) => results.push(BatchResultItem {
                name,
                input_size: 0,
                output_size: 0,
                ok: false,
                message: Some(e),
                output_path: out_path.to_string_lossy().to_string(),
                format: "unknown".to_string(),
                duration_sec: 0.0,
            }),
        }
    }

    Ok(results)
}

// ---------- Core conversion ----------

fn convert_one(
    input_path: &str,
    output_path: &str,
    options: &ConvertOptions,
    app: &AppHandle,
) -> Result<ConvertResult, String> {
    let ffmpeg = resolve_ffmpeg(app)
        .ok_or_else(|| "FFmpeg was not found. Open Settings to download or locate FFmpeg.".to_string())?;

    let input_size = fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);

    // Ensure output directory exists.
    if let Some(parent) = Path::new(output_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create output directory: {e}"))?;
        }
    }

    // Build the audio filter chain.
    let mut filters: Vec<String> = Vec::new();

    // Trim silence in one pass.
    if options.trim_silence {
        let thr = options.trim_threshold_dbfs;
        filters.push(format!(
            "silenceremove=start_periods=1:start_duration=0:start_threshold={thr}dB:stop_periods=-1:stop_duration=0:stop_threshold={thr}dB"
        ));
    }

    // Measure the peak, then apply the needed gain.
    if options.normalize == NormalizeModeTag::Peak {
        let gain_db = detect_peak_gain(&ffmpeg, input_path, options.normalize_target_dbfs)?;
        if gain_db.abs() > 0.001 {
            filters.push(format!("volume={gain_db:+}dB"));
        }
    }

    // Add a fade-in when requested.
    if options.fade_in_ms > 0 {
        let d = options.fade_in_ms as f64 / 1000.0;
        filters.push(format!("afade=t=in:st=0:d={d}"));
    }

    // Reverse the stream to fade out without knowing its duration.
    if options.fade_out_ms > 0 {
        let d = options.fade_out_ms as f64 / 1000.0;
        filters.push(format!("areverse,afade=t=in:st=0:d={d},areverse"));
    }

    // Assemble the ffmpeg command.
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-i").arg(input_path)
        .arg("-vn"); // audio only, drop any video stream

    if !filters.is_empty() {
        cmd.arg("-af").arg(filters.join(","));
    }

    // Codec + bitrate per format.
    let bitrate = options.bitrate.unwrap_or(192);
    match options.format {
        OutputFormat::Mp3 => {
            cmd.arg("-c:a").arg("libmp3lame");
            cmd.arg("-b:a").arg(format!("{bitrate}k"));
        }
        OutputFormat::Wav => {
            cmd.arg("-c:a").arg("pcm_s16le");
        }
        OutputFormat::Flac => {
            cmd.arg("-c:a").arg("flac");
        }
        OutputFormat::Ogg => {
            cmd.arg("-c:a").arg("libvorbis");
            cmd.arg("-b:a").arg(format!("{bitrate}k"));
        }
        OutputFormat::Opus => {
            cmd.arg("-c:a").arg("libopus");
            cmd.arg("-b:a").arg(format!("{bitrate}k"));
        }
        OutputFormat::Aac => {
            cmd.arg("-c:a").arg("aac");
            cmd.arg("-b:a").arg(format!("{bitrate}k"));
        }
        OutputFormat::M4a => {
            cmd.arg("-c:a").arg("aac");
            cmd.arg("-b:a").arg(format!("{bitrate}k"));
        }
    }

    if let Some(rate) = options.sample_rate {
        cmd.arg("-ar").arg(rate.to_string());
    }
    if let Some(ch) = options.channels {
        cmd.arg("-ac").arg(ch.to_string());
    }

    // M4A needs an mp4 container; the .m4a extension signals that to ffmpeg.
    cmd.arg(output_path);

    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Trim ffmpeg's verbose stderr to the last useful line.
        let msg = last_useful_line(&stderr).unwrap_or_else(|| stderr.to_string());
        return Ok(ConvertResult {
            input_size,
            output_size: 0,
            ok: false,
            message: Some(format!("FFmpeg error: {msg}")),
            output_path: output_path.to_string(),
            format: format_label(options.format).to_string(),
            duration_sec: 0.0,
        });
    }

    let output_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);

    // Probe the output duration (best-effort).
    let duration_sec = probe_duration(&ffmpeg, output_path).unwrap_or(0.0);

    Ok(ConvertResult {
        input_size,
        output_size,
        ok: true,
        message: None,
        output_path: output_path.to_string(),
        format: format_label(options.format).to_string(),
        duration_sec,
    })
}

// ---------- Peak detection (two-pass) ----------

/// Run `ffmpeg -i input -af volumedetect -f null -` and parse `max_volume`.
/// Returns the gain in dB needed to reach `target_dbfs` (target - max).
fn detect_peak_gain(ffmpeg: &Path, input_path: &str, target_dbfs: f32) -> Result<f32, String> {
    let output = Command::new(ffmpeg)
        .arg("-i").arg(input_path)
        .arg("-af").arg("volumedetect")
        .arg("-vn")
        .arg("-f").arg("null")
        .arg("-")
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run FFmpeg (volumedetect): {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Look for: "max_volume: -6.3 dB"
    let max_volume = stderr
        .lines()
        .find_map(|l| {
            let idx = l.find("max_volume:")?;
            let rest = &l[idx + "max_volume:".len()..];
            let rest = rest.trim();
            // rest like "-6.3 dB"
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.').collect();
            num.parse::<f32>().ok()
        });

    match max_volume {
        Some(max) => Ok(target_dbfs - max),
        None => Ok(0.0), // couldn't detect; leave unchanged
    }
}

// ---------- Probing / parsing ----------

/// Run `ffmpeg -i path` (no output) and parse duration from stderr.
fn probe_duration(ffmpeg: &Path, path: &str) -> Option<f64> {
    let output = Command::new(ffmpeg)
        .arg("-i").arg(path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Some(parse_probe(&stderr).duration_sec)
}

/// Parse FFmpeg stderr (from `ffmpeg -i`) for audio info.
fn parse_probe(stderr: &str) -> AudioInfo {
    let duration_sec = parse_duration(stderr).unwrap_or(0.0);
    let (sample_rate, channels, bitrate_kbps, format) = parse_audio_stream(stderr);
    AudioInfo {
        format,
        duration_sec,
        bitrate_kbps,
        sample_rate,
        channels,
    }
}

/// Parse "Duration: 00:03:45.12" into seconds.
fn parse_duration(stderr: &str) -> Option<f64> {
    let line = stderr.lines().find(|l| l.contains("Duration:"))?;
    let idx = line.find("Duration:")?;
    let rest = line[idx + "Duration:".len()..].trim_start();
    // rest like "00:03:45.12, start: ..."
    let time: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == ':').collect();
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Parse the "Audio: ..." stream line for sample rate, channels, bitrate, codec.
fn parse_audio_stream(stderr: &str) -> (u32, u32, u32, String) {
    let line = stderr.lines().find(|l| l.contains("Audio:"));
    let mut sample_rate = 0u32;
    let mut channels = 0u32;
    let mut bitrate_kbps = 0u32;
    let mut format = "unknown".to_string();

    if let Some(line) = line {
        // "Audio: mp3 (U.S. ...), 44100 Hz, stereo, fltp, 128 kb/s"
        let idx = line.find("Audio:").unwrap();
        let rest = &line[idx + "Audio:".len()..];
        // Codec name up to the first comma or space.
        let codec: String = rest
            .trim_start()
            .chars()
            .take_while(|c| *c != ',' && *c != ' ')
            .collect();
        if !codec.is_empty() {
            format = codec;
        }

        // Sample rate: "44100 Hz"
        if let Some(hz) = find_number_before(rest, "Hz") {
            sample_rate = hz as u32;
        }
        // Channels: "stereo" -> 2, "mono" -> 1, "2 channels" -> 2
        if rest.contains("stereo") {
            channels = 2;
        } else if rest.contains("mono") {
            channels = 1;
        } else if let Some(ch) = find_number_before(rest, "channels") {
            channels = ch as u32;
        }
        // Bitrate: "128 kb/s"
        if let Some(kb) = find_number_before(rest, "kb/s") {
            bitrate_kbps = kb as u32;
        }
    }

    (sample_rate, channels, bitrate_kbps, format)
}

/// Find the integer/float immediately preceding `suffix` in `text`.
fn find_number_before(text: &str, suffix: &str) -> Option<f64> {
    let idx = text.find(suffix)?;
    let before = &text[..idx];
    // Walk backwards collecting digits, dot, and minus.
    let mut num: Vec<char> = Vec::new();
    for c in before.chars().rev() {
        if c.is_ascii_digit() || c == '.' || c == '-' {
            num.push(c);
        } else if !num.is_empty() {
            break;
        }
    }
    if num.is_empty() {
        return None;
    }
    num.reverse();
    let s: String = num.iter().collect();
    s.parse::<f64>().ok()
}

fn last_useful_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .rev()
        .find(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with("frame=") && !t.starts_with("Stream mapping:")
        })
        .map(|l| l.trim().to_string())
}

// ---------- Path helpers ----------

fn format_label(f: OutputFormat) -> &'static str {
    match f {
        OutputFormat::Mp3 => "mp3",
        OutputFormat::Wav => "wav",
        OutputFormat::Flac => "flac",
        OutputFormat::Ogg => "ogg",
        OutputFormat::Opus => "opus",
        OutputFormat::Aac => "aac",
        OutputFormat::M4a => "m4a",
    }
}

fn ext_for(f: OutputFormat) -> &'static str {
    match f {
        OutputFormat::Mp3 => "mp3",
        OutputFormat::Wav => "wav",
        OutputFormat::Flac => "flac",
        OutputFormat::Ogg => "ogg",
        OutputFormat::Opus => "opus",
        OutputFormat::Aac => "aac",
        OutputFormat::M4a => "m4a",
    }
}

/// Build a unique output path in `out_dir`, avoiding overwriting existing files.
fn build_unique_output_path(input_path: &str, out_dir: &Path, options: &ConvertOptions) -> PathBuf {
    let stem = Path::new(input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output")
        .to_string();
    let ext = ext_for(options.format);
    let mut candidate = out_dir.join(format!("{stem}.{ext}"));
    if candidate.exists() {
        let mut i = 1;
        loop {
            candidate = out_dir.join(format!("{stem}_{i}.{ext}"));
            if !candidate.exists() {
                break;
            }
            i += 1;
        }
    }
    candidate
}
