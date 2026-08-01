// ============================================================
// Clip — lib/tauri.ts
// App-specific Tauri v2 invoke wrappers for clipboard commands.
// ============================================================

import { invoke } from "@tauri-apps/api/core";

export interface ClipboardEntry {
  id: number;
  content: string;
  preview: string;
  created_at: number;
  pinned: boolean;
  source: string | null;
  char_count: number;
}

export interface ClipSettings {
  history_limit: number;
  monitoring_enabled: boolean;
  hotkey: string;
  paste_as_plain_text: boolean;
}

export interface ClipStats {
  total: number;
  pinned: number;
  limit: number;
}

export async function getRecent(limit?: number): Promise<ClipboardEntry[]> {
  return await invoke<ClipboardEntry[]>("get_recent", { limit: limit ?? null });
}

export async function searchHistory(query: string, limit?: number): Promise<ClipboardEntry[]> {
  return await invoke<ClipboardEntry[]>("search_history", { query, limit: limit ?? null });
}

export async function pinEntry(id: number): Promise<void> {
  await invoke("pin_entry", { id });
}

export async function unpinEntry(id: number): Promise<void> {
  await invoke("unpin_entry", { id });
}

export async function deleteEntry(id: number): Promise<void> {
  await invoke("delete_entry", { id });
}

export async function clearHistory(): Promise<void> {
  await invoke("clear_history", {});
}

export async function pasteEntry(id: number, plain?: boolean): Promise<void> {
  await invoke("paste_entry", { id, plain: plain ?? null });
}

export async function getSettings(): Promise<ClipSettings> {
  return await invoke<ClipSettings>("get_settings", {});
}

export async function setSettings(settings: ClipSettings): Promise<void> {
  await invoke("set_settings", { settings });
}

export async function getStats(): Promise<ClipStats> {
  return await invoke<ClipStats>("get_stats", {});
}

export async function setHotkey(hotkey: string): Promise<string> {
  return await invoke<string>("set_hotkey", { hotkey });
}
