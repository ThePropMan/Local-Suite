import { useEffect, useState, useCallback, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconImage,
  IconCheck,
  IconClose,
  IconEye,
  IconFolder,
  IconMapPin,
  IconCamera,
  IconScan,
  IconLock,
  IconRefresh,
  IconArrowRight,
  IconUpload,
} from "./shared/components/icons";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  pickDirectory,
  pickFiles,
  onDragDropEvent,
  isTauri,
  baseNameSync,
  formatBytes,
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  readMetadata,
  stripMetadata,
  buildOutputPath,
  type MetadataSummary,
  type StripMode,
  type StripResult,
} from "./lib/tauri";
import { VeilLogo } from "./components/VeilLogo";

interface WorkFile {
  path: string;
  name: string;
  size: number;
  metadata: MetadataSummary | null;
  loading: boolean;
  result: StripResult | null;
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "tif", "tiff"];

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<StripMode>("all");
  const [preserveCopyright, setPreserveCopyright] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "veil-recent", max: 20 });

  // Restore saved settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<string>("outputDir").then((v) => v && setOutputDir(v));
    getStoreValue<StripMode>("mode").then((v) => v && setMode(v));
  }, []);

  // Listen for supported files dropped anywhere in the app window.
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
      .catch((e) => console.error("[Veil] drag listener failed:", e));
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

  // ---- File loading ----

  const loadMetadataForFile = useCallback(async (path: string): Promise<MetadataSummary> => {
    if (!isTauri) {
      return { fields: [], has_gps: false, has_exif: false, has_xmp: false, has_iptc: false, file_size: 0, format: "unknown" };
    }
    try {
      return await readMetadata(path);
    } catch (e) {
      console.error("[loadMetadata] error:", e);
      return { fields: [], has_gps: false, has_exif: false, has_xmp: false, has_iptc: false, file_size: 0, format: "unknown" };
    }
  }, []);

  const handleFiles = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const workFiles: WorkFile[] = await Promise.all(
        paths.map(async (p) => {
          const metadata = await loadMetadataForFile(p);
          return {
            path: p,
            name: baseNameSync(p),
            size: metadata.file_size,
            metadata,
            loading: false,
            result: null,
          };
        }),
      );
      setFiles((prev) => [...prev, ...workFiles]);
      setSelectedIdx(0);
    },
    [loadMetadataForFile],
  );

  const handleBrowse = useCallback(async () => {
    const paths = await pickFiles(IMAGE_EXTENSIONS, true, [{ name: "Images", extensions: IMAGE_EXTENSIONS }]);
    if (paths.length > 0) handleFiles(paths);
  }, [handleFiles]);

  // ---- Strip ----

  const handleStrip = useCallback(async () => {
    if (!files.length || processing) return;
    setProcessing(true);
    setProgress(0);

    let totalSaved = 0;
    const results: WorkFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const outputPath = buildOutputPath(f.path, outputDir);
      try {
        const result = await stripMetadata(f.path, outputPath, {
          mode,
          preserve_copyright: preserveCopyright,
        });
        totalSaved += Math.max(0, result.input_size - result.output_size);
        results.push({ ...f, result });
        addRecent({
          name: baseNameSync(outputPath),
          path: outputPath,
          tool: "strip",
          timestamp: Date.now(),
          sizeBefore: result.input_size,
          sizeAfter: result.output_size,
        });
        if (result.message) {
          showToast(result.message, "info");
        }
      } catch (e: any) {
        console.error("[strip] error:", e);
        showToast(`Failed to strip ${f.name}: ${e.message || e}`, "error");
        results.push({
          ...f,
          result: {
            input_size: f.size,
            output_size: 0,
            ok: false,
            message: String(e),
            format: "unknown",
            had_exif: false,
            had_xmp: false,
            preserved_copyright: null,
          },
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setFiles(results);
    setProcessing(false);
    const savedStr = formatBytes(totalSaved);
    showToast(`Stripped ${files.length} ${files.length === 1 ? "file" : "files"} · saved ${savedStr}`, "success");
  }, [files, processing, outputDir, mode, preserveCopyright, addRecent]);

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
      {
        path: file.path,
        name: file.name,
        size: file.sizeBefore || 0,
        metadata: null,
        loading: true,
        result: null,
      },
    ]);
    setSelectedIdx(0);
    loadMetadataForFile(file.path).then((meta) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.path === file.path ? { ...f, metadata: meta, size: meta.file_size, loading: false } : f,
        ),
      );
    });
  }, [loadMetadataForFile]);

  const handleAddMore = useCallback(async () => {
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
        <TitleBar appName="Veil" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
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
              mode={mode}
              onModeChange={async (m) => {
                setMode(m);
                await setStoreValue("mode", m);
              }}
              preserveCopyright={preserveCopyright}
              onPreserveCopyrightChange={setPreserveCopyright}
              outputDir={outputDir}
              onPickOutputDir={handlePickOutputDir}
              onClearOutputDir={handleClearOutputDir}
              onStrip={handleStrip}
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
                  Where stripped files are saved. Falls back to next to the original with a _clean suffix.
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
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Strip mode</label>
                <div className="preset-group">
                  {(["all", "gps_only"] as StripMode[]).map((m) => (
                    <button
                      key={m}
                      className={`preset ${mode === m ? "preset--selected" : ""}`}
                      onClick={async () => {
                        setMode(m);
                        await setStoreValue("mode", m);
                      }}
                    >
                      <div className="preset__label">{m === "all" ? "All metadata" : "GPS only"}</div>
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

// Drop overlay for the home screen.

interface DropOverlayProps {
  onBrowse: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  dragging: boolean;
}

function DropOverlay({ onBrowse, recent, onOpenRecent, dragging }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <VeilLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop photos to strip metadata or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop photos to strip metadata</div>
        <div className="drop-zone__subtext">JPEG, PNG, WebP, TIFF — or pick from your files</div>
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
  mode: StripMode;
  onModeChange: (m: StripMode) => void;
  preserveCopyright: boolean;
  onPreserveCopyrightChange: (v: boolean) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onStrip: () => void;
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
    mode,
    onModeChange,
    preserveCopyright,
    onPreserveCopyrightChange,
    outputDir,
    onPickOutputDir,
    onClearOutputDir,
    onStrip,
    processing,
    progress,
    allDone,
    totalSaved,
    selected,
  } = props;

  return (
    <div className="veil-work">
      {/* Top bar */}
      <div className="veil-work__topbar">
        <div className="veil-work__topbar-left">
          <span className="veil-work__count">
            {files.length} {files.length === 1 ? "photo" : "photos"}
          </span>
        </div>
        <div className="veil-work__topbar-right">
          <button className="btn-ghost" onClick={onAddMore} disabled={processing}>
            <IconImage size={14} /> Add more
          </button>
          <button className="btn-ghost" onClick={onClearAll} disabled={processing}>
            <IconClose size={14} /> Clear all
          </button>
        </div>
      </div>

      {/* Split: file list + metadata preview */}
      <div className="veil-work__split">
        <FileList
          files={files}
          selectedIdx={selectedIdx}
          onSelect={onSelect}
          onRemove={onRemove}
        />
        <MetadataPreview file={selected} />
      </div>

      {/* Strip bar */}
      <StripBar
        mode={mode}
        onModeChange={onModeChange}
        preserveCopyright={preserveCopyright}
        onPreserveCopyrightChange={onPreserveCopyrightChange}
        outputDir={outputDir}
        onPickOutputDir={onPickOutputDir}
        onClearOutputDir={onClearOutputDir}
        onStrip={onStrip}
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
    <div className="veil-files">
      {files.map((f, i) => (
        <button
          key={f.path}
          className={`veil-file ${i === selectedIdx ? "veil-file--active" : ""} ${f.result?.ok ? "veil-file--done" : ""}`}
          onClick={() => onSelect(i)}
        >
          <FileThumb path={f.path} />
          <div className="veil-file__body">
            <span className="veil-file__name">{f.name}</span>
            <span className="veil-file__meta">
              {f.loading ? "Reading…" : f.result?.ok ? `${formatBytes(f.result.output_size)}` : formatBytes(f.size)}
            </span>
          </div>
          {f.result?.ok ? (
            <span className="veil-file__check">
              <IconCheck size={16} />
            </span>
          ) : (
            <span
              className="veil-file__remove"
              onClick={(e) => { e.stopPropagation(); onRemove(i); }}
              role="button"
              aria-label="Remove file"
            >
              <IconClose size={14} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function FileThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) {
      setSrc(convertFileSrc(path));
    }
  }, [path]);
  if (src) {
    return <img className="veil-file__thumb" src={src} alt="" onError={() => setSrc(null)} />;
  }
  return (
    <span className="veil-file__thumb-placeholder">
      <IconImage size={18} />
    </span>
  );
}

// ============================================================
// Metadata preview (right pane)
// ============================================================

function MetadataPreview({ file }: { file: WorkFile | undefined }) {
  if (!file) {
    return (
      <div className="veil-preview">
        <div className="empty-state">
          <div className="empty-state__icon">
            <IconEye size={32} />
          </div>
          <div className="empty-state__title">Select a file</div>
          <div className="empty-state__desc">Choose a photo from the list to preview its metadata.</div>
        </div>
      </div>
    );
  }

  if (file.loading) {
    return (
      <div className="veil-preview">
        <div className="empty-state">
          <div className="empty-state__icon">
            <IconScan size={32} />
          </div>
          <div className="empty-state__title">Reading metadata…</div>
        </div>
      </div>
    );
  }

  const meta = file.metadata;
  const gpsFields = meta?.fields.filter((f) => f.category === "gps") ?? [];
  const cameraFields = meta?.fields.filter((f) => f.category === "camera") ?? [];
  const exifFields = meta?.fields.filter((f) => f.category === "exif") ?? [];

  return (
    <div className="veil-preview">
      <div className="veil-preview__header">
        <PreviewThumb path={file.path} />
        <div className="veil-preview__title-block">
          <span className="veil-preview__name">{file.name}</span>
          <span className="veil-preview__sub">
            {meta?.format ? meta.format.toUpperCase() : "Unknown"} · {formatBytes(file.size)}
          </span>
          <div className="veil-preview__flags">
            {meta?.has_gps && <Flag icon={<IconMapPin size={11} />} label="GPS" danger />}
            {meta?.has_exif && <Flag icon={<IconCamera size={11} />} label="EXIF" />}
            {meta?.has_xmp && <Flag icon={<IconScan size={11} />} label="XMP" />}
            {meta?.has_iptc && <Flag icon={<IconImage size={11} />} label="IPTC" />}
            {meta && !meta.has_gps && !meta.has_exif && !meta.has_xmp && !meta.has_iptc && (
              <Flag icon={<IconCheck size={11} />} label="No metadata" success />
            )}
          </div>
        </div>
      </div>

      {file.result?.ok && (
        <ResultBox result={file.result} />
      )}

      {file.result && !file.result.ok && (
        <div className="warning-block">
          <span className="warning-block__icon">
            <IconClose size={16} />
          </span>
          <span>Failed to strip: {file.result.message}</span>
        </div>
      )}

      {gpsFields.length > 0 && (
        <MetadataGroup label="GPS" icon={<IconMapPin size={11} />} fields={gpsFields} danger />
      )}
      {cameraFields.length > 0 && (
        <MetadataGroup label="Camera" icon={<IconCamera size={11} />} fields={cameraFields} />
      )}
      {exifFields.length > 0 && (
        <MetadataGroup label="EXIF" icon={<IconScan size={11} />} fields={exifFields} />
      )}
      {gpsFields.length === 0 && cameraFields.length === 0 && exifFields.length === 0 && (
        <div className="veil-meta__empty">No metadata found in this file.</div>
      )}
    </div>
  );
}

function PreviewThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) setSrc(convertFileSrc(path));
  }, [path]);
  if (src) {
    return <img className="veil-preview__img" src={src} alt="" onError={() => setSrc(null)} />;
  }
  return (
    <span className="veil-preview__img-placeholder">
      <IconImage size={34} />
    </span>
  );
}

function Flag({ icon, label, danger, success }: { icon: React.ReactNode; label: string; danger?: boolean; success?: boolean }) {
  return (
    <span className={`veil-flag ${danger ? "veil-flag--danger" : ""} ${success ? "veil-flag--success" : ""}`}>
      {icon} {label}
    </span>
  );
}

function MetadataGroup({
  label,
  icon,
  fields,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  fields: { key: string; value: string }[];
  danger?: boolean;
}) {
  return (
    <div className="veil-meta">
      <div className="veil-meta__group-label">
        {icon} {label}
      </div>
      {fields.map((f, i) => (
        <div key={i} className={`veil-meta__row ${danger ? "veil-meta__row--gps" : ""}`}>
          <span className="veil-meta__key">{f.key}</span>
          <span className="veil-meta__val">{f.value}</span>
        </div>
      ))}
    </div>
  );
}

function ResultBox({ result }: { result: StripResult }) {
  const saved = result.input_size - result.output_size;
  return (
    <div className="result-box">
      <div className="result-box__title">
        <IconCheck size={14} /> Stripped successfully
      </div>
      <div className="result-box__row">
        <span>Before</span>
        <strong>{formatBytes(result.input_size)}</strong>
      </div>
      <div className="result-box__row">
        <span>After</span>
        <strong>{formatBytes(result.output_size)}</strong>
      </div>
      <div className="result-box__row">
        <span>Saved</span>
        <strong className="success">{formatBytes(saved)}</strong>
      </div>
      {result.preserved_copyright && (
        <div className="result-box__row">
          <span>Copyright preserved</span>
          <strong>{result.preserved_copyright}</strong>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Strip bar (bottom)
// ============================================================

interface StripBarProps {
  mode: StripMode;
  onModeChange: (m: StripMode) => void;
  preserveCopyright: boolean;
  onPreserveCopyrightChange: (v: boolean) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onStrip: () => void;
  processing: boolean;
  progress: number;
  allDone: boolean;
  totalSaved: number;
  fileCount: number;
}

function StripBar(props: StripBarProps) {
  const {
    mode,
    onModeChange,
    preserveCopyright,
    onPreserveCopyrightChange,
    outputDir,
    onPickOutputDir,
    onClearOutputDir,
    onStrip,
    processing,
    progress,
    allDone,
    totalSaved,
    fileCount,
  } = props;

  return (
    <div className="veil-stripbar">
      {processing && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="veil-stripbar__row">
        <div className="veil-stripbar__group">
          <span className="veil-stripbar__label">Mode</span>
          <div className="preset-group">
            <button
              className={`preset ${mode === "all" ? "preset--selected" : ""}`}
              onClick={() => onModeChange("all")}
              disabled={processing}
            >
              <div className="preset__label">All metadata</div>
            </button>
            <button
              className={`preset ${mode === "gps_only" ? "preset--selected" : ""}`}
              onClick={() => onModeChange("gps_only")}
              disabled={processing}
            >
              <div className="preset__label">GPS only</div>
            </button>
          </div>
        </div>

        <label className="veil-stripbar__checkbox" title="Keep the Copyright EXIF field, strip everything else">
          <input
            type="checkbox"
            checked={preserveCopyright}
            onChange={(e) => onPreserveCopyrightChange(e.target.checked)}
            disabled={processing}
          />
          <IconLock size={13} /> Preserve copyright
        </label>

        <div className="veil-stripbar__group">
          <span className="veil-stripbar__label">Output</span>
          <div className="veil-stripbar__output">
            <button className="btn-ghost" onClick={onPickOutputDir} disabled={processing}>
              <IconFolder size={14} /> {outputDir ? "Change" : "Choose folder"}
            </button>
            {outputDir && (
              <>
                <span className="veil-stripbar__output-path">{outputDir}</span>
                <button className="btn-ghost" onClick={onClearOutputDir} disabled={processing}>
                  Clear
                </button>
              </>
            )}
            {!outputDir && <span className="muted">Next to original (_clean suffix)</span>}
          </div>
        </div>

        <div className="veil-stripbar__spacer" />

        {allDone ? (
          <div className="veil-stripbar__done">
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
            onClick={onStrip}
            disabled={processing || fileCount === 0}
          >
            {processing ? "Stripping…" : `Strip ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
            {!processing && <IconArrowRight size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
