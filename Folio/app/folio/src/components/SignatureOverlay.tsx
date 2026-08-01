import { useRef, useState } from "react";
import type { PageViewport } from "../lib/pdfjs";
import { cssRectToPdfRect, pdfRectToCssRect } from "../lib/pdfjs";

export interface SignaturePlacement {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SignatureOverlayProps {
  viewport: PageViewport;
  scale: number;
  signature: string;
  placement: SignaturePlacement;
  onMove: (placement: SignaturePlacement) => void;
}

/** A draggable preview of where the signature will be stamped onto the
 * page. Only position changes (not size) — drag it wherever it should go. */
export function SignatureOverlay({ viewport, scale, signature, placement, onMove }: SignatureOverlayProps) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);

  const css = pdfRectToCssRect(placement.x, placement.y, placement.width, placement.height, viewport, scale);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, y: e.clientY };
    setDragOffset({ dx: 0, dy: 0 });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!startRef.current) return;
    setDragOffset({ dx: e.clientX - startRef.current.x, dy: e.clientY - startRef.current.y });
  };

  const onPointerUp = () => {
    if (!startRef.current || !dragOffset) return;
    const newCssX = css.x + dragOffset.dx;
    const newCssY = css.y + dragOffset.dy;
    const pdfRect = cssRectToPdfRect(newCssX, newCssY, css.width, css.height, viewport, scale);
    onMove({ page: placement.page, x: pdfRect.x, y: pdfRect.y, width: placement.width, height: placement.height });
    startRef.current = null;
    setDragOffset(null);
  };

  const left = css.x + (dragOffset?.dx || 0);
  const top = css.y + (dragOffset?.dy || 0);

  return (
    <img
      src={signature}
      alt="Signature placement"
      className="signature-overlay"
      style={{ left, top, width: css.width, height: css.height }}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
