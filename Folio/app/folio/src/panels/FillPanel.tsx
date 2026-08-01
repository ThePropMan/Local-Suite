import { useState } from "react";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, type RecentFile } from "../lib/tauri";
import { PDFDocument } from "pdf-lib";

interface FillPanelProps {
  filePath: string | null;
  fields: { name: string; filled: boolean }[];
  values: Record<string, string | boolean>;
  onRecent: (file: RecentFile) => void;
}

export function FillPanel({ filePath, fields, values, onRecent }: FillPanelProps) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!filePath) return;
    setSaving(true);
    try {
      const bytes = await readFileBytes(filePath);
      const pdfDoc = await PDFDocument.load(bytes);
      const form = pdfDoc.getForm();
      for (const [name, value] of Object.entries(values)) {
        try {
          if (typeof value === "boolean") {
            const checkbox = form.getCheckBox(name);
            if (value) checkbox.check(); else checkbox.uncheck();
          } else if (value) {
            form.getTextField(name).setText(value);
          }
        } catch {
          // Field type mismatch or missing field — skip it rather than
          // failing the whole save.
        }
      }
      form.flatten();
      const out = await pdfDoc.save();
      const outputFolder = (await getStoreValue<string>("outputFolder")) || filePath.substring(0, filePath.lastIndexOf("\\"));
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "document";
      const outputPath = (await savePdfPath(`${outputFolder}\\${baseName}_filled.pdf`)) || `${outputFolder}\\${baseName}_filled.pdf`;
      await writeFileBytes(outputPath, out);
      showToast("Saved filled PDF", "success");
      onRecent({ name: `${baseName}_filled.pdf`, path: outputPath, tool: "fill", timestamp: Date.now(), sizeBefore: bytes.length });
    } catch (e: any) {
      showToast(e.message || "Could not save filled PDF", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 12, color: "var(--text-2)" }}>Click a field in the document to start typing.</p>
      <div className="field-list">
        {fields.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-3)" }}>No fillable fields detected.</p>
        ) : (
          fields.map((field, i) => (
            <div key={i} className="field-list__item">
              <span className={`field-list__dot ${field.filled ? "field-list__dot--filled" : ""}`} />
              {field.name}
            </div>
          ))
        )}
      </div>
      <button className="btn-primary" onClick={save} disabled={saving || fields.length === 0}>Save filled PDF</button>
    </>
  );
}
