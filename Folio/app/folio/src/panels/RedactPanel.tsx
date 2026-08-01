import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { getStoreValue, savePdfPath, redactPdf, confirm, type RecentFile, type RedactRegion } from "../lib/tauri";

interface RedactPanelProps {
  filePath: string | null;
  regions: RedactRegion[];
  onRecent: (file: RecentFile) => void;
}

export function RedactPanel({ filePath, regions, onRecent }: RedactPanelProps) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!filePath || regions.length === 0) return;
    const ok = await confirm("Redacted content is permanently removed and cannot be recovered.");
    if (!ok) return;
    setSaving(true);
    try {
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_redacted.pdf`)) || `${outputFolder}\\${baseName}_redacted.pdf`;
      await redactPdf(filePath, outputPath, regions);
      showToast("Redacted PDF saved", "success");
      onRecent({ name: `${baseName}_redacted.pdf`, path: outputPath, tool: "redact", timestamp: Date.now() });
    } catch (e: any) {
      showToast(e.message || "Could not redact PDF", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>Draw over any text or area to redact.</p>
      <p style={{ fontSize: 12, color: "var(--text-1)" }}>{regions.length} region{regions.length === 1 ? "" : "s"} marked</p>
      <div className="warning-block">Redacted content is permanently removed.</div>
      <button className="btn-primary" onClick={save} disabled={saving || regions.length === 0}>Save redacted PDF</button>
    </>
  );
}
