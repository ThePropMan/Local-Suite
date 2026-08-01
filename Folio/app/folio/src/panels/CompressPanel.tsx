import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, getStoreValue, savePdfPath, compressPdf, fileSize, type RecentFile } from "../lib/tauri";

interface CompressPanelProps {
  filePath: string | null;
  onRecent: (file: RecentFile) => void;
}

type Quality = "screen" | "print" | "high";

const PRESETS: { id: Quality; label: string; desc: string }[] = [
  { id: "screen", label: "Screen", desc: "72 dpi · smallest" },
  { id: "print", label: "Print", desc: "150 dpi · balanced" },
  { id: "high", label: "High", desc: "300 dpi · largest" },
];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CompressPanel({ filePath, onRecent }: CompressPanelProps) {
  const [quality, setQuality] = useState<Quality>("print");
  const [result, setResult] = useState<{ before: number; after: number; message?: string } | null>(null);
  const [progressing, setProgressing] = useState(false);

  const run = async () => {
    if (!filePath) return;
    setProgressing(true);
    setResult(null);
    try {
      const bytes = await readFileBytes(filePath);
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_compressed.pdf`)) || `${outputFolder}\\${baseName}_compressed.pdf`;
      const res = await compressPdf(filePath, outputPath, quality);
      const size = await fileSize(outputPath);
      setResult({ before: bytes.length, after: res.output_bytes || size, message: res.message });
      showToast(`Compressed · ${formatSize(bytes.length)} → ${formatSize(res.output_bytes || size)}`, "success");
      onRecent({ name: `${baseName}_compressed.pdf`, path: outputPath, tool: "compress", timestamp: Date.now(), sizeBefore: bytes.length, sizeAfter: res.output_bytes || size });
    } catch (e: any) {
      showToast(e.message || "Compression failed", "error");
    } finally {
      setProgressing(false);
    }
  };

  return (
    <>
      <div>
        <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Quality</label>
        <div className="preset-group">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset ${quality === p.id ? "preset--selected" : ""}`}
              onClick={() => setQuality(p.id)}
            >
              <div className="preset__label">{p.label}</div>
              <div className="preset__desc">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>
      {result && (
        <div className="result-box">
          {formatSize(result.before)} → {formatSize(result.after)}
          {result.message && <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>{result.message}</div>}
        </div>
      )}
      <div className="progress">
        <div className="progress__fill" style={{ width: progressing ? "100%" : "0%" }} />
      </div>
      <button className="btn-primary" onClick={run} disabled={progressing}>Save compressed PDF</button>
    </>
  );
}
