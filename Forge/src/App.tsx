import { useEffect, useState, useCallback, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconImage,
  IconCheck,
  IconClose,
  IconFolder,
  IconRefresh,
  IconArrowRight,
  IconUpload,
  IconLock,
} from "./shared/components/icons";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  pickDirectory,
  onDragDropEvent,
  isTauri,
  baseNameSync,
  formatBytes,
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  convertImage,
  buildOutputPath,
  FORMATS,
  formatDef,
  RESIZE_PRESETS,
  DEFAULT_OPTIONS,
  IMAGE_EXTENSIONS,
  type OutputFormat,
  type ConvertOptions,
  type ConvertResult,
  type ResizeModeTag,
  type ResizePresetId,
} from "./lib/tauri";
import { ForgeLogo } from "./components/ForgeLogo";

interface WorkFile {
  path: string;
  name: string;
  size: number;
  result: ConvertResult | null;
  loading: boolean;
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "forge-recent", max: 20 });

  // Load persisted settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<string>("outputDir").then((v) => v && setOutputDir(v));
    getStoreValue<ConvertOptions>("options").then((o) => o && setOptions({ ...DEFAULT_OPTIONS, ...o }));
  }, []);

  // App-level drag-drop listener.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") setDragging(true);
      else if (event.type === "leave") setDragging(false);
      else if (event.type === "drop") {
        setDragging(false);
        const paths = filterByExt(event.paths);
        if (paths.length > 0) handleFiles(paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Forge] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

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

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const updateOptions = useCallback(async (patch: Partial<ConvertOptions>) => {
    setOptions((prev) => {
      const next = { ...prev, ...patch };
      void setStoreValue("options", next);
      return next;
    });
  }, []);

  // ---- File loading ----

  const handleFiles = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const workFiles: WorkFile[] = paths.map((p) => ({
      path: p,
      name: baseNameSync(p),
      size: 0,
      result: null,
      loading: true,
    }));
    setFiles((prev) => [...prev, ...workFiles]);
    setSelectedIdx(0);
    // Resolve sizes asynchronously.
    workFiles.forEach(async (wf) => {
      try {
        const { fileSize } = await import("./shared/lib/tauri");
        const sz = await fileSize(wf.path);
        setFiles((prev) => prev.map((f) => (f.path === wf.path ? { ...f, size: sz, loading: false } : f)));
      } catch {
        setFiles((prev) => prev.map((f) => (f.path === wf.path ? { ...f, loading: false } : f)));
      }
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const { pickFiles } = await import("./shared/lib/tauri");
    const paths = await pickFiles(IMAGE_EXTENSIONS, true, [{ name: "Images", extensions: IMAGE_EXTENSIONS }]);
    if (paths.length > 0) handleFiles(paths);
  }, [handleFiles]);

  // ---- Convert ----

  const handleConvert = useCallback(async () => {
    if (!files.length || processing) return;
    setProcessing(true);
    setProgress(0);

    let totalSaved = 0;
    const results: WorkFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const outputPath = buildOutputPath(f.path, outputDir, options.format);
      try {
        const result = await convertImage(f.path, outputPath, options);
        totalSaved += Math.max(0, result.input_size - result.output_size);
        results.push({ ...f, result, size: result.input_size || f.size, loading: false });
        addRecent({
          name: baseNameSync(outputPath),
          path: outputPath,
          tool: `→ ${formatDef(options.format).label}`,
          timestamp: Date.now(),
          sizeBefore: result.input_size,
          sizeAfter: result.output_size,
        });
        if (result.message) showToast(result.message, "info");
      } catch (e: any) {
        console.error("[convert] error:", e);
        showToast(`Failed to convert ${f.name}: ${e.message || e}`, "error");
        results.push({
          ...f,
          loading: false,
          result: {
            input_size: f.size,
            output_size: 0,
            ok: false,
            message: String(e),
            output_path: outputPath,
            format: "unknown",
            width: 0,
            height: 0,
          },
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setFiles(results);
    setProcessing(false);
    const savedStr = formatBytes(totalSaved);
    showToast(`Converted ${files.length} ${files.length === 1 ? "file" : "files"} · saved ${savedStr}`, "success");
  }, [files, processing, outputDir, options, addRecent]);

  const handleRemoveFile = useCallback((idx: number) => {
    setFiles((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (selectedIdx >= next.length) setSelectedIdx(Math.max(0, next.length - 1));
      return next;
    });
  }, [selectedIdx]);

  const handleClearAll = useCallback(() => {
    setFiles([]);
    setSelectedIdx(0);
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    setFiles([
      { path: file.path, name: file.name, size: file.sizeBefore || 0, result: null, loading: true },
    ]);
    setSelectedIdx(0);
    (async () => {
      try {
        const { fileSize } = await import("./shared/lib/tauri");
        const sz = await fileSize(file.path);
        setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, size: sz, loading: false } : f)));
      } catch {
        setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, loading: false } : f)));
      }
    })();
  }, []);

  const handleAddMore = useCallback(async () => {
    const { pickFiles } = await import("./shared/lib/tauri");
    const paths = await pickFiles(IMAGE_EXTENSIONS, true, [{ name: "Images", extensions: IMAGE_EXTENSIONS }]);
    if (paths.length > 0) handleFiles(paths);
  }, [handleFiles]);

  // ---- Derived ----

  const hasFiles = files.length > 0;
  const selected = files[selectedIdx];
  const allDone = hasFiles && files.every((f) => f.result?.ok);
  const totalSaved = useMemo(
    () => files.reduce((sum, f) => sum + Math.max(0, (f.result?.input_size || 0) - (f.result?.output_size || 0)), 0),
    [files],
  );

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar appName="Forge" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
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
              options={options}
              onUpdateOptions={updateOptions}
              outputDir={outputDir}
              onPickOutputDir={handlePickOutputDir}
              onClearOutputDir={handleClearOutputDir}
              onConvert={handleConvert}
              processing={processing}
              progress={progress}
              allDone={allDone}
              totalSaved={totalSaved}
              selected={selected}
            />
          )}
          {showSettings && (
            <div className="settings-overlay">
              <div className="tool-panel__header">Settings</div>
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Default output folder</label>
                <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
                  Where converted files are saved. Falls back to next to the original.
                </p>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button className="btn-ghost" onClick={handlePickOutputDir}>Choose</button>
                  {outputDir && (
                    <>
                      <span style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{outputDir}</span>
                      <button className="btn-ghost" onClick={handleClearOutputDir}>Clear</button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Theme</label>
                <div className="preset-group">
                  {(["system", "light", "dark"] as Theme[]).map((t) => (
                    <button
                      key={t}
                      className={`preset ${theme === t ? "preset--selected" : ""}`}
                      onClick={() => handleThemeChange(t)}
                    >
                      <div className="preset__label">{t === "system" ? "System" : t === "light" ? "Light" : "Dark"}</div>
                    </button>
                  ))}
                </div>
              </div>
              {recent.length > 0 && (
                <div>
                  <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Recent files</label>
                  <button className="btn-ghost" onClick={clearRecent}>Clear recent</button>
                </div>
              )}
            </div>
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
      <ForgeLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop images to convert or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop images to convert</div>
        <div className="drop-zone__subtext">JPEG, PNG, WebP, TIFF, BMP, GIF — or pick from your files</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
          Browse files
        </button>
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconImage size={14} />
                <span className="recent-list__name">{file.name}</span>
                <span className="recent-list__meta">
                  {file.sizeBefore && file.sizeAfter
                    ? `${formatBytes(file.sizeBefore)} → ${formatBytes(file.sizeAfter)}`
                    : file.tool}
                </span>
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
  options: ConvertOptions;
  onUpdateOptions: (patch: Partial<ConvertOptions>) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onConvert: () => void;
  processing: boolean;
  progress: number;
  allDone: boolean;
  totalSaved: number;
  selected: WorkFile | undefined;
}

function WorkingView(props: WorkingViewProps) {
  const {
    files,
    selectedIdx,
    onSelect,
    onRemove,
    onClearAll,
    onAddMore,
    options,
    onUpdateOptions,
    outputDir,
    onPickOutputDir,
    onClearOutputDir,
    onConvert,
    processing,
    progress,
    allDone,
    totalSaved,
    selected,
  } = props;

  return (
    <div className="forge-work">
      <div className="forge-work__topbar">
        <div className="forge-work__topbar-left">
          <span className="forge-work__count">
            {files.length} {files.length === 1 ? "image" : "images"}
          </span>
        </div>
        <div className="forge-work__topbar-right">
          <button className="btn-ghost" onClick={onAddMore} disabled={processing}>
            <IconImage size={14} /> Add more
          </button>
          <button className="btn-ghost" onClick={onClearAll} disabled={processing}>
            <IconClose size={14} /> Clear all
          </button>
        </div>
      </div>

      <div className="forge-work__split">
        <FileList
          files={files}
          selectedIdx={selectedIdx}
          onSelect={onSelect}
          onRemove={onRemove}
        />
        <SettingsPanel
          options={options}
          onUpdateOptions={onUpdateOptions}
          selected={selected}
          processing={processing}
        />
      </div>

      <ConvertBar
        outputDir={outputDir}
        onPickOutputDir={onPickOutputDir}
        onClearOutputDir={onClearOutputDir}
        onConvert={onConvert}
        processing={processing}
        progress={progress}
        allDone={allDone}
        totalSaved={totalSaved}
        fileCount={files.length}
      />
    </div>
  );
}

// ============================================================
// File list (left pane)
// ============================================================

interface FileListProps {
  files: WorkFile[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
}

function FileList({ files, selectedIdx, onSelect, onRemove }: FileListProps) {
  return (
    <div className="forge-files">
      {files.map((f, i) => (
        <div
          key={i}
          className={`forge-file ${i === selectedIdx ? "forge-file--active" : ""} ${f.result?.ok ? "forge-file--done" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}
        >
          <FileThumb path={f.path} />
          <div className="forge-file__body">
            <span className="forge-file__name">{f.name}</span>
            <span className="forge-file__meta">
              {f.loading ? "Reading…" : f.result?.ok
                ? `${formatBytes(f.result.input_size)} → ${formatBytes(f.result.output_size)}`
                : f.size > 0 ? formatBytes(f.size) : ""}
            </span>
            {f.result && !f.result.ok && (
              <span className="forge-file__error">Failed</span>
            )}
          </div>
          {f.result?.ok ? (
            <span className="forge-file__check">
              <IconCheck size={16} />
            </span>
          ) : (
            <span
              className="forge-file__remove"
              onClick={(e) => { e.stopPropagation(); onRemove(i); }}
              role="button"
              aria-label="Remove file"
            >
              <IconClose size={14} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function FileThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) setSrc(convertFileSrc(path));
  }, [path]);
  if (src) {
    return <img className="forge-file__thumb" src={src} alt="" onError={() => setSrc(null)} />;
  }
  return (
    <span className="forge-file__thumb-placeholder">
      <IconImage size={18} />
    </span>
  );
}

// ============================================================
// Settings panel (right pane)
// ============================================================

interface SettingsPanelProps {
  options: ConvertOptions;
  onUpdateOptions: (patch: Partial<ConvertOptions>) => void;
  selected: WorkFile | undefined;
  processing: boolean;
}

function SettingsPanel({ options, onUpdateOptions, selected, processing }: SettingsPanelProps) {
  const currentFormat = formatDef(options.format);
  return (
    <div className="forge-settings">
      {/* Selected file preview */}
      {selected && (
        <div className="forge-settings__preview">
          <PreviewThumb path={selected.path} />
          <div className="forge-settings__preview-info">
            <span className="forge-settings__preview-name">{selected.name}</span>
            <span className="forge-settings__preview-meta">
              {selected.loading ? "Reading…" : formatBytes(selected.size)}
              {selected.result?.ok && ` · ${selected.result.width}×${selected.result.height}`}
            </span>
            {selected.result?.ok && (
              <span className="forge-settings__preview-result">
                <IconCheck size={11} /> {formatBytes(selected.result.output_size)}
              </span>
            )}
            {selected.result && !selected.result.ok && (
              <span className="forge-settings__preview-error">{selected.result.message}</span>
            )}
          </div>
        </div>
      )}

      {/* Format picker */}
      <div className="forge-section">
        <div className="forge-section__label">Output format</div>
        <div className="forge-formats">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`forge-format ${options.format === f.id ? "forge-format--selected" : ""}`}
              onClick={() => onUpdateOptions({ format: f.id as OutputFormat })}
              disabled={processing}
              title={f.desc}
            >
              <span className="forge-format__label">{f.label}</span>
              <span className="forge-format__desc">{f.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Quality slider (lossy only) */}
      {currentFormat.lossy && (
        <div className="forge-section">
          <div className="forge-section__label">
            Quality <span className="forge-section__value">{options.quality}</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={options.quality}
            onChange={(e) => onUpdateOptions({ quality: Number(e.target.value) })}
            disabled={processing}
            className="forge-slider"
          />
          <div className="forge-slider__scale">
            <span>Smaller file</span>
            <span>Higher quality</span>
          </div>
        </div>
      )}

      {/* Resize controls */}
      <div className="forge-section">
        <div className="forge-section__label">Resize</div>
        <div className="forge-btn-row">
          {(["none", "percent", "exact", "preset"] as ResizeModeTag[]).map((m) => (
            <button
              key={m}
              className={`forge-btn-chip ${options.resize === m ? "forge-btn-chip--selected" : ""}`}
              onClick={() => onUpdateOptions({ resize: m })}
              disabled={processing}
            >
              {m === "none" ? "None" : m === "percent" ? "Percent" : m === "exact" ? "Exact" : "Preset"}
            </button>
          ))}
        </div>

        {options.resize === "percent" && (
          <div className="forge-subcontrol">
            <div className="forge-subcontrol__row">
              <input
                type="number"
                min={1}
                max={100}
                value={options.resize_percent ?? 50}
                onChange={(e) => onUpdateOptions({ resize_percent: Math.max(1, Math.min(100, Number(e.target.value))) })}
                disabled={processing}
                className="input forge-input--sm"
              />
              <span className="forge-subcontrol__unit">% of original</span>
            </div>
          </div>
        )}

        {options.resize === "exact" && (
          <div className="forge-dual-input">
            <label>
              <span>Width</span>
              <input
                type="number"
                min={1}
                value={options.resize_width ?? 1920}
                onChange={(e) => onUpdateOptions({ resize_width: Math.max(1, Number(e.target.value)) })}
                disabled={processing}
              />
            </label>
            <label>
              <span>Height</span>
              <input
                type="number"
                min={1}
                value={options.resize_height ?? 1080}
                onChange={(e) => onUpdateOptions({ resize_height: Math.max(1, Number(e.target.value)) })}
                disabled={processing}
              />
            </label>
          </div>
        )}

        {options.resize === "preset" && (
          <div className="forge-presets">
            {RESIZE_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`forge-preset ${options.resize_preset === p.id ? "forge-preset--selected" : ""}`}
                onClick={() => onUpdateOptions({ resize_preset: p.id as ResizePresetId })}
                disabled={processing}
              >
                <span className="forge-preset__label">{p.label}</span>
                <span className="forge-preset__desc">{p.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Strip metadata */}
      <div className="forge-section">
        <label className="forge-checkbox" title="Drop EXIF, GPS, IPTC, XMP metadata (pairs with Veil)">
          <input
            type="checkbox"
            checked={options.strip_metadata}
            onChange={(e) => onUpdateOptions({ strip_metadata: e.target.checked })}
            disabled={processing}
          />
          <IconLock size={13} /> Strip metadata
          <span className="forge-checkbox__hint">— removes EXIF, GPS, camera info</span>
        </label>
      </div>
    </div>
  );
}

function PreviewThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) setSrc(convertFileSrc(path));
  }, [path]);
  if (src) {
    return <img className="forge-settings__preview-img" src={src} alt="" onError={() => setSrc(null)} />;
  }
  return (
    <span className="forge-settings__preview-placeholder">
      <IconImage size={34} />
    </span>
  );
}

// ============================================================
// Convert bar (bottom)
// ============================================================

interface ConvertBarProps {
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onConvert: () => void;
  processing: boolean;
  progress: number;
  allDone: boolean;
  totalSaved: number;
  fileCount: number;
}

function ConvertBar(props: ConvertBarProps) {
  const {
    outputDir,
    onPickOutputDir,
    onClearOutputDir,
    onConvert,
    processing,
    progress,
    allDone,
    totalSaved,
    fileCount,
  } = props;

  return (
    <div className="forge-convertbar">
      {processing && (
        <div className="forge-progress">
          <div className="forge-progress__bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="forge-convertbar__row">
        <div className="forge-convertbar__group">
          <span className="forge-convertbar__label">Output</span>
          <div className="forge-convertbar__output">
            <button className="btn-ghost" onClick={onPickOutputDir} disabled={processing}>
              <IconFolder size={14} /> {outputDir ? "Change" : "Choose folder"}
            </button>
            {outputDir && (
              <>
                <span className="forge-convertbar__output-path">{outputDir}</span>
                <button className="btn-ghost" onClick={onClearOutputDir} disabled={processing}>
                  Clear
                </button>
              </>
            )}
            {!outputDir && <span className="muted">Next to original</span>}
          </div>
        </div>

        <div className="forge-convertbar__spacer" />

        {allDone ? (
          <div className="forge-convertbar__done">
            <span className="success">
              <IconCheck size={14} /> Saved {formatBytes(totalSaved)}
            </span>
            <button className="btn-ghost" onClick={() => window.location.reload()}>
              <IconRefresh size={14} /> Start over
            </button>
          </div>
        ) : (
          <button
            className="btn btn--primary"
            onClick={onConvert}
            disabled={processing || fileCount === 0}
          >
            {processing ? "Converting…" : `Convert ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
            {!processing && <IconArrowRight size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
