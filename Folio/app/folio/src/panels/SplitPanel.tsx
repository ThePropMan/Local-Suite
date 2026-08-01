import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, type RecentFile } from "../lib/tauri";
import { parseRanges, splitPdf } from "../tools/split/split";

interface SplitPanelProps {
  filePath: string | null;
  pageCount: number;
  onRecent: (file: RecentFile) => void;
}

export function SplitPanel({ filePath, pageCount, onRecent }: SplitPanelProps) {
  const [rangeInput, setRangeInput] = useState("");
  const [splitAll, setSplitAll] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (!filePath) return;

    let ranges: [number, number][];
    if (splitAll) {
      ranges = Array.from({ length: pageCount }, (_, i) => [i, i] as [number, number]);
    } else {
      if (!rangeInput.trim()) {
        setError("Enter a page range, e.g. 1-3, 7, 10-12");
        return;
      }
      const parsed = parseRanges(rangeInput, pageCount);
      if (!parsed.ok) {
        setError(parsed.error || "Invalid range");
        return;
      }
      setError("");
      ranges = parsed.ranges;
    }
    if (ranges.length === 0) {
      setError("Enter a page range, e.g. 1-3, 7, 10-12");
      return;
    }

    try {
      const bytes = await readFileBytes(filePath);
      const outputs = await splitPdf(bytes, ranges);
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      let totalOut = 0;
      for (const out of outputs) {
        const outPath = `${outputFolder}\\${baseName}_${out.name}`;
        await writeFileBytes(outPath, out.bytes);
        totalOut += out.bytes.length;
      }
      showToast(`Created ${outputs.length} file${outputs.length === 1 ? "" : "s"}`, "success");
      onRecent({ name: `${baseName}_split.pdf`, path: `${outputFolder}\\${baseName}_${outputs[0].name}`, tool: "split", timestamp: Date.now(), sizeBefore: bytes.length, sizeAfter: totalOut });
    } catch (e: any) {
      showToast(e.message || "Split failed", "error");
    }
  };

  return (
    <>
      <div>
        <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Page ranges</label>
        <input
          className={`input ${error ? "input--error" : ""}`}
          value={rangeInput}
          onChange={(e) => { setRangeInput(e.target.value); setError(""); }}
          placeholder="1–3, 7, 10–12"
          disabled={splitAll}
        />
        {error && <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{error}</p>}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-1)", cursor: "pointer" }}>
        <input type="checkbox" checked={splitAll} onChange={(e) => setSplitAll(e.target.checked)} />
        Split every page into separate files
      </label>
      <button className="btn-primary" onClick={run}>Split PDF</button>
    </>
  );
}
