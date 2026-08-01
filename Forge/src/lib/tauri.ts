// ============================================================
// Forge — lib/tauri.ts
// App-specific invoke wrappers for the Rust image convert commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

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

export type OutputFormat = "jpeg" | "png" | "webp" | "tiff" | "bmp" | "gif";

export type ResizeModeTag = "none" | "percent" | "exact" | "preset";

export type ResizePresetId = "web" | "social" | "thumbnail" | "icon";

export interface ConvertOptions {
  format: OutputFormat;
  quality: number;       // 1-100, used for lossy formats (jpeg, webp)
  resize: ResizeModeTag;
  resize_percent: number | null;   // 1-100 when resize == "percent"
  resize_width: number | null;     // px when resize == "exact"
  resize_height: number | null;    // px when resize == "exact"
  resize_preset: ResizePresetId | null; // when resize == "preset"
  strip_metadata: boolean;
}

export interface ConvertResult {
  input_size: number;
  output_size: number;
  ok: boolean;
  message: string | null;
  output_path: string;
  format: string;
  width: number;
  height: number;
}

export interface BatchResultItem {
  name: string;
  input_size: number;
  output_size: number;
  ok: boolean;
  message: string | null;
  output_path: string;
  format: string;
  width: number;
  height: number;
}

// ---------- Commands ----------

/** Convert a single image file. */
export async function convertImage(
  inputPath: string,
  outputPath: string,
  options: ConvertOptions,
): Promise<ConvertResult> {
  return invoke<ConvertResult>("convert_image", { inputPath, outputPath, options });
}

/** Convert many image files into an output directory. */
export async function convertBatch(
  inputPaths: string[],
  outputDir: string,
  options: ConvertOptions,
): Promise<BatchResultItem[]> {
  return invoke<BatchResultItem[]>("convert_batch", { inputPaths, outputDir, options });
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
  { id: "jpeg", label: "JPEG", ext: "jpg", lossy: true,  desc: "Small, universal" },
  { id: "png",  label: "PNG",  ext: "png", lossy: false, desc: "Lossless, transparency" },
  { id: "webp", label: "WebP", ext: "webp", lossy: false, desc: "Modern, tiny files (lossless)" },
  { id: "tiff", label: "TIFF", ext: "tiff", lossy: false, desc: "Print, archival" },
  { id: "bmp",  label: "BMP",  ext: "bmp",  lossy: false, desc: "Uncompressed" },
  { id: "gif",  label: "GIF",  ext: "gif",  lossy: false, desc: "Animation support" },
];

export function formatDef(id: OutputFormat): FormatDef {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0];
}

// ---------- Resize presets ----------

export interface ResizePresetDef {
  id: ResizePresetId;
  label: string;
  desc: string;
  /** Max dimension in pixels (fits within a square of this size). */
  maxDim: number;
}

export const RESIZE_PRESETS: ResizePresetDef[] = [
  { id: "web",       label: "Web",       desc: "Max 1920px",  maxDim: 1920 },
  { id: "social",    label: "Social",    desc: "Max 1080px",  maxDim: 1080 },
  { id: "thumbnail", label: "Thumbnail", desc: "Max 256px",   maxDim: 256 },
  { id: "icon",      label: "Icon",      desc: "512px square", maxDim: 512 },
];

export function presetDef(id: ResizePresetId): ResizePresetDef {
  return RESIZE_PRESETS.find((p) => p.id === id) ?? RESIZE_PRESETS[0];
}

// ---------- Defaults ----------

export const DEFAULT_OPTIONS: ConvertOptions = {
  format: "webp",
  quality: 80,
  resize: "none",
  resize_percent: 50,
  resize_width: 1920,
  resize_height: 1080,
  resize_preset: "web",
  strip_metadata: true,
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
  const sameFormat = inputExt === targetExt || (inputExt === "jpeg" && targetExt === "jpg");
  const outName = sameFormat ? `${stem}_converted.${targetExt}` : `${stem}.${targetExt}`;

  if (!outputDir) {
    const dir = inputPath.slice(0, inputPath.length - name.length);
    return `${dir}${outName}`;
  }
  const sep = outputDir.includes("\\") || !outputDir.includes("/") ? "\\" : "/";
  const base = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
  return `${base}${outName}`;
}

// ---------- Constants ----------

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"];
