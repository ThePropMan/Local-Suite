import { useState, useRef, useEffect, useCallback } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, type RecentFile } from "../lib/tauri";
import { PDFDocument } from "pdf-lib";
import type { SignaturePlacement } from "../components/SignatureOverlay";

interface SignPanelProps {
  filePath: string | null;
  onRecent: (file: RecentFile) => void;
  signature: string | null;
  onSignatureChange: (dataUrl: string | null) => void;
  placement: SignaturePlacement | null;
  pageCount: number;
  onPlacementChange: (placement: SignaturePlacement) => void;
}

const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

export function SignPanel({ filePath, onRecent, signature, onSignatureChange, placement, pageCount, onPlacementChange }: SignPanelProps) {
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const [drawOpen, setDrawOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);

  // (Re)initialize the modal canvas each time the popup opens. Restores the
  // last signature so the user can keep refining instead of starting over.
  const initCanvas = useCallback((preserve: boolean) => {
    const c = canvasRef.current;
    if (!c) return;
    // Size the canvas to its rendered CSS box (set by the modal layout) at
    // device-pixel-ratio for crisp strokes.
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const prev = preserve && signature ? signature : null;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "#1a1a18";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (prev) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, h);
      img.src = prev;
    }
  }, [signature]);

  // Wait one frame after opening so the canvas has its final laid-out size
  // before we read getBoundingClientRect.
  useEffect(() => {
    if (!drawOpen) return;
    const id = requestAnimationFrame(() => initCanvas(!!signature));
    return () => cancelAnimationFrame(id);
  }, [drawOpen, initCanvas, signature]);

  // Esc closes the popup (committing the current drawing first).
  useEffect(() => {
    if (!drawOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        commit();
        setDrawOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawOpen]);

  const getPos = (e: React.PointerEvent) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrawing(true);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      const pos = getPos(e);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  };

  const stop = () => {
    if (!drawing) return;
    setDrawing(false);
    commit();
  };

  const commit = () => {
    const c = canvasRef.current;
    if (!c) return;
    // Only emit if there's actual pixel content — avoid replacing a real
    // signature with a blank frame when the popup closes without drawing.
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let hasInk = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) { hasInk = true; break; }
    }
    onSignatureChange(hasInk ? c.toDataURL("image/png") : null);
  };

  const clear = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = "#1a1a18";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    onSignatureChange(null);
  };

  const renderType = (text: string) => {
    if (!text) { onSignatureChange(null); return; }
    const c = document.createElement("canvas");
    c.width = 168;
    c.height = 80;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.font = '28px "Brush Script MT", cursive, sans-serif';
      ctx.fillStyle = "#1a1a18";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 10, c.height / 2);
    }
    onSignatureChange(c.toDataURL("image/png"));
  };

  const apply = async () => {
    if (!filePath || !signature || !placement) return;
    try {
      const bytes = await readFileBytes(filePath);
      const doc = await PDFDocument.load(bytes);
      const png = signature.split(",")[1];
      const pngBytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const img = await doc.embedPng(pngBytes);
      const page = doc.getPage(placement.page);
      page.drawImage(img, { x: placement.x, y: placement.y, width: placement.width, height: placement.height });
      const out = await doc.save();
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_signed.pdf`)) || `${outputFolder}\\${baseName}_signed.pdf`;
      await writeFileBytes(outputPath, out);
      showToast("Signed PDF saved", "success");
      onRecent({ name: `${baseName}_signed.pdf`, path: outputPath, tool: "sign", timestamp: Date.now(), sizeBefore: bytes.length });
    } catch (e: any) {
      showToast(e.message || "Could not save signed PDF", "error");
    }
  };

  return (
    <>
      <div className="tab-strip">
        <button className={`tab ${tab === "draw" ? "tab--active" : ""}`} onClick={() => setTab("draw")}>Draw</button>
        <button className={`tab ${tab === "type" ? "tab--active" : ""}`} onClick={() => setTab("type")}>Type</button>
      </div>
      {tab === "draw" ? (
        <>
          {signature ? (
            <div className="sig-preview" onClick={() => setDrawOpen(true)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setDrawOpen(true); }}
              aria-label="Edit signature"
            >
              <img src={signature} alt="Your signature" />
              <span className="sig-preview__hint">Click to edit</span>
            </div>
          ) : (
            <button className="btn-primary" onClick={() => setDrawOpen(true)}>Open draw pad</button>
          )}
          {signature && (
            <button className="btn-ghost" onClick={() => { clear(); setDrawOpen(true); }}>Clear & redraw</button>
          )}
        </>
      ) : (
        <>
          <input
            className="input"
            value={typed}
            onChange={(e) => { setTyped(e.target.value); renderType(e.target.value); }}
            placeholder="Type your signature"
            style={{ fontFamily: '"Brush Script MT", cursive, sans-serif', fontSize: 20 }}
          />
          {typed && (
            <div style={{ fontFamily: '"Brush Script MT", cursive, sans-serif', fontSize: 28, color: "var(--text-1)", padding: "8px 0" }}>{typed}</div>
          )}
        </>
      )}
      {signature && placement && (
        <div>
          <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Page</label>
          <input
            className="input"
            type="number"
            min={1}
            max={pageCount}
            value={placement.page + 1}
            onChange={(e) => {
              const page = Math.min(pageCount, Math.max(1, parseInt(e.target.value, 10) || 1)) - 1;
              onPlacementChange({ ...placement, page });
            }}
            style={{ width: 64 }}
          />
        </div>
      )}
      <p style={{ fontSize: 11, color: "var(--text-3)" }}>Drag your signature onto the document to position it.</p>
      <button className="btn-primary" onClick={apply} disabled={!signature || !placement}>Apply signature</button>

      {drawOpen && (
        <div className="sig-modal" role="dialog" aria-label="Draw signature" onMouseDown={(e) => { if (e.target === e.currentTarget) { commit(); setDrawOpen(false); } }}>
          <div className="sig-modal__panel">
            <div className="sig-modal__header">
              <span className="sig-modal__title">Draw your signature</span>
              <button className="sig-modal__close" aria-label="Close" onClick={() => { commit(); setDrawOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <canvas
              ref={canvasRef}
              className="sig-modal__canvas"
              style={{ touchAction: "none", cursor: "crosshair" }}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={stop}
              onPointerLeave={stop}
            />
            <div className="sig-modal__footer">
              <button className="btn-ghost" onClick={clear}>Clear</button>
              <button className="btn-primary" style={{ width: "auto", padding: "9px 18px" }} onClick={() => { commit(); setDrawOpen(false); }}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
