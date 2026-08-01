// Tauri wrappers and types for Reel's video conversion pipeline.
// The remaining codec backends are tracked in PLAN.md.

import { invoke } from "@tauri-apps/api/core";

// ---------- Output formats ----------

export type OutputFormat =
  | "mp4_h264"    // H.264 video + AAC audio (Media Foundation)
  | "mp4_h265"    // H.265/HEVC video + AAC audio (Media Foundation)
  | "webm_vp9"    // VP9 video + Opus audio (libvpx)
  | "webm_vp8"    // VP8 video + Opus audio (libvpx)
  | "mkv_av1"     // AV1 video + Opus audio (rav1e)
  | "mkv_vp9"     // VP9 video + Opus audio (libvpx, Matroska container)
  | "gif"         // Animated GIF (palette-based, pure Rust)
  | "webp_anim";  // Animated WebP (libwebp)

export interface ConvertOptions {
  format: OutputFormat;
  /** Target width in pixels. 0 = keep original. */
  width: number;
  /** Target height in pixels. 0 = keep original (maintain aspect ratio if width is set). */
  height: number;
  /** Video bitrate in Kbps. 0 = use codec default / CRF. */
  videoBitrate: number;
  /** Frame rate. 0 = keep original. */
  fps: number;
  /** Audio bitrate in Kbps. 0 = codec default. */
  audioBitrate: number;
  /** Trim start time in seconds. 0 = from beginning. */
  trimStart: number;
  /** Trim end time in seconds. 0 = to end. */
  trimEnd: number;
  /** Whether to strip audio. */
  noAudio: boolean;
  /** Whether to strip video (audio-only extract). */
  noVideo: boolean;
}

export interface ConvertResult {
  success: boolean;
  outputPath: string;
  outputSize: number;
  inputSize: number;
  durationMs: number;
  error?: string;
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codecVideo: string;
  codecAudio: string;
  container: string;
}

// ---------- Format metadata ----------

export interface FormatDef {
  id: OutputFormat;
  label: string;
  extension: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  /** Whether this format is currently implemented. */
  available: boolean;
}

export const FORMATS: FormatDef[] = [
  { id: "mp4_h264",  label: "MP4 (H.264)",  extension: "mp4",  container: "MP4",      videoCodec: "H.264",   audioCodec: "AAC",   available: true },
  { id: "mp4_h265",  label: "MP4 (H.265)",  extension: "mp4",  container: "MP4",      videoCodec: "H.265",   audioCodec: "AAC",   available: true },
  { id: "webm_vp9",  label: "WebM (VP9)",   extension: "webm", container: "WebM",     videoCodec: "VP9",     audioCodec: "Opus",  available: false },
  { id: "webm_vp8",  label: "WebM (VP8)",   extension: "webm", container: "WebM",     videoCodec: "VP8",     audioCodec: "Opus",  available: false },
  { id: "mkv_av1",   label: "MKV (AV1)",    extension: "mkv",  container: "Matroska", videoCodec: "AV1",     audioCodec: "Opus",  available: false },
  { id: "mkv_vp9",   label: "MKV (VP9)",    extension: "mkv",  container: "Matroska", videoCodec: "VP9",     audioCodec: "Opus",  available: false },
  { id: "gif",       label: "GIF",          extension: "gif",  container: "GIF",      videoCodec: "GIF",     audioCodec: "none",  available: true },
  { id: "webp_anim", label: "WebP (anim)",  extension: "webp", container: "WebP",     videoCodec: "WebP",    audioCodec: "none",  available: false },
];

export function formatDef(id: OutputFormat): FormatDef | undefined {
  return FORMATS.find((f) => f.id === id);
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  format: "mp4_h264",
  width: 0,
  height: 0,
  videoBitrate: 0,
  fps: 0,
  audioBitrate: 128,
  trimStart: 0,
  trimEnd: 0,
  noAudio: false,
  noVideo: false,
};

export const VIDEO_EXTENSIONS = [
  "mp4", "mkv", "webm", "avi", "mov", "flv", "wmv",
  "m4v", "ts", "ogv", "3gp", "vob", "gif",
];

// ---------- Tauri command wrappers ----------

export async function convertVideo(
  inputPath: string,
  outputPath: string,
  options: ConvertOptions,
): Promise<ConvertResult> {
  return await invoke<ConvertResult>("convert_video", { inputPath, outputPath, options });
}

export async function convertBatch(
  items: { inputPath: string; outputPath: string; options: ConvertOptions }[],
): Promise<ConvertResult[]> {
  return await invoke<ConvertResult[]>("convert_batch", { items });
}

export async function probeVideo(path: string): Promise<ProbeResult> {
  return await invoke<ProbeResult>("probe_video", { path });
}

export async function codecsAvailable(): Promise<Record<OutputFormat, boolean>> {
  return await invoke<Record<OutputFormat, boolean>>("codecs_available");
}

// ---------- Helpers ----------

export function buildOutputPath(
  inputPath: string,
  outputDir: string | null,
  format: OutputFormat,
): string {
  const def = formatDef(format);
  const ext = def?.extension ?? "mp4";
  const base = inputPath.replace(/[\\/][^\\/]+$/, "");
  const name = inputPath.split(/[\\/]/).pop() || "output";
  const nameNoExt = name.replace(/\.[^.]+$/, "");
  const dir = outputDir ?? base;
  return `${dir}/${nameNoExt}.${ext}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
