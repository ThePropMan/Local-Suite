// ============================================================
// @local/ui — hooks/useRecentFiles.ts
// Persistent recent-files list, parameterized by store key and
// max items. Works inside Tauri (plugin-store) and falls back
// to localStorage in a browser.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { getStoreValue, setStoreValue } from "../lib/tauri";
import type { RecentFile } from "../types";

interface UseRecentFilesOptions {
  /** Store key for the recent list. */
  storeKey?: string;
  /** Max items to keep. */
  max?: number;
  /** Store file name (defaults to ".settings.json"). */
  storeName?: string;
}

export function useRecentFiles(options: UseRecentFilesOptions = {}) {
  const { storeKey = "recent", max = 12, storeName } = options;
  const [recent, setRecent] = useState<RecentFile[]>([]);

  useEffect(() => {
    getStoreValue<RecentFile[]>(storeKey, storeName).then((list) => {
      if (Array.isArray(list)) setRecent(list);
    });
  }, [storeKey, storeName]);

  const persist = useCallback(async (list: RecentFile[]) => {
    setRecent(list);
    await setStoreValue(storeKey, list, storeName);
  }, [storeKey, storeName]);

  const addRecent = useCallback(async (file: RecentFile) => {
    setRecent((prev) => {
      const dedup = prev.filter((f) => f.path !== file.path);
      const next = [file, ...dedup].slice(0, max);
      void setStoreValue(storeKey, next, storeName);
      return next;
    });
  }, [max, storeKey, storeName]);

  const clearRecent = useCallback(async () => {
    await persist([]);
  }, [persist]);

  const removeRecent = useCallback(async (path: string) => {
    setRecent((prev) => {
      const next = prev.filter((f) => f.path !== path);
      void setStoreValue(storeKey, next, storeName);
      return next;
    });
  }, [storeKey, storeName]);

  return { recent, addRecent, clearRecent, removeRecent };
}
