import { useEffect, useState, useCallback, useMemo } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconArrowRight,
  IconClose,
  IconDownload,
  IconFolder,
  IconImage,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconSparkle,
  IconTrash,
  IconUpload,
} from "./shared/components/icons";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  pickDirectory,
  pickFiles,
  savePath,
  onDragDropEvent,
  isTauri,
  baseNameSync,
  readFileBytes,
  writeFileBytes,
  formatBytes,
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  vectorizeFile,
  vectorizeBatch,
  PRESETS,
  presetOptions,
  DEFAULT_PRESET,
  DEFAULT_OPTIONS,
  IMAGE_EXTENSIONS,
  type PresetId,
  type VectorOptions,
  type VectorResult,
  type ColorMode,
  type PathSimplifyMode,
} from "./lib/tauri";
import { VectorLogo } from "./components/VectorLogo";

// ============================================================
// Types
// ============================================================

interface WorkFile {
  path: string;
  name: string;
  size: number;
  ext: string;
  status: "pending" | "processing" | "done" | "error";
  result?: VectorResult;
  error?: string;
}

// ============================================================
// App
// ============================================================

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET);
  const [options, setOptions] = useState<VectorOptions>(DEFAULT_OPTIONS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "vector-recent", max: 20 });

  const hasFiles = files.length > 0;
  const selected = files[selectedIdx];

  // Restore saved settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) { setTheme(t); applyTheme(t); }
    });
    getStoreValue<PresetId>("preset").then((p) => {
      if (p) {
        setPreset(p);
        setOptions(presetOptions(p));
      }
    });
    getStoreValue<VectorOptions>("options").then((o) => {
      if (o) setOptions(o);
    });
    getStoreValue<string>("outputDir").then((d) => {
      if (d) setOutputDir(d);
    });
  }, []);

  // ---- App-level drag/drop ----
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") setDragging(true);
      else if (event.type === "leave") setDragging(false);
      else if (event.type === "drop") {
        setDragging(false);
        const valid = filterByExt(event.paths);
        if (valid.length > 0) addFiles(valid);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Vector] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handlePresetChange = useCallback(async (p: PresetId) => {
    setPreset(p);
    const opts = presetOptions(p);
    setOptions(opts);
    await setStoreValue("preset", p);
  }, []);

  const handleOptionsChange = useCallback(async (next: VectorOptions) => {
    setOptions(next);
    await setStoreValue("options", next);
  }, []);

  const addFiles = useCallback(async (paths: string[]) => {
    const newFiles: WorkFile[] = [];
    for (const p of paths) {
      const ext = p.toLowerCase().split(".").pop() ?? "";
      let size = 0;
      try {
        const { fileSize } = await import("./shared/lib/tauri");
        size = await fileSize(p);
      } catch { /* ignore */ }
      newFiles.push({
        path: p,
        name: baseNameSync(p),
        size,
        ext,
        status: "pending",
      });
    }
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      const filtered = newFiles.filter((f) => !existing.has(f.path));
      return [...prev, ...filtered];
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const paths = await pickFiles(IMAGE_EXTENSIONS, true, [
      { name: "Images", extensions: IMAGE_EXTENSIONS },
    ]);
    if (paths.length > 0) await addFiles(paths);
  }, []);

  const handleOpenRecent = useCallback(async (file: RecentFile) => {
    await addFiles([file.path]);
  }, [addFiles]);

  const handleRemoveFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setSelectedIdx((prev) => (prev >= idx && prev > 0 ? prev - 1 : prev));
  }, []);

  const handleClearAll = useCallback(() => {
    setFiles([]);
    setSelectedIdx(0);
  }, []);

  const handleAddMore = useCallback(async () => {
    const paths = await pickFiles(IMAGE_EXTENSIONS, true, [
      { name: "Images", extensions: IMAGE_EXTENSIONS },
    ]);
    if (paths.length > 0) await addFiles(paths);
  }, [addFiles]);

  const handlePickOutputDir = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) {
      setOutputDir(dir);
      await setStoreValue("outputDir", dir);
    }
  }, []);

  const handleClearOutputDir = useCallback(async () => {
    setOutputDir(null);
    await setStoreValue("outputDir", null);
  }, []);

  // ---- Live preview: re-vectorize selected file when options change ----
  useEffect(() => {
    if (!selected || selected.status === "processing") return;
    if (selected.status === "done" && selected.result) return;
    // Auto-vectorize on first load
    if (selected.status === "pending") {
      void vectorizeSelected();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, files.length]);

  const vectorizeSelected = useCallback(async () => {
    if (!selected) return;
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "processing" } : f));
    try {
      const result = await vectorizeFile(selected.path, options);
      setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "done", result, error: undefined } : f));
    } catch (e: any) {
      const msg = String(e?.message || e);
      setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "error", error: msg } : f));
      showToast(`Failed: ${msg}`, "error");
    }
  }, [selected, selectedIdx, options]);

  // ---- Re-vectorize when options change (debounced) ----
  useEffect(() => {
    if (!selected || selected.status === "pending") return;
    const id = window.setTimeout(() => {
      void revectorizeSelected();
    }, 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const revectorizeSelected = useCallback(async () => {
    if (!selected) return;
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "processing" } : f));
    try {
      const result = await vectorizeFile(selected.path, options);
      setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "done", result, error: undefined } : f));
    } catch (e: any) {
      const msg = String(e?.message || e);
      setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, status: "error", error: msg } : f));
    }
  }, [selected, selectedIdx, options]);

  // ---- Batch vectorize all pending files ----
  const handleVectorizeAll = useCallback(async () => {
    const pending = files.filter((f) => f.status === "pending" || f.status === "error");
    if (pending.length === 0) {
      showToast("All files are already vectorized", "info");
      return;
    }
    setProcessing(true);
    setProgress(0);
    try {
      const paths = pending.map((f) => f.path);
      const results = await vectorizeBatch(paths, options);
      setFiles((prev) => {
        let ri = 0;
        return prev.map((f) => {
          if (f.status === "pending" || f.status === "error") {
            const r = results[ri++];
            return {
              ...f,
              status: r.ok ? "done" as const : "error" as const,
              result: r.ok ? {
                preview_png_base64: r.preview_png_base64,
                svg: r.svg,
                width: 0,
                height: 0,
                svg_bytes: r.svg_bytes,
                ok: r.ok,
                message: r.message,
              } : undefined,
              error: r.ok ? undefined : (r.message ?? "Unknown error"),
            };
          }
          return f;
        });
      });
      setProgress(100);
      showToast(`Vectorized ${results.filter((r) => r.ok).length} of ${results.length} files`, "success");
    } catch (e: any) {
      showToast(`Batch failed: ${e?.message || e}`, "error");
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }, [files, options]);

  // ---- Export SVG ----
  const handleExportSvg = useCallback(async (file: WorkFile) => {
    if (!file.result?.ok || !file.result.svg) {
      showToast("Nothing to export yet.", "info");
      return;
    }
    const baseName = file.name.replace(/\.[^.]+$/, "");
    let saveTo: string | null = null;
    if (outputDir) {
      saveTo = `${outputDir}\\${baseName}.svg`;
    } else {
      saveTo = await savePath(
        [{ name: "SVG vector", extensions: ["svg"] }],
        `${baseName}.svg`,
      );
    }
    if (!saveTo) return;
    try {
      const bytes = new TextEncoder().encode(file.result.svg);
      await writeFileBytes(saveTo, bytes);
      addRecent({ name: baseNameSync(saveTo), path: saveTo, tool: "Vector", timestamp: Date.now() });
      showToast(`Saved SVG to ${baseNameSync(saveTo)}`, "success");
    } catch (e: any) {
      showToast(`Failed to save SVG: ${e.message || e}`, "error");
    }
  }, [outputDir, addRecent]);

  // ---- Export all ----
  const handleExportAll = useCallback(async () => {
    const done = files.filter((f) => f.result?.ok && f.result.svg);
    if (done.length === 0) {
      showToast("No vectorized files to export.", "info");
      return;
    }
    if (!outputDir) {
      const dir = await pickDirectory();
      if (!dir) return;
      setOutputDir(dir);
      await setStoreValue("outputDir", dir);
      for (const file of done) {
        const baseName = file.name.replace(/\.[^.]+$/, "");
        const saveTo = `${dir}\\${baseName}.svg`;
        try {
          const bytes = new TextEncoder().encode(file.result!.svg);
          await writeFileBytes(saveTo, bytes);
        } catch (e: any) {
          showToast(`Failed: ${file.name}: ${e.message || e}`, "error");
        }
      }
    } else {
      for (const file of done) {
        const baseName = file.name.replace(/\.[^.]+$/, "");
        const saveTo = `${outputDir}\\${baseName}.svg`;
        try {
          const bytes = new TextEncoder().encode(file.result!.svg);
          await writeFileBytes(saveTo, bytes);
        } catch (e: any) {
          showToast(`Failed: ${file.name}: ${e.message || e}`, "error");
        }
      }
    }
    showToast(`Exported ${done.length} SVG files`, "success");
  }, [files, outputDir]);

  const allDone = files.length > 0 && files.every((f) => f.status === "done");
  const doneCount = files.filter((f) => f.status === "done").length;

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar
          appName="Vector"
          crumb={hasFiles ? `${doneCount}/${files.length} done` : undefined}
          showSettings={showSettings}
          onToggleSettings={() => setShowSettings((s) => !s)}
        />
        <div className="stage">
          {!hasFiles ? (
            <DropOverlay
              onBrowse={handleBrowse}
              recent={recent}
              onOpenRecent={handleOpenRecent}
              dragging={dragging}
            />
          ) : (
            <WorkingView
              files={files}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
              onRemove={handleRemoveFile}
              onClearAll={handleClearAll}
              onAddMore={handleAddMore}
              preset={preset}
              onPresetChange={handlePresetChange}
              options={options}
              onOptionsChange={handleOptionsChange}
              advancedOpen={advancedOpen}
              onToggleAdvanced={setAdvancedOpen}
              outputDir={outputDir}
              onPickOutputDir={handlePickOutputDir}
              onClearOutputDir={handleClearOutputDir}
              onVectorizeAll={handleVectorizeAll}
              onExportSvg={handleExportSvg}
              onExportAll={handleExportAll}
              processing={processing}
              progress={progress}
              allDone={allDone}
              showOriginal={showOriginal}
              onToggleShowOriginal={setShowOriginal}
              onRevectorize={revectorizeSelected}
            />
          )}
          {showSettings && (
            <SettingsOverlay
              theme={theme}
              onThemeChange={handleThemeChange}
              outputDir={outputDir}
              onPickOutputDir={handlePickOutputDir}
              onClearOutputDir={handleClearOutputDir}
              recentCount={recent.length}
              onClearRecent={clearRecent}
              onClose={() => setShowSettings(false)}
            />
          )}
        </div>
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

function filterByExt(paths: string[]): string[] {
  const exts = new Set(IMAGE_EXTENSIONS);
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0) return false;
    return exts.has(lower.slice(dot + 1));
  });
}

// ============================================================
// Drop overlay (home screen)
// ============================================================

interface DropOverlayProps {
  onBrowse: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  dragging: boolean;
}

function DropOverlay({ onBrowse, recent, onOpenRecent, dragging }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <VectorLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop images to vectorize or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop images to vectorize</div>
        <div className="drop-zone__subtext">PNG, JPG, BMP, WebP — or pick from your files</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
          Browse files
        </button>
      </div>
      <div className="drop-overlay__presets-hint">
        <IconSparkle size={13} /> Presets: Logo, Icon, Photo, Line art, Pixel art
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconImage size={14} />
                <span className="recent-list__name">{file.name}</span>
                <span className="recent-list__meta">{file.tool}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Working view
// ============================================================

interface WorkingViewProps {
  files: WorkFile[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  preset: PresetId;
  onPresetChange: (p: PresetId) => void;
  options: VectorOptions;
  onOptionsChange: (o: VectorOptions) => void;
  advancedOpen: boolean;
  onToggleAdvanced: (b: boolean) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onVectorizeAll: () => void;
  onExportSvg: (f: WorkFile) => void;
  onExportAll: () => void;
  processing: boolean;
  progress: number;
  allDone: boolean;
  showOriginal: boolean;
  onToggleShowOriginal: (b: boolean) => void;
  onRevectorize: () => void;
}

function WorkingView(props: WorkingViewProps) {
  const {
    files, selectedIdx, onSelect, onRemove, onClearAll, onAddMore,
    preset, onPresetChange, options, onOptionsChange,
    advancedOpen, onToggleAdvanced,
    outputDir, onPickOutputDir, onClearOutputDir,
    onVectorizeAll, onExportSvg, onExportAll,
    processing, progress, allDone,
    showOriginal, onToggleShowOriginal, onRevectorize,
  } = props;

  const selected = files[selectedIdx];

  return (
    <div className="vector-work">
      {/* ---- File list (left) ---- */}
      <div className="vector-files">
        <div className="vector-files__head">
          <span className="eyebrow">Files ({files.length})</span>
          <button className="btn-ghost" onClick={onAddMore} aria-label="Add more files">
            <IconPlus size={13} />
          </button>
        </div>
        <div className="vector-files__list">
          {files.map((file, i) => (
            <FileListItem
              key={i}
              file={file}
              selected={i === selectedIdx}
              onSelect={() => onSelect(i)}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
        <button className="btn-ghost vector-files__clear" onClick={onClearAll}>
          <IconTrash size={12} /> Clear all
        </button>
      </div>

      {/* ---- Preview (center) ---- */}
      <div className="vector-preview-area">
        {selected && (
          <PreviewPane
            file={selected}
            showOriginal={showOriginal}
            onToggleShowOriginal={onToggleShowOriginal}
            onExportSvg={() => onExportSvg(selected)}
            onRevectorize={onRevectorize}
          />
        )}
      </div>

      {/* ---- Controls (right) ---- */}
      <div className="vector-controls">
        <div className="vector-controls__section">
          <div className="vector-controls__label">Preset</div>
          <div className="vector-btn-row vector-presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`vector-btn-chip ${preset === p.id ? "vector-btn-chip--selected" : ""}`}
                onClick={() => onPresetChange(p.id)}
                disabled={processing}
              >
                {p.label}
                <div className="preset__desc">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="vector-controls__section">
          <div className="vector-controls__label">Color mode</div>
          <div className="vector-btn-row">
            <button
              className={`vector-btn-chip ${options.color_mode === "color" ? "vector-btn-chip--selected" : ""}`}
              onClick={() => onOptionsChange({ ...options, color_mode: "color" as ColorMode })}
              disabled={processing}
            >
              Color
            </button>
            <button
              className={`vector-btn-chip ${options.color_mode === "binary" ? "vector-btn-chip--selected" : ""}`}
              onClick={() => onOptionsChange({ ...options, color_mode: "binary" as ColorMode })}
              disabled={processing}
            >
              B&amp;W
            </button>
          </div>
        </div>

        <div className="vector-controls__section">
          <button
            className="vector-advanced__toggle"
            onClick={() => onToggleAdvanced(!advancedOpen)}
            aria-expanded={advancedOpen}
          >
            <span className="eyebrow">Advanced controls</span>
            <IconArrowRight
              size={12}
              style={{ transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 140ms" }}
            />
          </button>
          {advancedOpen && (
            <AdvancedControls options={options} onOptionsChange={onOptionsChange} disabled={processing} />
          )}
        </div>

        <ExportBar
          outputDir={outputDir}
          onPickOutputDir={onPickOutputDir}
          onClearOutputDir={onClearOutputDir}
          onVectorizeAll={onVectorizeAll}
          onExportAll={onExportAll}
          processing={processing}
          progress={progress}
          allDone={allDone}
          fileCount={files.length}
          doneCount={files.filter((f) => f.status === "done").length}
        />
      </div>
    </div>
  );
}

// ============================================================
// File list item
// ============================================================

function FileListItem({
  file,
  selected,
  onSelect,
  onRemove,
}: {
  file: WorkFile;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={`file-list__item ${selected ? "file-list__item--selected" : ""} ${file.status === "done" ? "file-list__item--done" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(); }}
    >
      <div className="file-list__thumb">
        {file.result?.svg ? (
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.result.svg)}`} alt="" />
        ) : (
          <IconImage size={18} />
        )}
      </div>
      <div className="file-list__body">
        <span className="file-list__name">{file.name}</span>
        <span className={`file-list__meta ${
          file.status === "error" ? "file-list__meta--danger" :
          file.status === "done" ? "file-list__meta--success" : ""
        }`}>
          {file.status === "processing" && "Vectorizing…"}
          {file.status === "pending" && `${formatBytes(file.size)}`}
          {file.status === "done" && file.result && `${formatBytes(file.size)} → ${formatBytes(file.result.svg_bytes)}`}
          {file.status === "error" && (file.error ?? "Error")}
        </span>
      </div>
      <button
        className="file-list__remove"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        aria-label="Remove file"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}

// ============================================================
// Preview pane
// ============================================================

function PreviewPane({
  file,
  showOriginal,
  onToggleShowOriginal,
  onExportSvg,
  onRevectorize,
}: {
  file: WorkFile;
  showOriginal: boolean;
  onToggleShowOriginal: (b: boolean) => void;
  onExportSvg: () => void;
  onRevectorize: () => void;
}) {
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);

  // Load the original image for the "show original" toggle.
  useEffect(() => {
    let cancelled = false;
    if (showOriginal && !originalSrc) {
      readFileBytes(file.path).then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes], { type: `image/${file.ext || "png"}` });
        const url = URL.createObjectURL(blob);
        setOriginalSrc(url);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [showOriginal, originalSrc, file.path, file.ext]);

  // Clean up object URL
  useEffect(() => {
    return () => { if (originalSrc) URL.revokeObjectURL(originalSrc); };
  }, [originalSrc]);

  const svgDataUrl = useMemo(() => {
    if (!file.result?.svg) return null;
    const encoded = encodeURIComponent(file.result.svg);
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
  }, [file.result?.svg]);

  return (
    <div className="vector-preview">
      <div className="vector-preview__head">
        <div className="vector-preview__title">
          <IconImage size={14} /> {file.name}
        </div>
        <div className="vector-preview__actions">
          <button
            className={`btn-ghost ${showOriginal ? "" : "btn-ghost--active"}`}
            onClick={() => onToggleShowOriginal(false)}
          >
            <IconLayers size={13} /> Vector
          </button>
          <button
            className={`btn-ghost ${showOriginal ? "btn-ghost--active" : ""}`}
            onClick={() => onToggleShowOriginal(true)}
          >
            <IconImage size={13} /> Original
          </button>
          <button className="btn-ghost" onClick={onRevectorize} title="Re-vectorize">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>
      <div className="vector-preview__canvas">
        {file.status === "processing" && (
          <div className="vector-preview__loading">
            <IconRefresh size={32} />
            <span>Vectorizing…</span>
          </div>
        )}
        {file.status === "error" && (
          <div className="vector-preview__error">
            <span>{file.error}</span>
            <button className="btn-ghost" onClick={onRevectorize}>Retry</button>
          </div>
        )}
        {file.status === "done" && file.result && (
          showOriginal && originalSrc ? (
            <img src={originalSrc} alt="Original" className="vector-preview__img" />
          ) : svgDataUrl ? (
            <img src={svgDataUrl} alt="Vectorized" className="vector-preview__svg" />
          ) : null
        )}
        {file.status === "pending" && (
          <div className="vector-preview__loading">
            <IconImage size={32} />
            <span>Loading…</span>
          </div>
        )}
      </div>
      {file.status === "done" && file.result?.ok && (
        <div className="vector-preview__meta">
          <span><strong>{file.result.width || "?"}</strong> × <strong>{file.result.height || "?"}</strong> px</span>
          <span>SVG: <strong>{formatBytes(file.result.svg_bytes)}</strong></span>
          <button className="btn btn--primary btn--sm" onClick={onExportSvg}>
            <IconDownload size={13} /> Export SVG
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Advanced controls
// ============================================================

function AdvancedControls({
  options,
  onOptionsChange,
  disabled,
}: {
  options: VectorOptions;
  onOptionsChange: (o: VectorOptions) => void;
  disabled: boolean;
}) {
  const update = useCallback((patch: Partial<VectorOptions>) => {
    onOptionsChange({ ...options, ...patch });
  }, [options, onOptionsChange]);

  return (
    <div className="vector-advanced">
      <Slider
        label="Color precision"
        value={options.color_precision}
        min={1}
        max={8}
        step={1}
        disabled={disabled}
        onChange={(v) => update({ color_precision: v })}
      />
      <Slider
        label="Layer difference"
        value={options.layer_difference}
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        onChange={(v) => update({ layer_difference: v })}
      />
      <Slider
        label="Filter speckle"
        value={options.filter_speckle}
        min={1}
        max={20}
        step={1}
        disabled={disabled}
        onChange={(v) => update({ filter_speckle: v })}
      />
      <Slider
        label="Corner threshold"
        value={options.corner_threshold}
        min={0}
        max={180}
        step={1}
        disabled={disabled}
        onChange={(v) => update({ corner_threshold: v })}
      />
      <Slider
        label="Length threshold"
        value={options.length_threshold}
        min={1}
        max={20}
        step={0.5}
        disabled={disabled}
        onChange={(v) => update({ length_threshold: v })}
      />
      <Slider
        label="Splice threshold"
        value={options.splice_threshold}
        min={0}
        max={90}
        step={1}
        disabled={disabled}
        onChange={(v) => update({ splice_threshold: v })}
      />
      <div className="vector-advanced__row">
        <label className="vector-advanced__label">Curve fitting</label>
        <div className="vector-btn-row">
          {(["spline", "polygon", "none"] as PathSimplifyMode[]).map((m) => (
            <button
              key={m}
              className={`vector-btn-chip ${options.mode === m ? "vector-btn-chip--selected" : ""}`}
              onClick={() => update({ mode: m })}
              disabled={disabled}
            >
              {m === "spline" ? "Spline" : m === "polygon" ? "Polygon" : "None"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="vector-advanced__row">
      <label className="vector-advanced__label">
        {label}
        <span className="vector-advanced__value">{value}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

// ============================================================
// Export bar
// ============================================================

function ExportBar({
  outputDir,
  onPickOutputDir,
  onClearOutputDir,
  onVectorizeAll,
  onExportAll,
  processing,
  progress,
  allDone,
  fileCount,
  doneCount,
}: {
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onVectorizeAll: () => void;
  onExportAll: () => void;
  processing: boolean;
  progress: number;
  allDone: boolean;
  fileCount: number;
  doneCount: number;
}) {
  return (
    <div className="vector-exportbar">
      {processing && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="vector-exportbar__output">
        <span className="eyebrow">Output folder</span>
        <div className="vector-exportbar__output-row">
          <button className="btn-ghost" onClick={onPickOutputDir} disabled={processing}>
            <IconFolder size={13} /> {outputDir ? "Change" : "Choose"}
          </button>
          {outputDir && (
            <>
              <span className="vector-exportbar__path">{outputDir}</span>
              <button className="btn-ghost" onClick={onClearOutputDir} disabled={processing}>Clear</button>
            </>
          )}
          {!outputDir && <span className="muted">Ask each time</span>}
        </div>
      </div>
      <div className="vector-exportbar__buttons">
        {!allDone ? (
          <button className="btn btn--primary" onClick={onVectorizeAll} disabled={processing}>
            <IconSparkle size={14} /> {processing ? "Processing…" : `Vectorize all (${fileCount - doneCount})`}
          </button>
        ) : (
          <button className="btn btn--primary" onClick={onExportAll}>
            <IconDownload size={14} /> Export all SVG ({doneCount})
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Settings overlay
// ============================================================

function SettingsOverlay({
  theme,
  onThemeChange,
  outputDir,
  onPickOutputDir,
  onClearOutputDir,
  recentCount,
  onClearRecent,
  onClose,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  recentCount: number;
  onClearRecent: () => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-overlay__panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-overlay__head">
          <span>Settings</span>
          <button className="titlebar__icon-btn" onClick={onClose} aria-label="Close settings">
            <IconClose size={14} />
          </button>
        </div>
        <div className="settings-overlay__body">
          <div className="settings-overlay__section">
            <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Theme</label>
            <div className="vector-btn-row">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={`vector-btn-chip ${theme === t ? "vector-btn-chip--selected" : ""}`}
                  onClick={() => onThemeChange(t)}
                >
                  {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-overlay__section">
            <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Default output folder</label>
            <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
              Where SVG files are saved. Falls back to asking each time.
            </p>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="btn-ghost" onClick={onPickOutputDir}>Choose</button>
              {outputDir && (
                <>
                  <span style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{outputDir}</span>
                  <button className="btn-ghost" onClick={onClearOutputDir}>Clear</button>
                </>
              )}
            </div>
          </div>
          {recentCount > 0 && (
            <div className="settings-overlay__section">
              <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Recent files ({recentCount})</label>
              <button className="btn-ghost" onClick={onClearRecent}>Clear recent</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
