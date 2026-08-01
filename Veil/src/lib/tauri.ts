// ============================================================
// Veil — lib/tauri.ts
// App-specific invoke wrappers for the Rust metadata commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { baseNameSync, extname, formatBytes, pickDirectory, isTauri } from "../shared/lib/tauri";

export { baseNameSync as basename, extname, formatBytes, pickDirectory, isTauri };
export type { Theme, RecentFile, DroppedFile } from "../shared/types";

export interface MetadataField {
  key: string;
  value: string;
  category: "exif" | "gps" | "camera" | "iptc" | "xmp";
}

export interface MetadataSummary {
  fields: MetadataField[];
  has_gps: boolean;
  has_exif: boolean;
  has_xmp: boolean;
  has_iptc: boolean;
  file_size: number;
  format: string;
}

export type StripMode = "all" | "gps_only";

export interface StripOptions {
  mode: StripMode;
  preserve_copyright: boolean;
}

export interface StripResult {
  input_size: number;
  output_size: number;
  ok: boolean;
  message: string | null;
  format: string;
  had_exif: boolean;
  had_xmp: boolean;
  preserved_copyright: string | null;
}

/** Read EXIF/metadata from an image file. */
export async function readMetadata(path: string): Promise<MetadataSummary> {
  return invoke<MetadataSummary>("read_metadata", { path });
}

/** Strip metadata by re-encoding the image. */
export async function stripMetadata(
  inputPath: string,
  outputPath: string,
  options: StripOptions,
): Promise<StripResult> {
  return invoke<StripResult>("strip_metadata", {
    inputPath,
    outputPath,
    options,
  });
}

/**
 * Build an output path for a stripped file.
 * If outputDir is null, the file is written next to the original with
 * a `_clean` suffix before the extension. Otherwise it goes into the
 * chosen directory with the same `_clean` suffix.
 */
export function buildOutputPath(inputPath: string, outputDir: string | null): string {
  const name = baseNameSync(inputPath);
  const ext = extname(inputPath);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const cleanName = ext ? `${stem}_clean.${ext}` : `${stem}_clean`;

  if (!outputDir) {
    // Same directory as the input.
    const dir = inputPath.slice(0, inputPath.length - name.length);
    return `${dir}${cleanName}`;
  }
  const sep = outputDir.includes("\\") || !outputDir.includes("/") ? "\\" : "/";
  const base = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
  return `${base}${cleanName}`;
}
