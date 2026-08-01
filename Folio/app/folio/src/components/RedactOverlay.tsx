import { useRef, useState } from "react";
import type { PageViewport } from "../lib/pdfjs";
import { cssRectToPdfRect, pdfRectToCssRect } from "../lib/pdfjs";
import type { RedactRegion } from "../lib/tauri";

export interface DraftRedactRegion extends RedactRegion {
  id: string;
}

interface RedactOverlayProps {
  viewport: PageViewport;
  scale: number;
  pageIndex: number;
  regions: DraftRedactRegion[];
  onAdd: (region: DraftRedactRegion) => void;
  onRemove: (id: string) => void;
}

/** Lets the user drag out rectangles on top of a rendered page to mark
 * content for redaction. Regions are stored in PDF page-space units so they
 * stay correctly placed regardless of zoom. */
export function RedactOverlay({ viewport, scale, pageIndex, regions, onAdd, onRemove }: RedactOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const relativePos = (e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = relativePos(e);
    startRef.current = pos;
    setDraft({ x: pos.x, y: pos.y, width: 0, height: 0 });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!startRef.current) return;
    const pos = relativePos(e);
    const start = startRef.current;
    setDraft({
      x: Math.min(start.x, pos.x),
      y: Math.min(start.y, pos.y),
      width: Math.abs(pos.x - start.x),
      height: Math.abs(pos.y - start.y),
    });
  };

  const finishDraw = () => {
    if (startRef.current && draft && draft.width > 4 && draft.height > 4) {
      const pdfRect = cssRectToPdfRect(draft.x, draft.y, draft.width, draft.height, viewport, scale);
      onAdd({ id: crypto.randomUUID(), page: pageIndex, ...pdfRect });
    }
    startRef.current = null;
    setDraft(null);
  };

  return (
    <div
      ref={containerRef}
      className="redact-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDraw}
      onPointerLeave={finishDraw}
    >
      {regions.map((r) => {
        const css = pdfRectToCssRect(r.x, r.y, r.width, r.height, viewport, scale);
        return (
          <div
            key={r.id}
            className="redact-overlay__region"
            style={{ left: css.x, top: css.y, width: css.width, height: css.height }}
          >
            <button
              className="redact-overlay__remove"
              aria-label="Remove redaction"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onRemove(r.id); }}
            >
              ×
            </button>
          </div>
        );
      })}
      {draft && (
        <div
          className="redact-overlay__draft"
          style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }}
        />
      )}
    </div>
  );
}
