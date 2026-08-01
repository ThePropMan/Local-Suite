// ============================================================
// @local/ui — components/DropZone.tsx
// Drag-and-drop + click-to-pick, parameterized by accepted
// file extensions and copy. Uses Tauri's native drag-drop
// events (HTML5 dataTransfer doesn't expose file paths).
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { isTauri, onDragDropEvent, pickFiles, type FileFilter } from "../lib/tauri";
import { IconUpload } from "./icons";

interface DropZoneProps {
  /** Lowercase extensions without dot, e.g. ["jpg", "png"]. null = accept all. */
  extensions: string[] | null;
  /** Heading copy, e.g. "Drop photos to strip metadata". */
  heading: string;
  /** Subtext, e.g. "JPEG, PNG, WebP, TIFF". */
  subtext?: string;
  /** Button label, e.g. "Browse files". */
  buttonLabel?: string;
  /** Allow picking multiple files when browsing. */
  multiple?: boolean;
  /** Optional dialog filter name (defaults to "Files"). */
  filterName?: string;
  /** Fired with accepted file paths (already filtered by extension). */
  onFiles: (paths: string[]) => void;
  /** Whether to also accept folder drops (paths are recursed by caller). */
  acceptFolders?: boolean;
  /** Hint shown below the button, e.g. "or drop a folder". */
  hint?: string;
}

export function DropZone({
  extensions,
  heading,
  subtext,
  buttonLabel = "Browse files",
  multiple = true,
  filterName = "Files",
  onFiles,
  acceptFolders = false,
  hint,
}: DropZoneProps) {
  const [active, setActive] = useState(false);
  const [inTauri, setInTauri] = useState(false);

  useEffect(() => {
    setInTauri(isTauri);
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") {
        setActive(true);
      } else if (event.type === "leave") {
        setActive(false);
      } else if (event.type === "drop") {
        setActive(false);
        const paths = filterPaths(event.paths, extensions, acceptFolders);
        if (paths.length > 0) onFiles(paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[DropZone] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, [extensions, acceptFolders, onFiles]);

  const handleBrowse = useCallback(async () => {
    const filters: FileFilter[] | undefined = extensions
      ? [{ name: filterName, extensions }]
      : undefined;
    const paths = await pickFiles(extensions, multiple, filters);
    if (paths.length > 0) onFiles(paths);
  }, [extensions, multiple, filterName, onFiles]);

  return (
    <div
      className={`drop-zone ${active ? "drop-zone--active" : ""}`}
      onClick={handleBrowse}
      role="button"
      tabIndex={0}
      aria-label={`${heading} — ${buttonLabel}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void handleBrowse(); } }}
    >
      <IconUpload className="drop-zone__icon" size={30} />
      <div className="drop-zone__heading">{heading}</div>
      {subtext && <div className="drop-zone__subtext">{subtext}</div>}
      <button
        className="btn btn--secondary btn--sm"
        style={{ marginTop: 8 }}
        onClick={(e) => { e.stopPropagation(); void handleBrowse(); }}
      >
        {buttonLabel}
      </button>
      {hint && <div className="drop-zone__hint">{hint}</div>}
      {!inTauri && (
        <div className="drop-zone__hint" style={{ color: "var(--danger)", marginTop: 6, maxWidth: 280 }}>
          Open inside the desktop app — file features don't work in a browser tab.
        </div>
      )}
    </div>
  );
}

function filterPaths(paths: string[], extensions: string[] | null, acceptFolders: boolean): string[] {
  if (!extensions) return paths;
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    if (acceptFolders && !lower.includes(".")) return true; // likely a folder
    const dot = lower.lastIndexOf(".");
    if (dot < 0) return false;
    return exts.has(lower.slice(dot + 1));
  });
}
