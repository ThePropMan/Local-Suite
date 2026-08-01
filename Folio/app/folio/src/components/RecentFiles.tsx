import type { ReactNode } from "react";
import { type RecentFile } from "../lib/tauri";

const TOOL_ICONS: Record<string, ReactNode> = {
  merge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 7h8v10H8zM4 7h4M16 7h4M4 17h4M16 17h4" />
    </svg>
  ),
  split: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 7h8v10H8zM12 7v10" />
    </svg>
  ),
  compress: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 7h8v10H8zM4 12h16" />
    </svg>
  ),
  fill: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 7h8v10H8zM9 11h6M9 14h4" />
    </svg>
  ),
  sign: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 17l4-10 4 10 4-7 4 7" />
    </svg>
  ),
  redact: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 5h14v14H5zM5 5l14 14M19 5L5 19" />
    </svg>
  ),
};

interface RecentFilesProps {
  files: RecentFile[];
  onOpen: (file: RecentFile) => void;
  onClear: () => void;
  title?: string;
  showClear?: boolean;
}

function formatSize(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecentFiles({ files, onOpen, onClear, title = "Recent", showClear = true }: RecentFilesProps) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="eyebrow">{title}</h2>
        {showClear && files.length > 0 && (
          <button className="btn btn--ghost" onClick={onClear}>Clear</button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="empty-state">No files yet. Open a PDF to get started.</p>
      ) : (
        <div className="recent-list" role="list">
          {files.map((file) => (
            <button
              key={file.path}
              className="recent-list__item"
              role="listitem"
              onClick={() => onOpen(file)}
            >
              <span className="tool-card__icon" style={{ width: 16, height: 16 }}>{file.tool ? (TOOL_ICONS[file.tool] || null) : null}</span>
              <span className="recent-list__name">{file.name}</span>
              <span className="recent-list__meta">
                {file.tool} · {new Date(file.timestamp).toLocaleDateString()} {formatSize(file.sizeAfter || file.sizeBefore)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
