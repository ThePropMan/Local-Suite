import { useState, useCallback } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, type RecentFile } from "../lib/tauri";
import { reorderPages } from "../tools/reorder/reorder";

interface ReorderPanelProps {
  filePath: string | null;
  pageCount: number;
  onRecent: (file: RecentFile) => void;
}

export function ReorderPanel({ filePath, pageCount, onRecent }: ReorderPanelProps) {
  const [order, setOrder] = useState<number[]>(() => Array.from({ length: pageCount }, (_, i) => i));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed when pageCount changes (new file loaded)
  if (order.length !== pageCount && pageCount > 0) {
    setOrder(Array.from({ length: pageCount }, (_, i) => i));
  }

  const move = useCallback((from: number, to: number) => {
    setOrder((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const run = async () => {
    if (!filePath || pageCount === 0) return;
    const isUnchanged = order.every((v, i) => v === i);
    if (isUnchanged) {
      showToast("Pages are already in this order", "error");
      return;
    }
    setSaving(true);
    try {
      const bytes = await readFileBytes(filePath);
      const out = await reorderPages(bytes, order);
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_reordered.pdf`)) || `${outputFolder}\\${baseName}_reordered.pdf`;
      await writeFileBytes(outputPath, out);
      showToast(`Reordered ${pageCount} pages`, "success");
      onRecent({ name: `${baseName}_reordered.pdf`, path: outputPath, tool: "reorder", timestamp: Date.now(), sizeBefore: bytes.length, sizeAfter: out.length });
    } catch (e: any) {
      showToast(e.message || "Reorder failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (pageCount === 0) {
    return <p style={{ fontSize: 12, color: "var(--text-3)" }}>Open a PDF to reorder its pages.</p>;
  }

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>Drag the handle to reorder. The list shows the new page sequence.</p>
      <div className="file-list reorder-list" style={{ maxHeight: 260, overflowY: "auto" }}>
        {order.map((srcIndex, displayIndex) => (
          <div
            key={srcIndex}
            className="file-list__item"
            draggable
            onDragStart={() => setDragIndex(displayIndex)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null) move(dragIndex, displayIndex);
              setDragIndex(null);
            }}
            style={{ opacity: dragIndex === displayIndex ? 0.4 : 1 }}
          >
            <span className="file-list__handle" aria-hidden="true" style={{ display: "flex", alignItems: "center" }}>
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                <circle cx="2" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" />
                <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
                <circle cx="2" cy="11" r="1.2" /><circle cx="8" cy="11" r="1.2" />
              </svg>
            </span>
            <span className="file-list__name">Page {srcIndex + 1}</span>
            <span style={{ fontSize: 10, color: "var(--text-3)" }}>#{displayIndex + 1}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn-ghost"
          onClick={() => setOrder(Array.from({ length: pageCount }, (_, i) => i))}
          disabled={order.every((v, i) => v === i)}
        >
          Reset
        </button>
        <button className="btn-ghost" onClick={() => setOrder([...order].reverse())}>Reverse</button>
      </div>
      <button className="btn-primary" onClick={run} disabled={saving}>Save reordered PDF</button>
    </>
  );
}
