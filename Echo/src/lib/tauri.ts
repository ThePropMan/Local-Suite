// Tauri wrappers for Echo's audio conversion commands.
// Shared helpers live in ../shared/lib/tauri.

import { invoke } from "@tauri-apps/api/core";
import {
  baseNameSync,
  extname,
  formatBytes,
  pickDirectory,
  pickFiles,
  isTauri,
} from "../shared/lib/tauri";

export { baseNameSync as basename, extname, formatBytes, pickDirectory, pickFiles, isTauri };
export type { Theme, RecentFile, DroppedFile } from "../shared/types";

// ---------- Types ----------

export type OutputFormat = "mp3" | "wav" | "flac" | "ogg" | "opus" | "aac" | "m4a";

export type NormalizeModeTag = "none" | "peak";

export interface ConvertOptions {
  format: OutputFormat;
  bitrate: number | null;       // kbps, for lossy formats (mp3/opus/aac/m4a)
  sample_rate: number | null;   // 44100, 48000, 96000, etc. null = preserve
  channels: number | null;      // 1 (mono), 2 (stereo). null = preserve
  trim_silence: boolean;        // trim leading/trailing silence
  trim_threshold_dbfs: number;  // default -40.0
  normalize: NormalizeModeTag;  // none | peak
  normalize_target_dbfs: number;// peak target, default -1.0
  fade_in_ms: number;           // 0 = no fade
  fade_out_ms: number;          // 0 = no fade
}

export interface ConvertResult {
  input_size: number;
  output_size: number;
  ok: boolean;
  message: string | null;
  output_path: string;
  format: string;
  duration_sec: number;
}

export interface BatchResultItem {
  name: string;
  input_size: number;
  output_size: number;
  ok: boolean;
  message: string | null;
  output_path: string;
  format: string;
  duration_sec: number;
}

export interface AudioInfo {
  format: string;
  duration_sec: number;
  bitrate_kbps: number;
  sample_rate: number;
  channels: number;
}

// ---------- Commands ----------

/** Convert a single audio file via FFmpeg. */
export async function convertAudio(
  inputPath: string,
  outputPath: string,
  options: ConvertOptions,
): Promise<ConvertResult> {
  return invoke<ConvertResult>("convert_audio", { inputPath, outputPath, options });
}

/** Convert many audio files into an output directory. */
export async function convertBatch(
  inputPaths: string[],
  outputDir: string,
  options: ConvertOptions,
): Promise<BatchResultItem[]> {
  return invoke<BatchResultItem[]>("convert_batch", { inputPaths, outputDir, options });
}

/** Probe an audio file for format/duration/bitrate/sample rate/channels. */
export async function probeAudio(path: string): Promise<AudioInfo> {
  return invoke<AudioInfo>("probe_audio", { path });
}

/** Return whether FFmpeg is available. */
export async function ffmpegAvailable(): Promise<boolean> {
  return invoke<boolean>("ffmpeg_available");
}

// ---------- FFmpeg setup ----------

export interface FfmpegStatus {
  available: boolean;
  path: string | null;
  source: string | null;
  version: string | null;
}

/** Return FFmpeg's current path, source, and version. */
export async function getFfmpegStatus(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("get_ffmpeg_status");
}

/** Validate and save a user-selected FFmpeg path. */
export async function setFfmpegPath(path: string): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("set_ffmpeg_path", { path });
}

/** Remove the saved path and fall back to PATH lookup. */
export async function clearFfmpegPath(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("clear_ffmpeg_path");
}

/** Download FFmpeg to a target directory. Returns the resolved status. */
export async function downloadFfmpeg(targetDir: string): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("download_ffmpeg", { targetDir });
}

// ---------- Format metadata ----------

export interface FormatDef {
  id: OutputFormat;
  label: string;
  ext: string;
  lossy: boolean;
  desc: string;
}

export const FORMATS: FormatDef[] = [
  { id: "mp3",  label: "MP3",  ext: "mp3",  lossy: true,  desc: "Universal, small" },
  { id: "wav",  label: "WAV",  ext: "wav",  lossy: false, desc: "Lossless, big" },
  { id: "flac", label: "FLAC", ext: "flac", lossy: false, desc: "Lossless, compressed" },
  { id: "ogg",  label: "OGG",  ext: "ogg",  lossy: true,  desc: "Vorbis, open" },
  { id: "opus", label: "Opus", ext: "opus", lossy: true,  desc: "Best at low bitrate" },
  { id: "aac",  label: "AAC",  ext: "aac",  lossy: true,  desc: "Apple, efficient" },
  { id: "m4a",  label: "M4A",  ext: "m4a",  lossy: true,  desc: "AAC in MP4" },
];

export function formatDef(id: OutputFormat): FormatDef {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0];
}

// ---------- Sample rate presets ----------

export const SAMPLE_RATES: { label: string; value: number | null }[] = [
  { label: "Preserve", value: null },
  { label: "44.1 kHz", value: 44100 },
  { label: "48 kHz",   value: 48000 },
  { label: "96 kHz",   value: 96000 },
];

// ---------- Bitrate presets (lossy) ----------

export const BITRATES: { label: string; value: number }[] = [
  { label: "96",  value: 96 },
  { label: "128", value: 128 },
  { label: "160", value: 160 },
  { label: "192", value: 192 },
  { label: "256", value: 256 },
  { label: "320", value: 320 },
];

// ---------- Defaults ----------

export const DEFAULT_OPTIONS: ConvertOptions = {
  format: "mp3",
  bitrate: 192,
  sample_rate: null,
  channels: null,
  trim_silence: false,
  trim_threshold_dbfs: -40,
  normalize: "none",
  normalize_target_dbfs: -1,
  fade_in_ms: 0,
  fade_out_ms: 0,
};

// ---------- Path helpers ----------

/**
 * Build an output path for a converted file.
 * If outputDir is null, the file is written next to the original.
 * The extension is swapped to match the target format. When the format
 * is the same as the input, a `_converted` suffix is added to avoid
 * overwriting the original.
 */
export function buildOutputPath(
  inputPath: string,
  outputDir: string | null,
  targetFormat: OutputFormat,
): string {
  const name = baseNameSync(inputPath);
  const inputExt = extname(inputPath);
  const stem = inputExt ? name.slice(0, -(inputExt.length + 1)) : name;
  const targetExt = formatDef(targetFormat).ext;
  const sameFormat = inputExt === targetExt;
  const outName = sameFormat ? `${stem}_converted.${targetExt}` : `${stem}.${targetExt}`;

  if (!outputDir) {
    const dir = inputPath.slice(0, inputPath.length - name.length);
    return `${dir}${outName}`;
  }
  const sep = outputDir.includes("\\") || !outputDir.includes("/") ? "\\" : "/";
  const base = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
  return `${base}${outName}`;
}

// ---------- Duration formatting ----------

/** Format seconds as m:ss (or h:mm:ss for long files). */
export function formatDuration(sec: number): string {
  if (!sec || sec < 0 || !isFinite(sec)) return "--:--";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// ---------- Constants ----------

export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "opus", "aac", "m4a"];
