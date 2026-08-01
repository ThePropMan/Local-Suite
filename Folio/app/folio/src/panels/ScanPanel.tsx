import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { type RecentFile } from "../lib/tauri";
import { scanForTextLayer, type ScanResult } from "../tools/scan/scan";

interface ScanPanelProps {
  /** Already-loaded pdf.js document proxy for the current file. */
  pdfDoc: import("../lib/pdfjs").PDFDocumentProxy | null;
  onRecent: (file: RecentFile) => void;
}

export function ScanPanel({ pdfDoc }: ScanPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const run = async () => {
    if (!pdfDoc) return;
    setScanning(true);
    setResult(null);
    try {
      const res = await scanForTextLayer(pdfDoc);
      setResult(res);
      if (res.noTextPages.length === 0) {
        showToast(`All ${res.totalPages} pages have a text layer`, "success");
      } else {
        showToast(`${res.noTextPages.length} page${res.noTextPages.length === 1 ? "" : "s"} have no text layer`, "error");
      }
    } catch (e: any) {
      showToast(e.message || "Scan failed", "error");
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>
        Checks each page for an extractable text layer. Pages without one are likely scanned images that would need OCR to be searchable.
      </p>
      <button className="btn-primary" onClick={run} disabled={scanning || !pdfDoc}>
        {scanning ? "Scanning…" : "Scan for text layer"}
      </button>
      {result && (
        <div className="result-box">
          <div style={{ fontWeight: 600, color: "var(--text-1)", marginBottom: 4 }}>
            {result.totalPages} page{result.totalPages === 1 ? "" : "s"} checked
          </div>
          {result.noTextPages.length === 0 ? (
            <div>Every page has a text layer.</div>
          ) : (
            <>
              <div style={{ marginBottom: 4 }}>
                {result.noTextPages.length} page{result.noTextPages.length === 1 ? "" : "s"} with no text layer:
              </div>
              <div style={{ color: "var(--text-3)", lineHeight: 1.6 }}>
                {result.noTextPages.map((p) => p + 1).join(", ")}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-3)" }}>
                These pages look like scanned images. Run them through an OCR tool (e.g. Tesseract, Adobe, or macOS Preview) to add a searchable text layer.
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
