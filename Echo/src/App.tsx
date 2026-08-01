import { useEffect, useState, useCallback, useMemo } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconFile,
  IconCheck,
  IconClose,
  IconFolder,
  IconRefresh,
  IconArrowRight,
  IconUpload,
  IconInfo,
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
  convertAudio,
  probeAudio,
  getFfmpegStatus,
  setFfmpegPath,
  clearFfmpegPath,
  downloadFfmpeg,
  buildOutputPath,
  FORMATS,
  formatDef,
  SAMPLE_RATES,
  BITRATES,
  DEFAULT_OPTIONS,
  AUDIO_EXTENSIONS,
  formatDuration,
  type OutputFormat,
  type ConvertOptions,
  type ConvertResult,
  type FfmpegStatus,
  type NormalizeModeTag,
} from "./lib/tauri";
import { EchoLogo } from "./components/EchoLogo";

interface WorkFile {
  path: string;
  name: string;
  size: number;
  duration: number | null;
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
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "echo-recent", max: 20 });

  // Restore settings and check whether FFmpeg is available.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<string>("outputDir").then((v) => v && setOutputDir(v));
    getStoreValue<ConvertOptions>("options").then((o) => o && setOptions({ ...DEFAULT_OPTIONS, ...o }));
    if (isTauri) {
      getFfmpegStatus()
        .then((status) => {
          setFfmpegStatus(status);
          setFfmpegOk(status.available);
          if (!status.available) setShowSetup(true);
        })
        .catch(() => {
          setFfmpegOk(false);
          setShowSetup(true);
        });
    }
  }, []);

  // Refresh FFmpeg status after setup changes.
  const refreshFfmpegStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      const status = await getFfmpegStatus();
      setFfmpegStatus(status);
      setFfmpegOk(status.available);
      if (status.available) setShowSetup(false);
    } catch {
      setFfmpegOk(false);
    }
  }, []);

  // Listen for files dropped anywhere in the app window.
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
      .catch((e) => console.error("[Echo] drag listener failed:", e));
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
      duration: null,
      result: null,
      loading: true,
    }));
    setFiles((prev) => [...prev, ...workFiles]);
    setSelectedIdx(0);
    // Resolve sizes + probe durations asynchronously.
    workFiles.forEach(async (wf) => {
      try {
        const { fileSize } = await import("./shared/lib/tauri");
        const sz = await fileSize(wf.path);
        let duration: number | null = null;
        if (isTauri) {
          try {
            const info = await probeAudio(wf.path);
            duration = info.duration_sec;
          } catch { /* probe optional */ }
        }
        setFiles((prev) => prev.map((f) => (f.path === wf.path ? { ...f, size: sz, duration, loading: false } : f)));
      } catch {
        setFiles((prev) => prev.map((f) => (f.path === wf.path ? { ...f, loading: false } : f)));
      }
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const { pickFiles } = await import("./shared/lib/tauri");
    const paths = await pickFiles(AUDIO_EXTENSIONS, true, [{ name: "Audio", extensions: AUDIO_EXTENSIONS }]);
    if (paths.length > 0) handleFiles(paths);
  }, [handleFiles]);

  // ---- Convert ----

  const handleConvert = useCallback(async () => {
    if (!files.length || processing) return;
    if (ffmpegOk === false) {
      showToast("FFmpeg was not found. See the note in Settings.", "error");
      return;
    }
    setProcessing(true);
    setProgress(0);

    let totalSaved = 0;
    const results: WorkFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const outputPath = buildOutputPath(f.path, outputDir, options.format);
      try {
        const result = await convertAudio(f.path, outputPath, options);
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
            duration_sec: 0,
          },
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setFiles(results);
    setProcessing(false);
    const succeeded = results.filter((r) => r.result?.ok).length;
    const failed = results.length - succeeded;
    if (succeeded === 0) {
      showToast(`All ${results.length} ${results.length === 1 ? "file" : "files"} failed`, "error");
    } else if (failed > 0) {
      showToast(`Converted ${succeeded} of ${results.length} ${results.length === 1 ? "file" : "files"} · ${failed} failed`, "info");
    } else {
      const savedStr = formatBytes(totalSaved);
      showToast(`Converted ${succeeded} ${succeeded === 1 ? "file" : "files"} · saved ${savedStr}`, "success");
    }
  }, [files, processing, outputDir, options, addRecent, ffmpegOk]);

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
      { path: file.path, name: file.name, size: file.sizeBefore || 0, duration: null, result: null, loading: true },
    ]);
    setSelectedIdx(0);
    (async () => {
      try {
        const { fileSize } = await import("./shared/lib/tauri");
        const sz = await fileSize(file.path);
        let duration: number | null = null;
        if (isTauri) {
          try { duration = (await probeAudio(file.path)).duration_sec; } catch { /* */ }
        }
        setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, size: sz, duration, loading: false } : f)));
      } catch {
        setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, loading: false } : f)));
      }
    })();
  }, []);

  const handleAddMore = useCallback(async () => {
    const { pickFiles } = await import("./shared/lib/tauri");
    const paths = await pickFiles(AUDIO_EXTENSIONS, true, [{ name: "Audio", extensions: AUDIO_EXTENSIONS }]);
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
        <TitleBar appName="Echo" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
        <div className="stage">
          {showSetup && ffmpegOk === false ? (
            <FfmpegSetup
              status={ffmpegStatus}
              onRefresh={refreshFfmpegStatus}
              onDismiss={() => setShowSetup(false)}
            />
          ) : !hasFiles ? (
            <DropOverlay
              onBrowse={handleBrowse}
              recent={recent}
              onOpenRecent={handleOpenRecent}
              dragging={dragging}
              ffmpegOk={ffmpegOk}
              onSetup={() => setShowSetup(true)}
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
              ffmpegOk={ffmpegOk}
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
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>FFmpeg</label>
                <p style={{ fontSize: 11, color: ffmpegOk === false ? "var(--danger)" : "var(--text-3)", display: "flex", alignItems: "center", gap: 6 }}>
                  <IconInfo size={13} />
                  {ffmpegStatus?.available
                    ? ffmpegStatus.source === "path"
                      ? `Found on PATH${ffmpegStatus.version ? ` — ${ffmpegStatus.version}` : ""}`
                      : "Configured"
                    : "Not found — setup required"}
                </p>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button className="btn-ghost" onClick={() => setShowSetup(true)}>
                    {ffmpegStatus?.available ? "Change" : "Set up FFmpeg"}
                  </button>
                  {ffmpegStatus?.available && ffmpegStatus.source !== "path" && (
                    <button className="btn-ghost" onClick={async () => { await clearFfmpegPath(); refreshFfmpegStatus(); }}>
                      Reset to PATH
                    </button>
                  )}
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
  const exts = new Set(AUDIO_EXTENSIONS);
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
  ffmpegOk: boolean | null;
  onSetup: () => void;
}

function DropOverlay({ onBrowse, recent, onOpenRecent, dragging, ffmpegOk, onSetup }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <EchoLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop audio to convert or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop audio to convert</div>
        <div className="drop-zone__subtext">MP3, WAV, FLAC, OGG, Opus, AAC, M4A — or pick from your files</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
          Browse files
        </button>
      </div>
      {ffmpegOk === false && (
        <div className="drop-overlay__notice" onClick={onSetup} style={{ cursor: "pointer" }}>
          <IconInfo size={13} /> FFmpeg not found — click here to set it up
        </div>
      )}
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconFile size={14} />
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
  ffmpegOk: boolean | null;
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
    ffmpegOk,
  } = props;

  return (
    <div className="echo-work">
      <div className="echo-work__topbar">
        <div className="echo-work__topbar-left">
          <span className="echo-work__count">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div className="echo-work__topbar-right">
          <button className="btn-ghost" onClick={onAddMore} disabled={processing}>
            <IconFile size={14} /> Add more
          </button>
          <button className="btn-ghost" onClick={onClearAll} disabled={processing}>
            <IconClose size={14} /> Clear all
          </button>
        </div>
      </div>

      <div className="echo-work__split">
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
        ffmpegOk={ffmpegOk}
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
    <div className="echo-files">
      {files.map((f, i) => (
        <div
          key={i}
          className={`echo-file ${i === selectedIdx ? "echo-file--active" : ""} ${f.result?.ok ? "echo-file--done" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}
        >
          <span className="echo-file__icon">
            <IconFile size={18} />
          </span>
          <div className="echo-file__body">
            <span className="echo-file__name">{f.name}</span>
            <span className="echo-file__meta">
              {f.loading
                ? "Reading…"
                : f.result?.ok
                  ? `${formatBytes(f.result.input_size)} → ${formatBytes(f.result.output_size)}`
                  : [
                      f.size > 0 ? formatBytes(f.size) : "",
                      f.duration != null ? formatDuration(f.duration) : "",
                    ].filter(Boolean).join(" · ")}
            </span>
            {f.result && !f.result.ok && (
              <span className="echo-file__error">Failed</span>
            )}
          </div>
          {f.result?.ok ? (
            <span className="echo-file__check">
              <IconCheck size={16} />
            </span>
          ) : (
            <span
              className="echo-file__remove"
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
    <div className="echo-settings">
      {/* Selected file preview */}
      {selected && (
        <div className="echo-settings__preview">
          <span className="echo-settings__preview-icon">
            <IconFile size={34} />
          </span>
          <div className="echo-settings__preview-info">
            <span className="echo-settings__preview-name">{selected.name}</span>
            <span className="echo-settings__preview-meta">
              {selected.loading
                ? "Reading…"
                : [
                    selected.size > 0 ? formatBytes(selected.size) : "",
                    selected.duration != null ? formatDuration(selected.duration) : "",
                  ].filter(Boolean).join(" · ")}
            </span>
            {selected.result?.ok && (
              <span className="echo-settings__preview-result">
                <IconCheck size={11} /> {formatBytes(selected.result.output_size)}
              </span>
            )}
            {selected.result && !selected.result.ok && (
              <span className="echo-settings__preview-error">{selected.result.message}</span>
            )}
          </div>
        </div>
      )}

      {/* Format picker */}
      <div className="echo-section">
        <div className="echo-section__label">Output format</div>
        <div className="echo-formats">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`echo-format ${options.format === f.id ? "echo-format--selected" : ""}`}
              onClick={() => onUpdateOptions({ format: f.id as OutputFormat })}
              disabled={processing}
              title={f.desc}
            >
              <span className="echo-format__label">{f.label}</span>
              <span className="echo-format__desc">{f.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Bitrate (lossy only) */}
      {currentFormat.lossy && (
        <div className="echo-section">
          <div className="echo-section__label">
            Bitrate <span className="echo-section__value">{options.bitrate ?? 192} kbps</span>
          </div>
          <div className="echo-btn-row">
            {BITRATES.map((b) => (
              <button
                key={b.value}
                className={`echo-btn-chip ${options.bitrate === b.value ? "echo-btn-chip--selected" : ""}`}
                onClick={() => onUpdateOptions({ bitrate: b.value })}
                disabled={processing}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sample rate */}
      <div className="echo-section">
        <div className="echo-section__label">Sample rate</div>
        <div className="echo-btn-row">
          {SAMPLE_RATES.map((s) => (
            <button
              key={s.label}
              className={`echo-btn-chip ${options.sample_rate === s.value ? "echo-btn-chip--selected" : ""}`}
              onClick={() => onUpdateOptions({ sample_rate: s.value })}
              disabled={processing}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Channels */}
      <div className="echo-section">
        <div className="echo-section__label">Channels</div>
        <div className="echo-btn-row">
          <button
            className={`echo-btn-chip ${options.channels === null ? "echo-btn-chip--selected" : ""}`}
            onClick={() => onUpdateOptions({ channels: null })}
            disabled={processing}
          >
            Preserve
          </button>
          <button
            className={`echo-btn-chip ${options.channels === 1 ? "echo-btn-chip--selected" : ""}`}
            onClick={() => onUpdateOptions({ channels: 1 })}
            disabled={processing}
          >
            Mono
          </button>
          <button
            className={`echo-btn-chip ${options.channels === 2 ? "echo-btn-chip--selected" : ""}`}
            onClick={() => onUpdateOptions({ channels: 2 })}
            disabled={processing}
          >
            Stereo
          </button>
        </div>
      </div>

      {/* Processing options */}
      <div className="echo-section">
        <div className="echo-section__label">Processing</div>

        <label className="echo-checkbox" title="Trim leading and trailing silence">
          <input
            type="checkbox"
            checked={options.trim_silence}
            onChange={(e) => onUpdateOptions({ trim_silence: e.target.checked })}
            disabled={processing}
          />
          Trim silence
        </label>

        {options.trim_silence && (
          <div className="echo-subcontrol">
            <label className="echo-subcontrol__label">Threshold</label>
            <div className="echo-subcontrol__row">
              <input
                type="number"
                step={1}
                value={options.trim_threshold_dbfs}
                onChange={(e) => onUpdateOptions({ trim_threshold_dbfs: Number(e.target.value) })}
                disabled={processing}
                className="input echo-input--sm"
              />
              <span className="echo-subcontrol__unit">dBFS</span>
            </div>
          </div>
        )}

        <div className="echo-subcontrol">
          <label className="echo-subcontrol__label">Normalize</label>
          <div className="echo-btn-row">
            {(["none", "peak"] as NormalizeModeTag[]).map((m) => (
              <button
                key={m}
                className={`echo-btn-chip ${options.normalize === m ? "echo-btn-chip--selected" : ""}`}
                onClick={() => onUpdateOptions({ normalize: m })}
                disabled={processing}
              >
                {m === "none" ? "Off" : "Peak"}
              </button>
            ))}
          </div>
        </div>

        {options.normalize === "peak" && (
          <div className="echo-subcontrol">
            <label className="echo-subcontrol__label">Peak target</label>
            <div className="echo-subcontrol__row">
              <input
                type="number"
                step={0.1}
                value={options.normalize_target_dbfs}
                onChange={(e) => onUpdateOptions({ normalize_target_dbfs: Number(e.target.value) })}
                disabled={processing}
                className="input echo-input--sm"
              />
              <span className="echo-subcontrol__unit">dBFS</span>
            </div>
          </div>
        )}
      </div>

      {/* Fade in/out */}
      <div className="echo-section">
        <div className="echo-section__label">Fade</div>
        <div className="echo-dual-input">
          <label>
            <span>Fade in</span>
            <input
              type="number"
              min={0}
              step={100}
              value={options.fade_in_ms}
              onChange={(e) => onUpdateOptions({ fade_in_ms: Math.max(0, Number(e.target.value)) })}
              disabled={processing}
            />
          </label>
          <label>
            <span>Fade out</span>
            <input
              type="number"
              min={0}
              step={100}
              value={options.fade_out_ms}
              onChange={(e) => onUpdateOptions({ fade_out_ms: Math.max(0, Number(e.target.value)) })}
              disabled={processing}
            />
          </label>
        </div>
        <span className="echo-section__hint">Milliseconds · 0 = no fade</span>
      </div>
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
  ffmpegOk: boolean | null;
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
    ffmpegOk,
  } = props;

  return (
    <div className="echo-convertbar">
      {processing && (
        <div className="echo-progress">
          <div className="echo-progress__bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="echo-convertbar__row">
        <div className="echo-convertbar__group">
          <span className="echo-convertbar__label">Output</span>
          <div className="echo-convertbar__output">
            <button className="btn-ghost" onClick={onPickOutputDir} disabled={processing}>
              <IconFolder size={14} /> {outputDir ? "Change" : "Choose folder"}
            </button>
            {outputDir && (
              <>
                <span className="echo-convertbar__output-path">{outputDir}</span>
                <button className="btn-ghost" onClick={onClearOutputDir} disabled={processing}>
                  Clear
                </button>
              </>
            )}
            {!outputDir && <span className="muted">Next to original</span>}
          </div>
        </div>

        <div className="echo-convertbar__spacer" />

        {allDone ? (
          <div className="echo-convertbar__done">
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
            disabled={processing || fileCount === 0 || ffmpegOk === false}
            title={ffmpegOk === false ? "FFmpeg not found" : undefined}
          >
            {processing ? "Converting…" : `Convert ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
            {!processing && <IconArrowRight size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// FFmpeg setup screen
// ============================================================

interface FfmpegSetupProps {
  status: FfmpegStatus | null;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
}

function FfmpegSetup({ status, onRefresh, onDismiss }: FfmpegSetupProps) {
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleBrowse = useCallback(async () => {
    const { pickFiles } = await import("./shared/lib/tauri");
    const paths = await pickFiles(null, false, [{ name: "FFmpeg", extensions: ["exe"] }]);
    if (paths.length > 0) {
      setBrowsePath(paths[0]);
      setError(null);
    }
  }, []);

  const handleConfirmBrowse = useCallback(async () => {
    if (!browsePath) return;
    setError(null);
    try {
      await setFfmpegPath(browsePath);
      await onRefresh();
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [browsePath, onRefresh]);

  const handlePickDownloadDir = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) setDownloadDir(dir);
  }, []);

  const handleDownload = useCallback(async () => {
    if (!downloadDir) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadFfmpeg(downloadDir);
      await onRefresh();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setDownloading(false);
    }
  }, [downloadDir, onRefresh]);

  const handleDrop = useCallback(async (paths: string[]) => {
    const exe = paths.find((p) => p.toLowerCase().endsWith(".exe"));
    if (!exe) {
      setError("Please drop ffmpeg.exe");
      return;
    }
    setError(null);
    try {
      await setFfmpegPath(exe);
      await onRefresh();
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [onRefresh]);

  // Listen for drag-drop of ffmpeg.exe
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") setDragOver(true);
      else if (event.type === "leave") setDragOver(false);
      else if (event.type === "drop") {
        setDragOver(false);
        handleDrop(event.paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, [handleDrop]);

  return (
    <div className="ffmpeg-setup">
      <div className="ffmpeg-setup__card">
        <div className="ffmpeg-setup__icon">
          <IconInfo size={32} />
        </div>
        <h2 className="ffmpeg-setup__title">FFmpeg required</h2>
        <p className="ffmpeg-setup__desc">
          Echo uses FFmpeg to convert audio. It's free and open source.
          Choose one of these options to get started:
        </p>

        {/* Option 1: Auto-download */}
        <div className="ffmpeg-setup__option">
          <div className="ffmpeg-setup__option-label">
            <span className="ffmpeg-setup__step">1</span>
            Download automatically
          </div>
          <p className="ffmpeg-setup__option-desc">
            We'll download a static FFmpeg build (~90 MB) and set it up for you.
          </p>
          <div className="ffmpeg-setup__option-actions">
            <button className="btn-ghost" onClick={handlePickDownloadDir} disabled={downloading}>
              <IconFolder size={14} /> {downloadDir ? "Change folder" : "Choose download folder"}
            </button>
            {downloadDir && (
              <span className="ffmpeg-setup__path">{downloadDir}</span>
            )}
            <button
              className="btn btn--primary"
              onClick={handleDownload}
              disabled={downloading || !downloadDir}
            >
              {downloading ? "Downloading…" : "Download FFmpeg"}
            </button>
          </div>
        </div>

        {/* Option 2: Browse for existing */}
        <div className="ffmpeg-setup__option">
          <div className="ffmpeg-setup__option-label">
            <span className="ffmpeg-setup__step">2</span>
            I already have it
          </div>
          <p className="ffmpeg-setup__option-desc">
            If you have ffmpeg.exe somewhere on your computer, point Echo to it.
          </p>
          <div className="ffmpeg-setup__option-actions">
            <button className="btn-ghost" onClick={handleBrowse}>
              <IconFolder size={14} /> Browse for ffmpeg.exe
            </button>
            {browsePath && (
              <>
                <span className="ffmpeg-setup__path">{browsePath}</span>
                <button className="btn btn--primary" onClick={handleConfirmBrowse}>
                  Use this
                </button>
              </>
            )}
          </div>
        </div>

        {/* Option 3: Drag-drop */}
        <div className="ffmpeg-setup__option">
          <div className="ffmpeg-setup__option-label">
            <span className="ffmpeg-setup__step">3</span>
            Drag and drop
          </div>
          <div
            className={`ffmpeg-setup__dropzone ${dragOver ? "ffmpeg-setup__dropzone--active" : ""}`}
          >
            <IconUpload size={20} />
            <span>Drop ffmpeg.exe here</span>
          </div>
        </div>

        {/* Status (if found via PATH) */}
        {status?.available && status.source === "path" && (
          <div className="ffmpeg-setup__found">
            <IconCheck size={14} /> FFmpeg found on your system PATH
            {status.version && <span className="ffmpeg-setup__version">{status.version}</span>}
            <button className="btn-ghost" onClick={onDismiss}>Continue</button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="ffmpeg-setup__error">
            <IconInfo size={13} /> {error}
          </div>
        )}

        {/* Dismiss link */}
        <button className="ffmpeg-setup__dismiss" onClick={onDismiss}>
          Skip for now — I'll set this up later
        </button>
      </div>
    </div>
  );
}
