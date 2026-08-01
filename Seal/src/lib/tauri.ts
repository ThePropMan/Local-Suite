// ============================================================
// Seal — lib/tauri.ts
// App-specific invoke wrappers for the Rust crypto commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { baseNameSync, extname, formatBytes, pickDirectory, isTauri } from "../shared/lib/tauri";

export { baseNameSync as basename, extname, formatBytes, pickDirectory, isTauri };
export type { Theme, RecentFile, DroppedFile } from "../shared/types";

export type Cipher = "ChaCha20-Poly1305" | "AES-256-GCM";

export interface EncryptResult {
  output_path: string;
  input_size: number;
  output_size: number;
  file_count: number;
  duration_ms: number;
  cipher: string;
}

export interface DecryptResult {
  output_dir: string;
  file_count: number;
  output_size: number;
  duration_ms: number;
  verified: boolean;
  cipher: string;
}

export interface VerifyResult {
  ok: boolean;
  cipher: string;
  file_count: number;
  message: string;
}

/** Encrypt files/folders into a single .sec archive. */
export async function encryptFile(
  inputPaths: string[],
  outputPath: string,
  password: string,
  cipher: Cipher,
): Promise<EncryptResult> {
  return invoke<EncryptResult>("encrypt_file", { inputPaths, outputPath, password, cipher });
}

/** Decrypt a .sec archive and extract files to the output directory. */
export async function decryptFile(
  inputPath: string,
  outputDir: string,
  password: string,
): Promise<DecryptResult> {
  return invoke<DecryptResult>("decrypt_file", { inputPath, outputDir, password });
}

/** Verify a .sec archive's integrity without extracting. */
export async function verifyFile(inputPath: string, password: string): Promise<VerifyResult> {
  return invoke<VerifyResult>("verify_file", { inputPath, password });
}

/**
 * Build a default .sec output path for the given input.
 * If the input is a single file/folder, the output is its name with a .sec
 * extension in the same directory. For multiple inputs, the output is
 * "archive.sec" in the first input's directory.
 */
export function defaultOutputPath(inputPaths: string[], outputDir: string | null): string {
  const first = inputPaths[0];
  const name = baseNameSync(first);
  const ext = extname(first);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const dir = outputDir ?? first.slice(0, first.length - name.length);
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  const base = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const archiveName = inputPaths.length === 1 ? `${stem}.sec` : "archive.sec";
  return `${base}${archiveName}`;
}
