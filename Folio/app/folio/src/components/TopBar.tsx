interface TopBarProps {
  filename: string;
  pageCount: number;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  onZoomToWidth: () => void;
  onClose: () => void;
}

export function TopBar({ filename, pageCount, zoom, onZoomIn, onZoomOut, onZoomToFit, onZoomToWidth, onClose }: TopBarProps) {
  return (
    <div className="topbar">
      <div className="topbar__left">
        <svg className="topbar__file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M14 3v4a1 1 0 001 1h4M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5z" />
        </svg>
        <span className="topbar__filename">{filename}</span>
        <span className="topbar__pages">{pageCount} page{pageCount === 1 ? "" : "s"}</span>
      </div>
      <div className="topbar__right">
        <div className="topbar__group">
          <button className="topbar__btn topbar__btn--grouped" aria-label="Zoom out" onClick={onZoomOut}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <span className="topbar__zoom-level">{Math.round(zoom * 100)}%</span>
          <button className="topbar__btn topbar__btn--grouped" aria-label="Zoom in" onClick={onZoomIn}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="topbar__group">
          <button className="topbar__btn topbar__btn--grouped" aria-label="Zoom to fit" onClick={onZoomToFit} title="Zoom to fit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
            </svg>
          </button>
          <button className="topbar__btn topbar__btn--grouped" aria-label="Zoom to width" onClick={onZoomToWidth} title="Zoom to width">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" />
            </svg>
          </button>
        </div>
        <button className="topbar__btn" aria-label="Close document" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
