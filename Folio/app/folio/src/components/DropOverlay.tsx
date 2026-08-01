import { useState, useEffect, useCallback } from "react";
import { isTauri, type RecentFile } from "../lib/tauri";
import { FolioLogo } from "./FolioLogo";

interface DropOverlayProps {
  onFiles: (paths: string[]) => void;
  onBrowse: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  /** Driven by the app-level Tauri drag/drop listener so the highlight shows
   *  even though this component no longer attaches its own listener. */
  dragging?: boolean;
}

export function DropOverlay({ onBrowse, recent, onOpenRecent, dragging = false }: DropOverlayProps) {
  const [inTauri, setInTauri] = useState(false);

  useEffect(() => {
    setInTauri(isTauri);
  }, []);

  const handleBrowse = useCallback(() => {
    onBrowse();
  }, [onBrowse]);

  return (
    <div className="drop-overlay">
      <FolioLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={handleBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop a PDF file or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") handleBrowse(); }}
      >
        <svg className="drop-zone__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
        </svg>
        <div className="drop-zone__heading">Drop a PDF to get started</div>
        <div className="drop-zone__subtext">or pick from your files</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); handleBrowse(); }}>
          Browse files
        </button>
        {!inTauri && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--danger)", maxWidth: 280 }}>
            Open inside the Folio desktop window — PDF features don't work in a browser tab.
          </div>
        )}
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--text-3)", flexShrink: 0 }} aria-hidden="true">
                  <path d="M14 3v4a1 1 0 001 1h4M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5z" />
                </svg>
                <span className="recent-list__name">{file.name}</span>
                <span className="recent-list__meta">{file.tool}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
