// ============================================================
// Shift — lib/tauri.ts
// App-specific Tauri v2 invoke wrappers for rename commands.
// ============================================================

import { invoke } from "@tauri-apps/api/core";

export type CaseMode = "upper" | "lower" | "title" | "sentence";

export type RenameOp =
  | { type: "find_replace"; find: string; replace: string; use_regex?: boolean }
  | { type: "add_prefix"; text: string }
  | { type: "add_suffix"; text: string }
  | { type: "insert_at"; position: number; text: string }
  | { type: "remove_range"; start: number; end?: number }
  | { type: "remove_pattern"; pattern: string; use_regex?: boolean }
  | { type: "change_case"; mode: CaseMode }
  | { type: "number"; start: number; step?: number; padding?: number }
  | { type: "date_stamp"; format: string; from_modified?: boolean }
  | { type: "web_safe"; replace_char?: string }
  | { type: "truncate"; max_length: number }
  | { type: "change_extension"; new_ext: string };

export interface RenameItem {
  old_path: string;
  new_path: string;
  old_name: string;
  new_name: string;
  conflict: boolean;
  status: string;
}

export interface PreviewResult {
  items: RenameItem[];
  conflict_count: number;
  change_count: number;
}

export interface ApplyResult {
  renamed: number;
  errors: string[];
  can_undo: boolean;
}

export interface UndoResult {
  restored: number;
  errors: string[];
}

export interface Preset {
  name: string;
  operations: RenameOp[];
}

export async function collectFilePaths(paths: string[], recursive: boolean): Promise<string[]> {
  return await invoke<string[]>("collect_file_paths", { paths, recursive });
}

export async function previewRename(paths: string[], operations: RenameOp[]): Promise<PreviewResult> {
  return await invoke<PreviewResult>("preview_rename", { paths, operations });
}

export async function applyRename(plan: RenameItem[]): Promise<ApplyResult> {
  return await invoke<ApplyResult>("apply_rename", { plan });
}

export async function undoRename(): Promise<UndoResult> {
  return await invoke<UndoResult>("undo_rename", {});
}

export async function savePreset(name: string, operations: RenameOp[]): Promise<void> {
  await invoke("save_preset", { name, operations });
}

export async function loadPresets(): Promise<Preset[]> {
  return await invoke<Preset[]>("load_presets", {});
}
