import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, confirm, type RecentFile } from "../lib/tauri";
import { parseRanges } from "../tools/split/split";
import { deletePages } from "../tools/delete/delete";

interface DeletePanelProps {
  filePath: string | null;
  pageCount: number;
  onRecent: (file: RecentFile) => void;
}

export function DeletePanel({ filePath, pageCount, onRecent }: DeletePanelProps) {
  const [rangeInput, setRangeInput] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const run = async () => {
    if (!filePath) return;
    if (!rangeInput.trim()) {
      setError("Enter a page range, e.g. 3, 7-9");
      return;
    }
    const parsed = parseRanges(rangeInput, pageCount);
    if (!parsed.ok) {
      setError(parsed.error || "Invalid range");
      return;
    }
    const indices = new Set<number>();
    for (const [a, b] of parsed.ranges) for (let i = a; i <= b; i++) indices.add(i);
    if (indices.size === 0) {
      setError("Enter a page range, e.g. 3, 7-9");
      return;
    }
    if (indices.size >= pageCount) {
      setError("You can't delete every page.");
      return;
    }
    const ok = await confirm(`Delete ${indices.size} page${indices.size === 1 ? "" : "s"}? This can't be undone.`);
    if (!ok) return;

    setError("");
    setSaving(true);
    try {
      const bytes = await readFileBytes(filePath);
      const out = await deletePages(bytes, Array.from(indices));
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_deleted.pdf`)) || `${outputFolder}\\${baseName}_deleted.pdf`;
      await writeFileBytes(outputPath, out);
      showToast(`Deleted ${indices.size} page${indices.size === 1 ? "" : "s"} · ${pageCount - indices.size} remaining`, "success");
      onRecent({ name: `${baseName}_deleted.pdf`, path: outputPath, tool: "delete", timestamp: Date.now(), sizeBefore: bytes.length, sizeAfter: out.length });
    } catch (e: any) {
      showToast(e.message || "Delete failed", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>Remove pages from the PDF. The rest are renumbered automatically.</p>
      <div>
        <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Pages to delete</label>
        <input
          className={`input ${error ? "input--error" : ""}`}
          value={rangeInput}
          onChange={(e) => { setRangeInput(e.target.value); setError(""); }}
          placeholder="3, 7-9, 12"
        />
        {error && <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{error}</p>}
      </div>
      <div className="warning-block">Deleted pages are permanently removed from the copy.</div>
      <button className="btn-primary" onClick={run} disabled={saving || pageCount === 0}>Save deleted PDF</button>
    </>
  );
}
