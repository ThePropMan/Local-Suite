// ============================================================
// Lens — lib/tauri.ts
// App-specific invoke wrappers for the Lens color picker.
// ============================================================

import { invoke } from "@tauri-apps/api/core";

export interface ColorEntry {
  hex: string;
  r: number;
  g: number;
  b: number;
  timestamp: number;
}

export interface Palette {
  id: string;
  name: string;
  colors: string[];
  created: number;
}

export interface LoupeData {
  width: number;
  height: number;
  pixels: number[]; // RGBA
  center_hex: string;
  center_r: number;
  center_g: number;
  center_b: number;
}

// ---------- Screen capture ----------

export async function captureLoupeRegion(size?: number): Promise<LoupeData> {
  return await invoke<LoupeData>("capture_loupe_region", { size });
}

// ---------- Window management ----------

export async function startPick(): Promise<void> {
  await invoke("start_pick");
}

export async function cancelPick(): Promise<void> {
  await invoke("cancel_pick");
}

// ---------- History ----------

export async function getHistory(): Promise<ColorEntry[]> {
  return await invoke<ColorEntry[]>("get_history");
}

export async function clearHistory(): Promise<void> {
  await invoke("clear_history");
}

// ---------- Palettes ----------

export async function loadPalettes(): Promise<Palette[]> {
  return await invoke<Palette[]>("load_palettes");
}

export async function savePalette(palette: Palette): Promise<Palette[]> {
  return await invoke<Palette[]>("save_palette", { palette });
}

export async function deletePalette(id: string): Promise<Palette[]> {
  return await invoke<Palette[]>("delete_palette", { id });
}

export async function exportPalette(palette: Palette, format: "json" | "css"): Promise<string> {
  return await invoke<string>("export_palette", { palette, format });
}

// ---------- Color conversion helpers (pure JS, for the UI) ----------

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, "0").toUpperCase()}${g.toString(16).padStart(2, "0").toUpperCase()}${b.toString(16).padStart(2, "0").toUpperCase()}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return [Math.round(h * 10) / 10, Math.round(s * 1000) / 10, Math.round(l * 1000) / 10];
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export type CopyFormat = "hex" | "rgb" | "hsl";

export function formatColor(r: number, g: number, b: number, fmt: CopyFormat): string {
  switch (fmt) {
    case "hex": return rgbToHex(r, g, b);
    case "rgb": return `rgb(${r}, ${g}, ${b})`;
    case "hsl": {
      const [h, s, l] = rgbToHsl(r, g, b);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
  }
}
