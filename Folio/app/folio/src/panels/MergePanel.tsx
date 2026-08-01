import { useState, useCallback, useEffect } from "react";
import { PDFDocument } from "pdf-lib";
import { showToast } from "../shared/components/Toast";
import { readFileBytes, writeFileBytes, getStoreValue, savePdfPath, fileSize, pickPdfFiles, type RecentFile } from "../lib/tauri";
import { mergePdfs, type MergeFile } from "../tools/merge/merge";

interface MergePanelProps {
  filePath: string | null;
  onRecent: (file: RecentFile) => void;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MergePanel({ filePath, onRecent }: MergePanelProps) {
  const [files, setFiles] = useState<MergeFile[]>([]);

  const addFiles = useCallback(async (paths: string[]) => {
    const loaded: MergeFile[] = [];
    for (const path of paths) {
      try {
        const bytes = await readFileBytes(path);
        await PDFDocument.load(bytes);
        loaded.push({ path, name: path.split(/[\\/]/).pop() || path, bytes });
      } catch {
        showToast(`Couldn't read ${path.split(/[\\/]/).pop()}`, "error");
      }
    }
    setFiles((prev) => [...prev, ...loaded]);
  }, []);

  // Load the currently-open file's real bytes on mount, instead of seeding
  // the list with an empty placeholder (which broke merges that included it).
  useEffect(() => {
    if (filePath) addFiles([filePath]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const browse = async () => {
    const paths = await pickPdfFiles(true);
    if (paths.length) addFiles(paths);
  };

  const run = async () => {
    if (files.length < 2) return;
    try {
      const mergedBytes = await mergePdfs(files);
      const outputFolder = (await getStoreValue<string>("outputFolder")) || files[0].path.substring(0, files[0].path.lastIndexOf("\\"));
      const timestamp = Date.now();
      const defaultPath = `${outputFolder}\\merged_${timestamp}.pdf`;
      const outputPath = (await savePdfPath(defaultPath)) || defaultPath;
      await writeFileBytes(outputPath, mergedBytes);
      const size = await fileSize(outputPath);
      showToast(`Merged ${files.length} PDFs · ${formatSize(size)}`, "success");
      onRecent({ name: `merged_${timestamp}.pdf`, path: outputPath, tool: "merge", timestamp, sizeBefore: files.reduce((a, f) => a + f.bytes.length, 0), sizeAfter: size });
    } catch (e: any) {
      showToast(e.message || "Merge failed", "error");
    }
  };

  return (
    <>
      <div className="file-list">
        {files.map((file, i) => (
          <div key={i} className="file-list__item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--text-3)", flexShrink: 0 }} aria-hidden="true">
              <path d="M14 3v4a1 1 0 001 1h4M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5z" />
            </svg>
            <span className="file-list__name">{file.name}</span>
            <button className="file-list__remove" aria-label={`Remove ${file.name}`} onClick={() => removeFile(i)}>×</button>
          </div>
        ))}
      </div>
      <button className="btn-ghost" onClick={browse}>Add more files</button>
      <button className="btn-primary" onClick={run} disabled={files.length < 2}>
        Merge {files.length > 0 ? `${files.length} PDF${files.length === 1 ? "" : "s"}` : "PDFs"}
      </button>
    </>
  );
}
