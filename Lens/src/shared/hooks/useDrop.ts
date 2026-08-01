// ============================================================
// @local/ui — hooks/useDrop.ts
// Subscribes to Tauri window-level drag-drop events and calls
// back with the filtered file paths. Useful for "drop anywhere
// on the window" behavior that isn't tied to a single DropZone.
// ============================================================

import { useEffect, useRef } from "react";
import { onDragDropEvent } from "../lib/tauri";

interface UseDropOptions {
  extensions: string[] | null;
  onDrop: (paths: string[]) => void;
  onHoverChange?: (hovering: boolean) => void;
  acceptFolders?: boolean;
}

export function useDrop({ extensions, onDrop, onHoverChange, acceptFolders = false }: UseDropOptions) {
  const onDropRef = useRef(onDrop);
  const onHoverRef = useRef(onHoverChange);
  onDropRef.current = onDrop;
  onHoverRef.current = onHoverChange;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") {
        onHoverRef.current?.(true);
      } else if (event.type === "leave") {
        onHoverRef.current?.(false);
      } else if (event.type === "drop") {
        onHoverRef.current?.(false);
        const paths = filterPaths(event.paths, extensions, acceptFolders);
        if (paths.length > 0) onDropRef.current(paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[useDrop] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, [extensions, acceptFolders]);
}

function filterPaths(paths: string[], extensions: string[] | null, acceptFolders: boolean): string[] {
  if (!extensions) return paths;
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    if (acceptFolders && !lower.includes(".")) return true;
    const dot = lower.lastIndexOf(".");
    if (dot < 0) return false;
    return exts.has(lower.slice(dot + 1));
  });
}
