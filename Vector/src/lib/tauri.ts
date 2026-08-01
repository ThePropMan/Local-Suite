// ============================================================
// Vector — lib/tauri.ts
// App-specific invoke wrappers for the Rust vectorize commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import {
  baseNameSync,
  extname,
  formatBytes,
  pickDirectory,
  pickFiles,
  savePath,
  isTauri,
} from "../shared/lib/tauri";

export { baseNameSync as basename, extname, formatBytes, pickDirectory, pickFiles, savePath, isTauri };
export type { Theme, RecentFile, DroppedFile } from "../shared/types";

// ---------- Types ----------

export type PresetId = "logo" | "icon" | "photo" | "lineart" | "pixelart";
export type ColorMode = "color" | "binary";
export type Hierarchical = "stacked" | "cutout";
export type PathSimplifyMode = "spline" | "polygon" | "none";

export interface VectorOptions {
  color_mode: ColorMode;
  hierarchical: Hierarchical;
  filter_speckle: number;
  color_precision: number;
  layer_difference: number;
  mode: PathSimplifyMode;
  corner_threshold: number;
  length_threshold: number;
  max_iterations: number;
  splice_threshold: number;
  path_precision: number | null;
}

export interface VectorResult {
  /** Base64-encoded PNG preview of the vectorized output (rasterized from the SVG). */
  preview_png_base64: string;
  /** The SVG document string. */
  svg: string;
  /** Width of the original image in pixels. */
  width: number;
  /** Height of the original image in pixels. */
  height: number;
  /** SVG byte count (UTF-8). */
  svg_bytes: number;
  ok: boolean;
  message: string | null;
}

export interface BatchVectorResult {
  name: string;
  preview_png_base64: string;
  svg: string;
  svg_bytes: number;
  ok: boolean;
  message: string | null;
}

// ---------- Commands ----------

/** Vectorize a single image file into SVG. */
export async function vectorizeFile(
  path: string,
  options: VectorOptions,
): Promise<VectorResult> {
  return invoke<VectorResult>("vectorize_file", { path, options });
}

/** Vectorize many image files in one call (batch). */
export async function vectorizeBatch(
  paths: string[],
  options: VectorOptions,
): Promise<BatchVectorResult[]> {
  return invoke<BatchVectorResult[]>("vectorize_batch", { paths, options });
}

// ---------- Presets ----------

export interface PresetDef {
  id: PresetId;
  label: string;
  desc: string;
  options: VectorOptions;
}

export const PRESETS: PresetDef[] = [
  {
    id: "logo",
    label: "Logo",
    desc: "Clean, bold shapes with few colors",
    options: {
      color_mode: "color",
      hierarchical: "stacked",
      filter_speckle: 4,
      color_precision: 6,
      layer_difference: 16,
      mode: "spline",
      corner_threshold: 60,
      length_threshold: 4.0,
      max_iterations: 10,
      splice_threshold: 45,
      path_precision: 2,
    },
  },
  {
    id: "icon",
    label: "Icon",
    desc: "Small graphics, sharp edges",
    options: {
      color_mode: "color",
      hierarchical: "stacked",
      filter_speckle: 4,
      color_precision: 8,
      layer_difference: 16,
      mode: "spline",
      corner_threshold: 60,
      length_threshold: 4.0,
      max_iterations: 10,
      splice_threshold: 45,
      path_precision: 2,
    },
  },
  {
    id: "photo",
    label: "Photo",
    desc: "Photographs with smooth gradients",
    options: {
      color_mode: "color",
      hierarchical: "stacked",
      filter_speckle: 10,
      color_precision: 8,
      layer_difference: 48,
      mode: "spline",
      corner_threshold: 180,
      length_threshold: 4.0,
      max_iterations: 10,
      splice_threshold: 45,
      path_precision: 2,
    },
  },
  {
    id: "lineart",
    label: "Line art",
    desc: "Black-and-white drawings, sketches",
    options: {
      color_mode: "binary",
      hierarchical: "stacked",
      filter_speckle: 4,
      color_precision: 6,
      layer_difference: 16,
      mode: "spline",
      corner_threshold: 60,
      length_threshold: 4.0,
      max_iterations: 10,
      splice_threshold: 45,
      path_precision: 2,
    },
  },
  {
    id: "pixelart",
    label: "Pixel art",
    desc: "Crisp pixel grids, no curve smoothing",
    options: {
      color_mode: "color",
      hierarchical: "stacked",
      filter_speckle: 4,
      color_precision: 6,
      layer_difference: 16,
      mode: "none",
      corner_threshold: 180,
      length_threshold: 4.0,
      max_iterations: 10,
      splice_threshold: 45,
      path_precision: 0,
    },
  },
];

export const DEFAULT_PRESET: PresetId = "logo";

export function presetOptions(id: PresetId): VectorOptions {
  return PRESETS.find((p) => p.id === id)?.options ?? PRESETS[0].options;
}

export const DEFAULT_OPTIONS: VectorOptions = presetOptions(DEFAULT_PRESET);

// ---------- Constants ----------

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "webp"];
