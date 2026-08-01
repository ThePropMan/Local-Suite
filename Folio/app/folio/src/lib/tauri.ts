import { invoke } from "@tauri-apps/api/core";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, stat } from "@tauri-apps/plugin-fs";
import { Store } from "@tauri-apps/plugin-store";

export type Theme = "system" | "light" | "dark";

export interface RecentFile {
  name: string;
  path: string;
  tool?: string;
  timestamp: number;
  sizeBefore?: number;
  sizeAfter?: number;
}

export interface RedactRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompressResult {
  output_bytes: number;
  compressor: "ghostscript" | "lopdf";
  message?: string;
}

/** True when running inside the Tauri webview (IPC bridge available). */
export const isTauri =
  typeof window !== "undefined" &&
  // @ts-expect-error - internal Tauri globals
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

function dirname(path: string): string {
  const idx = path.lastIndexOf("\\");
  if (idx !== -1) return path.substring(0, idx);
  const slash = path.lastIndexOf("/");
  if (slash !== -1) return path.substring(0, slash);
  return path;
}

export async function pickPdfFiles(multiple = false): Promise<string[]> {
  if (!isTauri) {
    console.log("[pickPdfFiles] not in Tauri");
    return [];
  }
  try {
    const files = await open({
      multiple,
      directory: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!files) return [];
    const paths = Array.isArray(files) ? files : [files];
    console.log("[pickPdfFiles] selected:", paths);
    return paths;
  } catch (e: any) {
    console.error("[pickPdfFiles] dialog error:", e);
    return [];
  }
}

export async function pickDirectoryPath(): Promise<string | null> {
  if (!isTauri) return null;
  const dir = await open({ directory: true, multiple: false });
  if (Array.isArray(dir)) return dir[0] || null;
  return dir || null;
}

export async function savePdfPath(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null;
  return save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath,
  });
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isTauri) throw new Error("File system is only available inside the Tauri app.");
  console.log("[readFileBytes] reading:", path);
  return fsReadFile(path);
}

export async function writeFileBytes(path: string, data: Uint8Array): Promise<void> {
  if (!isTauri) throw new Error("File system is only available inside the Tauri app.");
  const dir = dirname(path);
  if (dir && dir !== path) {
    await mkdir(dir, { recursive: true }).catch(() => {});
  }
  await fsWriteFile(path, data);
}

export async function fileSize(path: string): Promise<number> {
  if (!isTauri) return 0;
  try {
    const info = await stat(path);
    return info.size || 0;
  } catch {
    return 0;
  }
}

export async function compressPdf(inputPath: string, outputPath: string, quality: "screen" | "print" | "high"): Promise<CompressResult> {
  if (!isTauri) throw new Error("Compression is only available inside the Tauri app.");
  return invoke<CompressResult>("compress_pdf", { inputPath, outputPath, quality });
}

export async function redactPdf(inputPath: string, outputPath: string, regions: RedactRegion[]): Promise<{ ok: boolean; message?: string }> {
  if (!isTauri) throw new Error("Redaction is only available inside the Tauri app.");
  return invoke("redact_pdf", { inputPath, outputPath, regions });
}

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!isTauri) return Promise.reject(new Error("Store unavailable outside Tauri."));
  if (!storePromise) {
    storePromise = Store.load("settings.json");
  }
  return storePromise;
}

export async function getStoreValue<T>(key: string): Promise<T | null> {
  if (!isTauri) return null;
  try {
    const store = await getStore();
    const value = await store.get<T>(key);
    return value ?? null;
  } catch {
    return null;
  }
}

export async function setStoreValue<T>(key: string, value: T): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.set(key, value);
    await store.save();
  } catch {
    // ignore store errors outside Tauri
  }
}

export async function confirm(message: string): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return ask(message, { kind: "warning" }) as Promise<boolean>;
}
