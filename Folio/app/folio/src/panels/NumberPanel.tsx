import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, type RecentFile } from "../lib/tauri";
import { addPageNumbers, type NumberPosition } from "../tools/number/number";

interface NumberPanelProps {
  filePath: string | null;
  pageCount: number;
  onRecent: (file: RecentFile) => void;
}

const POSITIONS: { id: NumberPosition; label: string }[] = [
  { id: "bottom-center", label: "Bottom center" },
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-center", label: "Top center" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
];

const FORMATS: { id: "n" | "n-of-m" | "page-n" | "page-n-of-m"; label: string; example: string }[] = [
  { id: "n", label: "1, 2, 3", example: "1" },
  { id: "n-of-m", label: "1 / 5", example: "1 / 5" },
  { id: "page-n", label: "Page 1", example: "Page 1" },
  { id: "page-n-of-m", label: "Page 1 of 5", example: "Page 1 of 5" },
];

export function NumberPanel({ filePath, pageCount, onRecent }: NumberPanelProps) {
  const [startAt, setStartAt] = useState(1);
  const [position, setPosition] = useState<NumberPosition>("bottom-center");
  const [format, setFormat] = useState<"n" | "n-of-m" | "page-n" | "page-n-of-m">("n-of-m");
  const [fontSize, setFontSize] = useState(10);
  const [saving, setSaving] = useState(false);

  const run = async () => {
    if (!filePath || pageCount === 0) return;
    setSaving(true);
    try {
      const bytes = await readFileBytes(filePath);
      const out = await addPageNumbers(bytes, { startAt, position, format, fontSize, margin: 28 });
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_numbered.pdf`)) || `${outputFolder}\\${baseName}_numbered.pdf`;
      await writeFileBytes(outputPath, out);
      showToast(`Numbered ${pageCount} pages`, "success");
      onRecent({ name: `${baseName}_numbered.pdf`, path: outputPath, tool: "number", timestamp: Date.now(), sizeBefore: bytes.length, sizeAfter: out.length });
    } catch (e: any) {
      showToast(e.message || "Could not add page numbers", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>Stamp page numbers onto every page. Numbers are flattened into the content.</p>
      <div>
        <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Format</label>
        <div className="preset-group">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`preset ${format === f.id ? "preset--selected" : ""}`}
              onClick={() => setFormat(f.id)}
            >
              <div className="preset__label">{f.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Position</label>
        <select
          className="input"
          value={position}
          onChange={(e) => setPosition(e.target.value as NumberPosition)}
        >
          {POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Start at</label>
          <input
            className="input"
            type="number"
            min={0}
            value={startAt}
            onChange={(e) => setStartAt(Math.max(0, parseInt(e.target.value, 10) || 0))}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Font size</label>
          <input
            className="input"
            type="number"
            min={6}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Math.min(24, Math.max(6, parseInt(e.target.value, 10) || 10)))}
          />
        </div>
      </div>
      <button className="btn-primary" onClick={run} disabled={saving || pageCount === 0}>Save numbered PDF</button>
    </>
  );
}
