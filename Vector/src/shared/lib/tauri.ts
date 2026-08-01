// ============================================================
// @local/ui — lib/tauri.ts
// Generalized Tauri v2 wrappers shared across all Local apps.
// App-specific invoke wrappers stay in each app's own lib/tauri.ts.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basename } from "@tauri-apps/api/path";
import type { Theme } from "../types";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------- File / directory pickers ----------

export interface FileFilter {
  name: string;
  extensions: string[];
}

export async function pickFiles(
  extensions: string[] | null,
  multiple: boolean,
  filters?: FileFilter[],
): Promise<string[]> {
  if (!isTauri) return [];
  const result = await openDialog({
    multiple,
    filters: filters ?? (extensions ? [{ name: "Files", extensions }] : undefined),
  });
  if (!result) return [];
  if (Array.isArray(result)) return result as string[];
  return [result as string];
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  const result = await openDialog({ directory: true });
  return (result as string) ?? null;
}

export async function savePath(
  filters: FileFilter[],
  defaultPath?: string,
): Promise<string | null> {
  if (!isTauri) return null;
  return await saveDialog({ filters, defaultPath });
}

// ---------- File I/O ----------

export async function readFileBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  return await invoke<Uint8Array<ArrayBuffer>>("read_file_bytes", { path });
}

export async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_file_bytes", { path, bytes: Array.from(bytes) });
}

export async function fileSize(path: string): Promise<number> {
  return await invoke<number>("file_size", { path });
}

export async function fileBaseName(path: string): Promise<string> {
  if (isTauri) {
    try {
      return await basename(path);
    } catch {
      return path.split(/[\\/]/).pop() || path;
    }
  }
  return path.split(/[\\/]/).pop() || path;
}

/** Synchronous basename (no Tauri call). Used when you already have a path string. */
export function baseNameSync(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Lowercase extension without the dot, or "" if none. */
export function extname(path: string): string {
  const base = baseNameSync(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Format a byte count as a compact human string (e.g. "1.4 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

// ---------- Store (persistent settings) ----------

const STORE_CACHE = new Map<string, Store>();

async function getStore(name = ".settings.json"): Promise<Store> {
  if (!isTauri) {
    // Browser fallback so the UI can be developed outside Tauri.
    return {
      get: async <T>(key: string) => {
        const raw = localStorage.getItem(`local:${name}:${key}`);
        return (raw ? (JSON.parse(raw) as T) : undefined) as T | undefined;
      },
      set: async (key: string, value: unknown) => {
        localStorage.setItem(`local:${name}:${key}`, JSON.stringify(value));
      },
      delete: async (key: string) => {
        localStorage.removeItem(`local:${name}:${key}`);
      },
    } as unknown as Store;
  }
  let store = STORE_CACHE.get(name);
  if (!store) {
    store = await Store.load(name);
    STORE_CACHE.set(name, store);
  }
  return store;
}

export async function getStoreValue<T>(key: string, storeName?: string): Promise<T | undefined> {
  const store = await getStore(storeName);
  return (await store.get<T>(key)) ?? undefined;
}

export async function setStoreValue(key: string, value: unknown, storeName?: string): Promise<void> {
  const store = await getStore(storeName);
  await store.set(key, value);
  await store.save();
}

export async function deleteStoreValue(key: string, storeName?: string): Promise<void> {
  const store = await getStore(storeName);
  await store.delete(key);
  await store.save();
}

// ---------- Window controls ----------

export async function minimizeWindow(): Promise<void> {
  if (!isTauri) return;
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri) return;
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri) return;
  await getCurrentWindow().close();
}

// ---------- Confirm dialog (Tauri message or browser fallback) ----------

export async function confirm(message: string, title = "Confirm"): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return await ask(message, { title, kind: "warning" });
}

// ---------- Drag-drop subscription ----------

export interface DragDropEvent {
  type: "enter" | "over" | "leave" | "drop";
  paths: string[];
  position: { x: number; y: number };
}

export function onDragDropEvent(
  handler: (event: DragDropEvent) => void,
): Promise<() => void> {
  if (!isTauri) return Promise.resolve(() => {});
  return (async () => {
    const webview = getCurrentWebview();
    return await webview.onDragDropEvent((event) => {
      const payload = event.payload as {
        type: string;
        paths?: string[];
        position?: { x: number; y: number };
      };
      handler({
        type: payload.type as DragDropEvent["type"],
        paths: payload.paths ?? [],
        position: payload.position ?? { x: 0, y: 0 },
      });
    });
  })();
}

// ---------- Theme helpers ----------

export function applyTheme(theme: Theme): void {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export async function loadTheme(): Promise<Theme> {
  const t = await getStoreValue<Theme>("theme");
  if (t) applyTheme(t);
  return t ?? "system";
}

export async function saveTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  await setStoreValue("theme", theme);
}

// Re-export shared types for convenience.
export type { Theme } from "../types";
