import { useEffect, useState, useCallback } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconFile,
  IconUpload,
  IconInfo,
  IconClose,
  IconCheck,
  IconArrowRight,
  IconFolder,
  IconRefresh,
  IconImage,
} from "./shared/components/icons";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  pickFiles,
  pickDirectory,
  onDragDropEvent,
  isTauri,
  baseNameSync,
  formatBytes,
} from "./shared/lib/tauri";
import type { Theme } from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  VIDEO_EXTENSIONS,
  FORMATS,
  formatDef,
  DEFAULT_OPTIONS,
  buildOutputPath,
  convertVideo,
  probeVideo,
  type OutputFormat,
  type ConvertOptions,
  type ConvertResult,
  type ProbeResult,
} from "./lib/tauri";
import { ReelLogo } from "./components/ReelLogo";

// A file in the batch, along with its probe and conversion result.

interface WorkFile {
  path: string;
  name: string;
  size: number;
  probe: ProbeResult | null;
  result: ConvertResult | null;
  loading: boolean;
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [dragging, setDragging] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "reel-recent", max: 20 });

  // State for the conversion view.
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const hasFiles = files.length > 0;

  // Load persisted settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<string>("outputDir").then((d) => {
      if (d) setOutputDir(d);
    });
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
        if (paths.length > 0) {
          addFiles(paths);
        }
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Reel] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const addFiles = useCallback((paths: string[]) => {
    const newFiles: WorkFile[] = paths.map((p) => ({
      path: p,
      name: baseNameSync(p),
      size: 0,
      probe: null,
      result: null,
      loading: true,
    }));
    setFiles((prev) => [...prev, ...newFiles]);
    paths.forEach((p) => addRecent({ name: baseNameSync(p), path: p, tool: "video", timestamp: Date.now() }));

    // Probe each file for metadata
    newFiles.forEach((wf) => {
      probeVideo(wf.path).then((probe) => {
        setFiles((prev) => {
          const idx = prev.findIndex((f) => f.path === wf.path);
          if (idx < 0) return prev;
          const copy = [...prev];
          copy[idx] = { ...copy[idx], probe, loading: false, size: 0 };
          return copy;
        });
      }).catch(() => {
        setFiles((prev) => {
          const idx = prev.findIndex((f) => f.path === wf.path);
          if (idx < 0) return prev;
          const copy = [...prev];
          copy[idx] = { ...copy[idx], loading: false };
          return copy;
        });
      });
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const paths = await pickFiles(VIDEO_EXTENSIONS, true);
    if (paths.length > 0) {
      addFiles(paths);
    }
  }, []);

  const handleAddMore = useCallback(async () => {
    const paths = await pickFiles(VIDEO_EXTENSIONS, true);
    if (paths.length > 0) {
      addFiles(paths);
    }
  }, []);

  const handleRemoveFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setSelectedIdx((prev) => (prev >= idx && prev > 0 ? prev - 1 : prev));
  }, []);

  const handleClearAll = useCallback(() => {
    setFiles([]);
    setSelectedIdx(0);
    setProgress(0);
  }, []);

  const handlePickOutputDir = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) {
      setOutputDir(dir);
      await setStoreValue("outputDir", dir);
    }
  }, []);

  const handleClearOutputDir = useCallback(() => {
    setOutputDir(null);
    setStoreValue("outputDir", null);
  }, []);

  const updateOptions = useCallback((patch: Partial<ConvertOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleConvert = useCallback(async () => {
    if (files.length === 0 || processing) return;
    setProcessing(true);
    setProgress(0);

    const total = files.length;
    let done = 0;

    for (let i = 0; i < files.length; i++) {
      const wf = files[i];
      const outputPath = buildOutputPath(wf.path, outputDir, options.format);
      try {
        const result = await convertVideo(wf.path, outputPath, options);
        setFiles((prev) => {
          const copy = [...prev];
          copy[i] = { ...copy[i], result };
          return copy;
        });
        if (result.success) {
          showToast(`Converted ${wf.name} → ${formatDef(options.format)?.label}`, "success");
        } else {
          showToast(`Failed: ${wf.name} — ${result.error ?? "unknown error"}`, "error");
        }
      } catch (e) {
        const errMsg = String(e);
        setFiles((prev) => {
          const copy = [...prev];
          copy[i] = { ...copy[i], result: { success: false, outputPath, outputSize: 0, inputSize: wf.size, durationMs: 0, error: errMsg } };
          return copy;
        });
        showToast(`Failed: ${wf.name} — ${errMsg}`, "error");
      }
      done++;
      setProgress((done / total) * 100);
    }

    setProcessing(false);
  }, [files, options, outputDir, processing]);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    addFiles([file.path]);
  }, [addFiles]);

  const allDone = hasFiles && files.every((f) => f.result?.success);
  const totalSaved = files.reduce((sum, f) => {
    if (!f.result?.success) return sum;
    return sum + (f.size > f.result.outputSize ? f.size - f.result.outputSize : 0);
  }, 0);
  const selected = files[selectedIdx];

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar
          appName="Reel"
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
              onClearRecent={clearRecent}
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
        </div>
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );

  void theme;
  void handleThemeChange;
}

function filterByExt(paths: string[]): string[] {
  return paths.filter((p) => {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    return VIDEO_EXTENSIONS.includes(ext);
  });
}

// ============================================================
// Home / drop overlay
// ============================================================

interface DropOverlayProps {
  onBrowse: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  dragging: boolean;
  onClearRecent: () => void;
}

function DropOverlay({ onBrowse, recent, onOpenRecent, dragging, onClearRecent }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <ReelLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop video to convert or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop video to convert</div>
        <div className="drop-zone__subtext">MP4, MKV, WebM, AVI, MOV, FLV, GIF — or pick from your files</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
          Browse files
        </button>
      </div>
      <div className="drop-overlay__notice">
        <IconInfo size={13} /> No FFmpeg, no uploads. Converts via native OS codecs and royalty-free Rust libraries.
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">
            Recent
            <button className="btn-ghost" onClick={onClearRecent} style={{ marginLeft: "auto", padding: "2px 6px", fontSize: 10 }}>Clear</button>
          </div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconFile size={14} />
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

// Working view with the file list, settings, and conversion bar.

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
  const { files, selectedIdx, onSelect, onRemove, onClearAll, onAddMore } = props;
  return (
    <div className="reel-work">
      <div className="reel-work__topbar">
        <div className="reel-work__topbar-left">
          <span className="reel-work__count">
            {files.length} {files.length === 1 ? "video" : "videos"}
          </span>
        </div>
        <div className="reel-work__topbar-right">
          <button className="btn-ghost" onClick={onAddMore} disabled={props.processing}>
            <IconImage size={14} /> Add more
          </button>
          <button className="btn-ghost" onClick={onClearAll} disabled={props.processing}>
            <IconClose size={14} /> Clear all
          </button>
        </div>
      </div>

      <div className="reel-work__split">
        <FileList files={files} selectedIdx={selectedIdx} onSelect={onSelect} onRemove={onRemove} />
        <SettingsPanel
          options={props.options}
          onUpdateOptions={props.onUpdateOptions}
          selected={props.selected}
          processing={props.processing}
        />
      </div>

      <ConvertBar
        outputDir={props.outputDir}
        onPickOutputDir={props.onPickOutputDir}
        onClearOutputDir={props.onClearOutputDir}
        onConvert={props.onConvert}
        processing={props.processing}
        progress={props.progress}
        allDone={props.allDone}
        totalSaved={props.totalSaved}
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
    <div className="reel-files">
      {files.map((f, i) => (
        <div
          key={i}
          className={`reel-file ${i === selectedIdx ? "reel-file--active" : ""} ${f.result?.success ? "reel-file--done" : ""}`}
          onClick={() => onSelect(i)}
        >
          <div className="reel-file__thumb">
            <IconFile size={20} />
          </div>
          <div className="reel-file__body">
            <span className="reel-file__name">{f.name}</span>
            <span className="reel-file__meta">
              {f.loading ? "Reading…" : f.result?.success
                ? `${formatBytes(f.size)} → ${formatBytes(f.result.outputSize)}`
                : f.probe
                  ? `${f.probe.width}×${f.probe.height} · ${f.probe.fps.toFixed(0)}fps · ${f.probe.codecVideo}`
                  : f.size > 0 ? formatBytes(f.size) : ""}
            </span>
            {f.result && !f.result.success && (
              <span className="reel-file__error">Failed</span>
            )}
          </div>
          {f.result?.success ? (
            <span className="reel-file__check"><IconCheck size={16} /></span>
          ) : (
            <span className="reel-file__remove" onClick={(e) => { e.stopPropagation(); onRemove(i); }}>
              <IconClose size={14} />
            </span>
          )}
        </div>
      ))}
    </div>
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
  const isGif = options.format === "gif";

  return (
    <div className="reel-settings">
      {/* Selected file info */}
      {selected && (
        <div className="reel-settings__preview">
          <div className="reel-settings__preview-icon"><IconFile size={28} /></div>
          <div className="reel-settings__preview-info">
            <span className="reel-settings__preview-name">{selected.name}</span>
            <span className="reel-settings__preview-meta">
              {selected.loading ? "Reading…" : selected.probe
                ? `${selected.probe.width}×${selected.probe.height} · ${selected.probe.fps.toFixed(1)}fps · ${selected.probe.codecVideo}${selected.probe.hasAudio ? ` + ${selected.probe.codecAudio}` : ""}`
                : "No metadata available"}
            </span>
          </div>
        </div>
      )}

      {/* Format picker */}
      <div className="reel-section">
        <div className="reel-section__label">Output format</div>
        <div className="reel-formats">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`reel-format ${options.format === f.id ? "reel-format--selected" : ""} ${!f.available ? "reel-format--disabled" : ""}`}
              onClick={() => f.available && onUpdateOptions({ format: f.id as OutputFormat })}
              disabled={!f.available || processing}
            >
              <span className="reel-format__label">{f.label}</span>
              <span className="reel-format__desc">{f.available ? f.videoCodec : "Coming soon"}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Resolution */}
      {!isGif && (
        <div className="reel-section">
          <div className="reel-section__label">
            Resolution <span className="reel-section__hint">0 = keep original</span>
          </div>
          <div className="reel-dual-input">
            <label>
              <span>Width</span>
              <input
                type="number"
                min={0}
                max={7680}
                value={options.width || ""}
                placeholder="Auto"
                onChange={(e) => onUpdateOptions({ width: Number(e.target.value) || 0 })}
                disabled={processing}
              />
            </label>
            <label>
              <span>Height</span>
              <input
                type="number"
                min={0}
                max={4320}
                value={options.height || ""}
                placeholder="Auto"
                onChange={(e) => onUpdateOptions({ height: Number(e.target.value) || 0 })}
                disabled={processing}
              />
            </label>
          </div>
        </div>
      )}

      {/* Framerate */}
      <div className="reel-section">
        <div className="reel-section__label">
          Framerate <span className="reel-section__hint">0 = keep original</span>
        </div>
        <div className="reel-fps-row">
          {[0, 24, 30, 60].map((fps) => (
            <button
              key={fps}
              className={`reel-fps-btn ${options.fps === fps ? "reel-fps-btn--selected" : ""}`}
              onClick={() => onUpdateOptions({ fps })}
              disabled={processing}
            >
              {fps === 0 ? "Auto" : `${fps}`}
            </button>
          ))}
        </div>
      </div>

      {/* Video bitrate */}
      {!isGif && (
        <div className="reel-section">
          <div className="reel-section__label">
            Video bitrate <span className="reel-section__hint">0 = codec default</span>
          </div>
          <div className="reel-slider-row">
            <input
              type="range"
              min={0}
              max={20000}
              step={500}
              value={options.videoBitrate}
              onChange={(e) => onUpdateOptions({ videoBitrate: Number(e.target.value) })}
              className="reel-slider"
              disabled={processing}
            />
            <span className="reel-slider__value">
              {options.videoBitrate === 0 ? "Auto" : `${(options.videoBitrate / 1000).toFixed(1)} Mbps`}
            </span>
          </div>
        </div>
      )}

      {/* Trim */}
      <div className="reel-section">
        <div className="reel-section__label">
          Trim <span className="reel-section__hint">seconds</span>
        </div>
        <div className="reel-dual-input">
          <label>
            <span>Start</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={options.trimStart || ""}
              placeholder="0.0"
              onChange={(e) => onUpdateOptions({ trimStart: Number(e.target.value) || 0 })}
              disabled={processing}
            />
          </label>
          <label>
            <span>End</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={options.trimEnd || ""}
              placeholder="End"
              onChange={(e) => onUpdateOptions({ trimEnd: Number(e.target.value) || 0 })}
              disabled={processing}
            />
          </label>
        </div>
      </div>

      {/* Audio */}
      {!isGif && (
        <div className="reel-section">
          <div className="reel-section__label">Audio</div>
          <label className="reel-checkbox">
            <input
              type="checkbox"
              checked={options.noAudio}
              onChange={(e) => onUpdateOptions({ noAudio: e.target.checked })}
              disabled={processing}
            />
            <span>Strip audio track</span>
          </label>
        </div>
      )}
    </div>
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
  return (
    <div className="reel-convertbar">
      {props.processing && (
        <div className="reel-progress">
          <div className="reel-progress__bar" style={{ width: `${props.progress}%` }} />
        </div>
      )}
      <div className="reel-convertbar__row">
        <div className="reel-convertbar__group">
          <span className="reel-convertbar__label">Output</span>
          <div className="reel-convertbar__output">
            <button className="btn-ghost" onClick={props.onPickOutputDir} disabled={props.processing}>
              <IconFolder size={14} /> {props.outputDir ? "Change" : "Choose folder"}
            </button>
            {props.outputDir && (
              <>
                <span className="reel-convertbar__output-path">{props.outputDir}</span>
                <button className="btn-ghost" onClick={props.onClearOutputDir} disabled={props.processing}>Clear</button>
              </>
            )}
            {!props.outputDir && <span className="muted">Next to original</span>}
          </div>
        </div>

        <div className="reel-convertbar__spacer" />

        {props.allDone ? (
          <div className="reel-convertbar__done">
            <span className="success"><IconCheck size={14} /> Done{props.totalSaved > 0 ? ` · saved ${formatBytes(props.totalSaved)}` : ""}</span>
            <button className="btn-ghost" onClick={() => window.location.reload()}>
              <IconRefresh size={14} /> Start over
            </button>
          </div>
        ) : (
          <button className="btn btn--primary" onClick={props.onConvert} disabled={props.processing || props.fileCount === 0}>
            {props.processing ? "Converting…" : `Convert ${props.fileCount} ${props.fileCount === 1 ? "file" : "files"}`}
            {!props.processing && <IconArrowRight size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
