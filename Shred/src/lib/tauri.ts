// ============================================================
// Shred — lib/tauri.ts
// App-specific invoke wrappers for the Rust shred commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { baseNameSync, extname, formatBytes, pickDirectory, isTauri } from "../shared/lib/tauri";

export { baseNameSync as basename, extname, formatBytes, pickDirectory, isTauri };
export type { Theme, RecentFile, DroppedFile } from "../shared/types";

/**
 * Pick files and/or folders for shredding.
 * Returns an array of absolute paths (may be empty).
 */
export async function pickForShred(): Promise<string[]> {
  if (!isTauri) return [];
  const result = await openDialog({
    multiple: true,
    directory: false,
  });
  if (!result) return [];
  if (Array.isArray(result)) return result as string[];
  return [result as string];
}

/**
 * Pick a folder for shredding.
 */
export async function pickFolderForShred(): Promise<string | null> {
  if (!isTauri) return null;
  const result = await openDialog({ directory: true });
  return (result as string) ?? null;
}

export type Algorithm = "quick" | "dod" | "gutmann" | "custom";

export interface ShredResult {
  files_shredded: number;
  files_skipped: number;
  bytes_overwritten: number;
  duration_ms: number;
  algorithm: string;
  passes: number;
  verified: boolean;
  errors: string[];
}

export interface FileProgress {
  current_file: number;
  total_files: number;
  file_name: string;
  pass: number;
  total_passes: number;
  file_percent: number;
  overall_percent: number;
}

export interface WipeResult {
  bytes_wiped: number;
  duration_ms: number;
  drive: string;
  errors: string[];
}

export interface DriveInfo {
  letter: string;
  label: string;
  is_ssd: boolean;
  total_bytes: number;
  free_bytes: number;
}

export interface LogEntry {
  timestamp: number;
  action: string;
  algorithm: string;
  passes: number;
  files: number;
  bytes: number;
  duration_ms: number;
  verified: boolean;
  paths: string[];
}

/** Shred (securely delete) a list of files and/or folders. */
export async function shredFiles(
  paths: string[],
  algorithm: Algorithm,
  customPasses?: number,
  customPattern?: number,
  verify?: boolean,
): Promise<ShredResult> {
  return invoke<ShredResult>("shred_files", {
    paths,
    algorithm,
    customPasses: customPasses ?? null,
    customPattern: customPattern ?? null,
    verify: verify ?? true,
  });
}

/** Wipe all free space on a drive with random data. */
export async function wipeFreeSpace(drive: string): Promise<WipeResult> {
  return invoke<WipeResult>("wipe_free_space", { drive });
}

/** Detect whether the drive containing the given path is an SSD. */
export async function detectSsd(path: string): Promise<boolean> {
  return invoke<boolean>("detect_ssd", { path });
}

/** List all fixed drives with SSD detection and space info. */
export async function listDrives(): Promise<DriveInfo[]> {
  return invoke<DriveInfo[]>("list_drives");
}

/** Read the local shred log. */
export async function readShredLog(): Promise<LogEntry[]> {
  return invoke<LogEntry[]>("read_shred_log");
}

/** Clear the shred log. */
export async function clearShredLog(): Promise<void> {
  return invoke<void>("clear_shred_log");
}

/** Algorithm display names. */
export const ALGORITHM_LABELS: Record<Algorithm, string> = {
  quick: "Quick (1-pass random)",
  dod: "DoD 5220.22-M (3-pass)",
  gutmann: "Gutmann (35-pass)",
  custom: "Custom",
};

/** Algorithm descriptions. */
export const ALGORITHM_DESCRIPTIONS: Record<Algorithm, string> = {
  quick: "One pass of random data. Fast, sufficient for most HDDs.",
  dod: "Three passes: zeros, ones, random. US DoD standard.",
  gutmann: "35 passes with specific patterns. Maximum security for older HDDs.",
  custom: "Choose the number of passes and the byte pattern.",
};

/** Number of passes per algorithm (custom uses the user value). */
export function algorithmPasses(algo: Algorithm, customPasses: number): number {
  switch (algo) {
    case "quick": return 1;
    case "dod": return 3;
    case "gutmann": return 35;
    case "custom": return Math.max(1, customPasses);
  }
}
