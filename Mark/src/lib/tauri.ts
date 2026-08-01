// ============================================================
// Mark — lib/tauri.ts
// App-specific invoke wrappers for the Rust QR commands.
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

export type EcLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  ec_level: EcLevel;
  size_px: number;
  margin_modules: number;
  fg_color: [number, number, number, number];
  bg_color: [number, number, number, number];
  logo_path: string | null;
  logo_ratio: number | null;
}

export interface QrResult {
  png_base64: string;
  svg: string;
  modules: number;
  size_px: number;
  ok: boolean;
  message: string | null;
}

export interface BatchRow {
  label: string;
  data: string;
}

export interface BatchItem {
  label: string;
  png_base64: string;
  svg: string;
  ok: boolean;
  message: string | null;
}

/** Generate a single QR code from an already-encoded payload string. */
export async function generateQr(data: string, options: QrOptions): Promise<QrResult> {
  return invoke<QrResult>("generate_qr", { data, options });
}

/** Generate many QR codes in one call (CSV batch). */
export async function generateQrBatch(rows: BatchRow[], options: QrOptions): Promise<BatchItem[]> {
  return invoke<BatchItem[]>("generate_qr_batch", { rows, options });
}

/** Generate a single QR code and return the PDF bytes (base64). */
export async function generatePdf(data: string, options: QrOptions): Promise<string> {
  return invoke<string>("generate_pdf", { data, options });
}

/** A saved reusable QR configuration. */
export interface Preset {
  name: string;
  qr_type: string;
  field_values: Record<string, string>;
  options: QrOptions;
}

/** Save a named preset (QR type, field values, and options). */
export async function savePreset(
  name: string,
  qrType: string,
  fieldValues: Record<string, string>,
  options: QrOptions,
): Promise<void> {
  return invoke<void>("save_preset", { name, qrType, fieldValues, options });
}

/** Load all saved presets. */
export async function loadPresets(): Promise<Preset[]> {
  return invoke<Preset[]>("load_presets");
}

/** Delete a named preset. */
export async function deletePreset(name: string): Promise<void> {
  return invoke<void>("delete_preset", { name });
}

/** Default option set used on first load. */
export const DEFAULT_OPTIONS: QrOptions = {
  ec_level: "M",
  size_px: 512,
  margin_modules: 4,
  fg_color: [19, 19, 19, 255],
  bg_color: [255, 255, 255, 255],
  logo_path: null,
  logo_ratio: 0.2,
};
