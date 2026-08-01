// ============================================================
// @local/ui — types.ts
// Shared type definitions used across all Local apps.
// ============================================================

export type Theme = "system" | "light" | "dark";

export interface DroppedFile {
  path: string;
  name: string;
}

export interface RecentFile {
  name: string;
  path: string;
  /** Optional app-specific tool/action that produced or opened the file. */
  tool?: string;
  timestamp: number;
  /** Optional before/after sizes (bytes) for tools that transform files. */
  sizeBefore?: number;
  sizeAfter?: number;
}

export interface NavItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}
