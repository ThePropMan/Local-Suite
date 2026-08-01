import { useEffect, useState, useCallback, useMemo } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconTrash,
  IconClose,
  IconCheck,
  IconWarning,
  IconFile,
  IconFolder,
  IconUpload,
  IconClock,
  IconLayers,
  IconRefresh,
} from "./shared/components/icons";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  onDragDropEvent,
  isTauri,
  baseNameSync,
  formatBytes,
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  shredFiles,
  wipeFreeSpace,
  detectSsd,
  listDrives,
  readShredLog,
  clearShredLog,
  pickForShred,
  pickFolderForShred,
  ALGORITHM_LABELS,
  ALGORITHM_DESCRIPTIONS,
  algorithmPasses,
  type Algorithm,
  type ShredResult,
  type FileProgress,
  type WipeResult,
  type DriveInfo,
  type LogEntry,
} from "./lib/tauri";
import { ShredLogo } from "./components/ShredLogo";

type Tab = "shred" | "wipe" | "log";

interface WorkItem {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [tab, setTab] = useState<Tab>("shred");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [algorithm, setAlgorithm] = useState<Algorithm>("quick");
  const [customPasses, setCustomPasses] = useState(3);
  const [customPattern, setCustomPattern] = useState("00");
  const [verify, setVerify] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<FileProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ShredResult | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [ssdWarning, setSsdWarning] = useState<string | null>(null);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string>("");
  const [wipeResult, setWipeResult] = useState<WipeResult | null>(null);
  const [wipeProgress, setWipeProgress] = useState<number>(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "shred-recent", max: 20 });

  // Restore saved settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<Algorithm>("algorithm").then((v) => v && setAlgorithm(v));
    getStoreValue<number>("customPasses").then((v) => v && setCustomPasses(v));
    getStoreValue<string>("customPattern").then((v) => v && setCustomPattern(v));
    getStoreValue<boolean>("verify").then((v) => v !== undefined && setVerify(v));
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
        if (event.paths.length > 0) handleFiles(event.paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Shred] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Update file progress from Rust events.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen<FileProgress>("shred://progress", (event) => {
        setProgress(event.payload);
      });
      if (!cancelled) unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Update the free-space wipe counter.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen<{ bytes: number }>("shred://wipe-progress", () => {
        setWipeProgress((p) => p + 1);
      });
      if (!cancelled) unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Clear the previous result when inputs change.
  useEffect(() => {
    setResult(null);
  }, [items, algorithm, customPasses, customPattern, verify]);

  // Recheck SSD status whenever the item list changes.
  useEffect(() => {
    if (!isTauri || items.length === 0) {
      setSsdWarning(null);
      return;
    }
    let cancelled = false;
    detectSsd(items[0].path).then((isSsd) => {
      if (cancelled) return;
      setSsdWarning(isSsd ? "ssd" : null);
    }).catch(() => setSsdWarning(null));
    return () => { cancelled = true; };
  }, [items]);

  // Load available drives when the wipe tab opens.
  useEffect(() => {
    if (!isTauri || tab !== "wipe") return;
    listDrives().then((d) => {
      setDrives(d);
      if (d.length > 0 && !selectedDrive) {
        const firstFixed = d.find((dr) => dr.free_bytes > 0) ?? d[0];
        setSelectedDrive(firstFixed.letter);
      }
    }).catch((e) => console.error("[Shred] listDrives failed:", e));
  }, [tab]);

  // Refresh the log when its tab opens.
  useEffect(() => {
    if (!isTauri || tab !== "log") return;
    refreshLog();
  }, [tab]);

  const refreshLog = useCallback(() => {
    readShredLog().then(setLogEntries).catch((e) => console.error("[Shred] readShredLog failed:", e));
  }, []);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleAlgorithmChange = useCallback(async (a: Algorithm) => {
    setAlgorithm(a);
    await setStoreValue("algorithm", a);
  }, []);

  const handleCustomPassesChange = useCallback(async (n: number) => {
    const clamped = Math.max(1, Math.min(100, n));
    setCustomPasses(clamped);
    await setStoreValue("customPasses", clamped);
  }, []);

  const handleCustomPatternChange = useCallback(async (v: string) => {
    // Allow hex: 00-FF or "random"
    const cleaned = v.replace(/[^0-9a-fA-F]/g, "").slice(0, 2);
    setCustomPattern(cleaned || "00");
    await setStoreValue("customPattern", cleaned || "00");
  }, []);

  const handleVerifyChange = useCallback(async (v: boolean) => {
    setVerify(v);
    await setStoreValue("verify", v);
  }, []);

  // ---- File loading ----

  const handleFiles = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const workItems: WorkItem[] = await Promise.all(
      paths.map(async (p) => ({
        path: p,
        name: baseNameSync(p),
        size: await fileSizeSafe(p),
        isDir: await isDirSafe(p),
      })),
    );
    setItems((prev) => [...prev, ...workItems]);
    setTab("shred");
  }, []);

  const handleBrowse = useCallback(async () => {
    const paths = await pickForShred();
    if (paths.length > 0) handleFiles(paths);
  }, [handleFiles]);

  const handleBrowseFolder = useCallback(async () => {
    const dir = await pickFolderForShred();
    if (dir) handleFiles([dir]);
  }, [handleFiles]);

  const handleRemoveItem = useCallback((idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleClearAll = useCallback(() => {
    setItems([]);
    setResult(null);
    setProgress(null);
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    setItems([{ path: file.path, name: file.name, size: file.sizeBefore || 0, isDir: false }]);
    setResult(null);
    setTab("shred");
  }, []);

  // ---- Actions ----

  const canShred = items.length > 0 && !processing;

  const handleShred = useCallback(async () => {
    setShowConfirm(false);
    if (!canShred) return;
    setProcessing(true);
    setProgress(null);
    setResult(null);

    const paths = items.map((i) => i.path);
    const patternByte = customPattern.length === 2
      ? parseInt(customPattern, 16)
      : undefined;

    try {
      const res = await shredFiles(
        paths,
        algorithm,
        algorithm === "custom" ? customPasses : undefined,
        algorithm === "custom" ? patternByte : undefined,
        verify,
      );
      setResult(res);
      setProgress(null);
      addRecent({
        name: `${res.files_shredded} ${res.files_shredded === 1 ? "file" : "files"} shredded`,
        path: paths[0],
        tool: algorithm,
        timestamp: Date.now(),
        sizeBefore: res.bytes_overwritten,
      });
      if (res.errors.length > 0) {
        showToast(
          `Shredded ${res.files_shredded} files, ${res.files_skipped} skipped (${res.errors.length} errors)`,
          "error",
        );
      } else {
        showToast(
          `Shredded ${res.files_shredded} ${res.files_shredded === 1 ? "file" : "files"}${res.verified ? " · verified" : ""}`,
          "success",
        );
      }
      // Shredded items are gone, so remove them from the list.
      if (res.files_skipped === 0) {
        setItems([]);
      }
    } catch (e: any) {
      console.error("[shred] error:", e);
      showToast(`Shred failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [canShred, items, algorithm, customPasses, customPattern, verify, addRecent]);

  const handleWipe = useCallback(async () => {
    if (!selectedDrive || processing) return;
    setWipeConfirmOpen(true);
  }, [selectedDrive, processing]);

  const doWipe = useCallback(async () => {
    setWipeConfirmOpen(false);
    if (!selectedDrive || processing) return;
    setProcessing(true);
    setWipeResult(null);
    setWipeProgress(0);

    try {
      const res = await wipeFreeSpace(selectedDrive);
      setWipeResult(res);
      if (res.errors.length > 0) {
        showToast(`Wiped ${formatBytes(res.bytes_wiped)} (${res.errors.length} errors)`, "error");
      } else {
        showToast(`Wiped ${formatBytes(res.bytes_wiped)} free space on ${res.drive}`, "success");
      }
      refreshLog();
    } catch (e: any) {
      console.error("[wipe] error:", e);
      showToast(`Wipe failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [selectedDrive, processing, refreshLog]);

  const handleClearLog = useCallback(async () => {
    try {
      await clearShredLog();
      setLogEntries([]);
      showToast("Shred log cleared", "info");
    } catch (e: any) {
      showToast(`Failed to clear log: ${e.message || e}`, "error");
    }
  }, []);

  // ---- Derived ----

  const hasItems = items.length > 0;
  const totalSize = useMemo(() => items.reduce((s, i) => s + i.size, 0), [items]);
  const totalPasses = algorithmPasses(algorithm, customPasses);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar appName="Shred" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
        <div className="stage">
          {!hasItems && tab === "shred" ? (
            <DropOverlay
              tab={tab}
              onTabChange={setTab}
              onBrowse={handleBrowse}
              onBrowseFolder={handleBrowseFolder}
              recent={recent}
              onOpenRecent={handleOpenRecent}
              dragging={dragging}
            />
          ) : (
            <WorkingView
              tab={tab}
              onTabChange={setTab}
              items={items}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onAddMore={handleBrowse}
              algorithm={algorithm}
              onAlgorithmChange={handleAlgorithmChange}
              customPasses={customPasses}
              onCustomPassesChange={handleCustomPassesChange}
              customPattern={customPattern}
              onCustomPatternChange={handleCustomPatternChange}
              verify={verify}
              onVerifyChange={handleVerifyChange}
              onShred={() => setShowConfirm(true)}
              processing={processing}
              progress={progress}
              canShred={canShred}
              result={result}
              ssdWarning={ssdWarning}
              drives={drives}
              selectedDrive={selectedDrive}
              onSelectDrive={setSelectedDrive}
              onWipe={handleWipe}
              wipeResult={wipeResult}
              wipeProgress={wipeProgress}
              logEntries={logEntries}
              onClearLog={handleClearLog}
              onRefreshLog={refreshLog}
            />
          )}
          {showSettings && (
            <div className="settings-overlay">
              <div className="tool-panel__header">Settings</div>
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
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Post-shred verification</label>
                <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
                  After shredding, attempt to read each file back to confirm it was deleted. Recommended.
                </p>
                <div className="preset-group">
                  <button
                    className={`preset ${verify ? "preset--selected" : ""}`}
                    onClick={() => handleVerifyChange(true)}
                  >
                    <div className="preset__label">Verify</div>
                  </button>
                  <button
                    className={`preset ${!verify ? "preset--selected" : ""}`}
                    onClick={() => handleVerifyChange(false)}
                  >
                    <div className="preset__label">Skip</div>
                  </button>
                </div>
              </div>
              {recent.length > 0 && (
                <div>
                  <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Recent</label>
                  <button className="btn-ghost" onClick={clearRecent}>Clear recent</button>
                </div>
              )}
            </div>
          )}
        </div>
        {showConfirm && (
          <ConfirmDialog
            items={items}
            algorithm={algorithm}
            customPasses={customPasses}
            customPattern={customPattern}
            totalSize={totalSize}
            totalPasses={totalPasses}
            verify={verify}
            ssdWarning={ssdWarning}
            onCancel={() => setShowConfirm(false)}
            onConfirm={handleShred}
          />
        )}
        {wipeConfirmOpen && (
          <WipeConfirmDialog
            drive={selectedDrive}
            drives={drives}
            onCancel={() => setWipeConfirmOpen(false)}
            onConfirm={doWipe}
          />
        )}
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

// ============================================================
// Helpers
// ============================================================

async function fileSizeSafe(path: string): Promise<number> {
  if (!isTauri) return 0;
  try {
    const { fileSize } = await import("./shared/lib/tauri");
    return await fileSize(path);
  } catch {
    return 0;
  }
}

async function isDirSafe(path: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const s = await stat(path);
    return s.isDirectory;
  } catch {
    return false;
  }
}

// ============================================================
// Drop overlay (home screen)
// ============================================================

interface DropOverlayProps {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onBrowse: () => void;
  onBrowseFolder: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  dragging: boolean;
}

function DropOverlay({ tab, onTabChange, onBrowse, onBrowseFolder, recent, onOpenRecent, dragging }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <ShredLogo />
      <div className="shred-tabs">
        <button
          className={`shred-tabs__btn ${tab === "shred" ? "shred-tabs__btn--active" : ""}`}
          onClick={() => onTabChange("shred")}
        >
          <IconTrash size={15} />
          Shred
        </button>
        <button
          className={`shred-tabs__btn ${tab === "wipe" ? "shred-tabs__btn--active" : ""}`}
          onClick={() => onTabChange("wipe")}
        >
          <IconLayers size={15} />
          Free space
        </button>
        <button
          className={`shred-tabs__btn ${tab === "log" ? "shred-tabs__btn--active" : ""}`}
          onClick={() => onTabChange("log")}
        >
          <IconClock size={15} />
          Log
        </button>
      </div>
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop files or folders to shred or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop files or folders to shred</div>
        <div className="drop-zone__subtext">Securely overwrite and delete — or pick from your files</div>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
            <IconFile size={14} />
            Browse files
          </button>
          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); onBrowseFolder(); }}>
            <IconFolder size={14} />
            Browse folder
          </button>
        </div>
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconTrash size={14} />
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
  tab: Tab;
  onTabChange: (t: Tab) => void;
  items: WorkItem[];
  onRemoveItem: (idx: number) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  algorithm: Algorithm;
  onAlgorithmChange: (a: Algorithm) => void;
  customPasses: number;
  onCustomPassesChange: (n: number) => void;
  customPattern: string;
  onCustomPatternChange: (v: string) => void;
  verify: boolean;
  onVerifyChange: (v: boolean) => void;
  onShred: () => void;
  processing: boolean;
  progress: FileProgress | null;
  canShred: boolean;
  result: ShredResult | null;
  ssdWarning: string | null;
  drives: DriveInfo[];
  selectedDrive: string;
  onSelectDrive: (d: string) => void;
  onWipe: () => void;
  wipeResult: WipeResult | null;
  wipeProgress: number;
  logEntries: LogEntry[];
  onClearLog: () => void;
  onRefreshLog: () => void;
}

function WorkingView(props: WorkingViewProps) {
  const {
    tab, onTabChange, items, onRemoveItem, onClearAll, onAddMore,
    algorithm, onAlgorithmChange,
    customPasses, onCustomPassesChange,
    customPattern, onCustomPatternChange,
    verify, onVerifyChange,
    onShred, processing, progress, canShred,
    result, ssdWarning,
    drives, selectedDrive, onSelectDrive, onWipe,
    wipeResult, wipeProgress, logEntries, onClearLog, onRefreshLog,
  } = props;

  const totalSize = useMemo(() => items.reduce((s, i) => s + i.size, 0), [items]);

  return (
    <div className="shred-work">
      <div className="shred-work__topbar">
        <div className="shred-work__topbar-left">
          <div className="shred-tabs shred-tabs--sm">
            <button
              className={`shred-tabs__btn ${tab === "shred" ? "shred-tabs__btn--active" : ""}`}
              onClick={() => onTabChange("shred")}
              disabled={processing}
            >
              <IconTrash size={13} />
              Shred
            </button>
            <button
              className={`shred-tabs__btn ${tab === "wipe" ? "shred-tabs__btn--active" : ""}`}
              onClick={() => onTabChange("wipe")}
              disabled={processing}
            >
              <IconLayers size={13} />
              Free space
            </button>
            <button
              className={`shred-tabs__btn ${tab === "log" ? "shred-tabs__btn--active" : ""}`}
              onClick={() => onTabChange("log")}
              disabled={processing}
            >
              <IconClock size={13} />
              Log
            </button>
          </div>
        </div>
        {tab === "shred" && (
          <div className="shred-work__topbar-right">
            <span className="shred-work__count">
              {items.length} {items.length === 1 ? "item" : "items"} · {formatBytes(totalSize)}
            </span>
            <button className="btn-ghost" onClick={onAddMore} disabled={processing}>Add more</button>
            <button className="btn-ghost" onClick={onClearAll} disabled={processing}>Clear</button>
          </div>
        )}
        {tab === "log" && (
          <div className="shred-work__topbar-right">
            <button className="btn-ghost" onClick={onRefreshLog} disabled={processing}>
              <IconRefresh size={14} />
              Refresh
            </button>
            {logEntries.length > 0 && (
              <button className="btn-ghost" onClick={onClearLog} disabled={processing}>Clear log</button>
            )}
          </div>
        )}
      </div>

      {tab === "shred" && (
        <ShredTab
          items={items}
          onRemoveItem={onRemoveItem}
          algorithm={algorithm}
          onAlgorithmChange={onAlgorithmChange}
          customPasses={customPasses}
          onCustomPassesChange={onCustomPassesChange}
          customPattern={customPattern}
          onCustomPatternChange={onCustomPatternChange}
          verify={verify}
          onVerifyChange={onVerifyChange}
          onShred={onShred}
          processing={processing}
          progress={progress}
          canShred={canShred}
          result={result}
          ssdWarning={ssdWarning}
        />
      )}

      {tab === "wipe" && (
        <WipeTab
          drives={drives}
          selectedDrive={selectedDrive}
          onSelectDrive={onSelectDrive}
          onWipe={onWipe}
          processing={processing}
          wipeResult={wipeResult}
          wipeProgress={wipeProgress}
        />
      )}

      {tab === "log" && (
        <LogTab entries={logEntries} />
      )}
    </div>
  );
}

// ============================================================
// Shred tab
// ============================================================

interface ShredTabProps {
  items: WorkItem[];
  onRemoveItem: (idx: number) => void;
  algorithm: Algorithm;
  onAlgorithmChange: (a: Algorithm) => void;
  customPasses: number;
  onCustomPassesChange: (n: number) => void;
  customPattern: string;
  onCustomPatternChange: (v: string) => void;
  verify: boolean;
  onVerifyChange: (v: boolean) => void;
  onShred: () => void;
  processing: boolean;
  progress: FileProgress | null;
  canShred: boolean;
  result: ShredResult | null;
  ssdWarning: string | null;
}

function ShredTab(props: ShredTabProps) {
  const {
    items, onRemoveItem,
    algorithm, onAlgorithmChange,
    customPasses, onCustomPassesChange,
    customPattern, onCustomPatternChange,
    verify, onVerifyChange,
    onShred, processing, progress, canShred,
    result, ssdWarning,
  } = props;

  return (
    <div className="shred-work__body">
      {/* File list */}
      <div className="shred-files">
        {items.map((item, idx) => (
          <div key={idx} className="shred-file">
            <span className="shred-file__icon">
              {item.isDir ? <IconFolder size={16} /> : <IconFile size={16} />}
            </span>
            <div className="shred-file__body">
              <div className="shred-file__name">{item.name}</div>
              <div className="shred-file__meta">
                {item.isDir ? "folder" : formatBytes(item.size)}
              </div>
            </div>
            {!processing && (
              <button className="shred-file__remove" aria-label="Remove" onClick={() => onRemoveItem(idx)}>
                <IconClose size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Controls panel */}
      <div className="shred-panel">
        {/* SSD warning */}
        {ssdWarning === "ssd" && (
          <div className="shred-ssd-warning">
            <span className="shred-ssd-warning__icon">
              <IconWarning size={18} />
            </span>
            <div className="shred-ssd-warning__body">
              <div className="shred-ssd-warning__title">SSD detected</div>
              <div className="shred-ssd-warning__desc">
                Overwrite-based shredding is not guaranteed on SSDs. Wear-leveling
                may write to different cells than the ones holding your data. For
                true security on SSDs, use full-disk encryption. Shred will still
                overwrite and delete the file, but cannot guarantee unrecoverability.
              </div>
            </div>
          </div>
        )}

        {/* Algorithm picker */}
        <div className="shred-field">
          <label className="eyebrow">Algorithm</label>
          <div className="shred-algo">
            {(["quick", "dod", "gutmann", "custom"] as Algorithm[]).map((a) => (
              <button
                key={a}
                className={`shred-algo__option ${algorithm === a ? "shred-algo__option--selected" : ""}`}
                onClick={() => onAlgorithmChange(a)}
                disabled={processing}
              >
                <div className="shred-algo__option-header">
                  <span className="shred-algo__option-name">{ALGORITHM_LABELS[a]}</span>
                  <span className="shred-algo__option-passes">
                    {algorithmPasses(a, customPasses)} {algorithmPasses(a, customPasses) === 1 ? "pass" : "passes"}
                  </span>
                </div>
                <div className="shred-algo__option-desc">{ALGORITHM_DESCRIPTIONS[a]}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom algorithm controls */}
        {algorithm === "custom" && (
          <div className="shred-field">
            <label className="eyebrow">Custom pattern</label>
            <div className="shred-custom-row">
              <label style={{ fontSize: 12, color: "var(--text-2)" }}>Passes:</label>
              <input
                type="number"
                className="shred-number-input"
                value={customPasses}
                onChange={(e) => onCustomPassesChange(parseInt(e.target.value) || 1)}
                min={1}
                max={100}
                disabled={processing}
              />
              <label style={{ fontSize: 12, color: "var(--text-2)" }}>Pattern (hex):</label>
              <input
                type="text"
                className="shred-pattern-input"
                value={customPattern}
                onChange={(e) => onCustomPatternChange(e.target.value)}
                placeholder="00"
                maxLength={2}
                disabled={processing}
              />
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                00–FF · use random per pass if empty
              </span>
            </div>
          </div>
        )}

        {/* Verification toggle */}
        <div className="shred-field">
          <label className="eyebrow">Post-shred verification</label>
          <div className="preset-group">
            <button
              className={`preset ${verify ? "preset--selected" : ""}`}
              onClick={() => onVerifyChange(true)}
              disabled={processing}
            >
              <div className="preset__label">Verify after shred</div>
            </button>
            <button
              className={`preset ${!verify ? "preset--selected" : ""}`}
              onClick={() => onVerifyChange(false)}
              disabled={processing}
            >
              <div className="preset__label">Skip</div>
            </button>
          </div>
          <div className="shred-field__hint">
            Attempts to read each file back after deletion to confirm it's gone.
          </div>
        </div>

        {/* Action button */}
        <div className="shred-actions">
          <button
            className="btn shred-actions__main shred-actions__main--danger"
            onClick={onShred}
            disabled={!canShred}
          >
            <IconTrash size={16} />
            {processing ? "Shredding…" : `Shred ${items.length} ${items.length === 1 ? "item" : "items"}`}
          </button>
        </div>

        {/* Progress */}
        {processing && progress && (
          <div className="shred-progress">
            <div className="shred-progress__file">
              {progress.file_name} — pass {progress.pass}/{progress.total_passes}
            </div>
            <div className="shred-progress__bar">
              <div className="shred-progress__fill" style={{ width: `${progress.overall_percent}%` }} />
            </div>
            <div className="shred-progress__label">
              <span>File {progress.current_file}/{progress.total_files}</span>
              <span>{progress.overall_percent}%</span>
            </div>
          </div>
        )}

        {/* Result */}
        {result && <ResultBox result={result} />}
      </div>
    </div>
  );
}

// ============================================================
// Wipe tab
// ============================================================

interface WipeTabProps {
  drives: DriveInfo[];
  selectedDrive: string;
  onSelectDrive: (d: string) => void;
  onWipe: () => void;
  processing: boolean;
  wipeResult: WipeResult | null;
  wipeProgress: number;
}

function WipeTab({ drives, selectedDrive, onSelectDrive, onWipe, processing, wipeResult, wipeProgress }: WipeTabProps) {
  const selected = drives.find((d) => d.letter === selectedDrive);

  return (
    <div className="shred-panel" style={{ maxWidth: 560 }}>
      <div className="shred-field">
        <label className="eyebrow">Free-space wipe</label>
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
          Overwrites all unused space on a drive with random data so previously-deleted
          files can't be recovered. Creates a temporary file that grows until the disk
          is full, then deletes it.
        </p>
      </div>

      {drives.length === 0 ? (
        <div className="shred-field__hint">No fixed drives detected.</div>
      ) : (
        <div className="shred-wipe">
          <div className="shred-wipe__header">
            <IconLayers size={16} />
            <span className="shred-wipe__title">Select a drive</span>
          </div>
          <div className="shred-wipe__row">
            <select
              className="shred-wipe__select"
              value={selectedDrive}
              onChange={(e) => onSelectDrive(e.target.value)}
              disabled={processing}
            >
              {drives.map((d) => (
                <option key={d.letter} value={d.letter}>
                  {d.letter} {d.label ? `(${d.label})` : ""} — {formatBytes(d.free_bytes)} free of {formatBytes(d.total_bytes)}
                  {d.is_ssd ? " · SSD" : ""}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <div className="shred-wipe__info">
              {selected.is_ssd ? (
                <span style={{ color: "var(--danger)" }}>
                  SSD detected: wipe may not fully overwrite all free cells due to wear-leveling.
                </span>
              ) : (
                <span>
                  Will overwrite up to {formatBytes(selected.free_bytes)} of free space.
                </span>
              )}
            </div>
          )}
          <div className="shred-actions">
            <button
              className="btn shred-actions__main shred-actions__main--danger"
              onClick={onWipe}
              disabled={!selectedDrive || processing}
            >
              <IconLayers size={16} />
              {processing ? `Wiping… (${wipeProgress} MB)` : "Wipe free space"}
            </button>
          </div>
          {processing && (
            <div className="shred-progress">
              <div className="shred-progress__label">
                <span>Overwriting free space…</span>
                <span>{wipeProgress} MB written</span>
              </div>
            </div>
          )}
          {wipeResult && (
            <div className={`result-box ${wipeResult.errors.length > 0 ? "result-box--warning" : "result-box--success"}`}>
              <div className="result-box__title">
                <IconCheck size={16} />
                Free space wiped
              </div>
              <div className="result-box__detail">
                <span>{formatBytes(wipeResult.bytes_wiped)} overwritten on {wipeResult.drive}</span>
                <span>{wipeResult.duration_ms} ms</span>
                {wipeResult.errors.length > 0 && (
                  <span>{wipeResult.errors.length} errors</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Log tab
// ============================================================

function LogTab({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="shred-panel shred-panel--full">
        <div className="shred-log__empty">
          No shred operations logged yet. Your shred history will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="shred-panel shred-panel--full">
      <div className="shred-log">
        {entries.map((entry, i) => (
          <div key={i} className="shred-log__entry">
            <div className="shred-log__entry-header">
              <span className="shred-log__entry-action">
                {entry.action === "wipe" ? <IconLayers size={13} /> : <IconTrash size={13} />}
                {entry.action === "wipe" ? "Free-space wipe" : "Shred"}
                {entry.verified && <IconCheck size={12} />}
              </span>
              <span className="shred-log__entry-time">{formatTimestamp(entry.timestamp)}</span>
            </div>
            <div className="shred-log__entry-detail">
              {entry.algorithm} · {entry.passes} {entry.passes === 1 ? "pass" : "passes"}
              {entry.files > 0 && ` · ${entry.files} ${entry.files === 1 ? "file" : "files"}`}
              {" · "}{formatBytes(entry.bytes)}
              {" · "}{entry.duration_ms} ms
            </div>
            {entry.paths.length > 0 && (
              <div className="shred-log__entry-paths">
                {entry.paths.slice(0, 3).join(", ")}
                {entry.paths.length > 3 && ` +${entry.paths.length - 3} more`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}

// ============================================================
// Confirmation dialog
// ============================================================

interface ConfirmDialogProps {
  items: WorkItem[];
  algorithm: Algorithm;
  customPasses: number;
  customPattern: string;
  totalSize: number;
  totalPasses: number;
  verify: boolean;
  ssdWarning: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    items, algorithm, totalSize, totalPasses, verify, ssdWarning,
    onCancel, onConfirm,
  } = props;
  const [typed, setTyped] = useState("");
  const canConfirm = typed === "DELETE";

  return (
    <div className="shred-confirm-overlay" onClick={onCancel}>
      <div className="shred-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="shred-confirm__header">
          <span className="shred-confirm__icon">
            <IconWarning size={22} />
          </span>
          <div className="shred-confirm__title">
            Permanently shred {items.length} {items.length === 1 ? "item" : "items"}?
          </div>
        </div>

        <div className="shred-confirm__summary">
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Items</span>
            <span className="shred-confirm__summary-value">
              {items.length} {items.length === 1 ? "item" : "items"}
            </span>
          </div>
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Total size</span>
            <span className="shred-confirm__summary-value">{formatBytes(totalSize)}</span>
          </div>
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Algorithm</span>
            <span className="shred-confirm__summary-value">{ALGORITHM_LABELS[algorithm]}</span>
          </div>
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Passes</span>
            <span className="shred-confirm__summary-value">{totalPasses}</span>
          </div>
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Verification</span>
            <span className="shred-confirm__summary-value">{verify ? "Enabled" : "Skipped"}</span>
          </div>
        </div>

        {ssdWarning === "ssd" && (
          <div className="shred-confirm__warning">
            SSD detected: overwrite-based shredding may not guarantee unrecoverability
            due to wear-leveling. Consider full-disk encryption for true SSD security.
          </div>
        )}

        <div className="shred-confirm__warning">
          This action is irreversible. Files will be overwritten {totalPasses}{" "}
          {totalPasses === 1 ? "time" : "times"} and then deleted. Recovery will be
          impossible.
        </div>

        <div className="shred-confirm__type-row">
          <label className="shred-confirm__type-label">
            Type DELETE to confirm
          </label>
          <input
            type="text"
            className="shred-confirm__type-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder="DELETE"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="shred-confirm__actions">
          <button className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn shred-actions__main--danger"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            <IconTrash size={16} />
            Shred now
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Wipe confirmation dialog
// ============================================================

interface WipeConfirmDialogProps {
  drive: string;
  drives: DriveInfo[];
  onCancel: () => void;
  onConfirm: () => void;
}

function WipeConfirmDialog(props: WipeConfirmDialogProps) {
  const { drive, drives, onCancel, onConfirm } = props;
  const [typed, setTyped] = useState("");
  const canConfirm = typed === "DELETE";
  const selected = drives.find((d) => d.letter === drive);

  return (
    <div className="shred-confirm-overlay" onClick={onCancel}>
      <div className="shred-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="shred-confirm__header">
          <span className="shred-confirm__icon">
            <IconWarning size={22} />
          </span>
          <div className="shred-confirm__title">
            Wipe free space on {drive}?
          </div>
        </div>

        <div className="shred-confirm__summary">
          <div className="shred-confirm__summary-row">
            <span className="shred-confirm__summary-label">Drive</span>
            <span className="shred-confirm__summary-value">
              {drive} {selected?.label ? `(${selected.label})` : ""}
            </span>
          </div>
          {selected && (
            <div className="shred-confirm__summary-row">
              <span className="shred-confirm__summary-label">Free space</span>
              <span className="shred-confirm__summary-value">{formatBytes(selected.free_bytes)}</span>
            </div>
          )}
          {selected && (
            <div className="shred-confirm__summary-row">
              <span className="shred-confirm__summary-label">Drive type</span>
              <span className="shred-confirm__summary-value">{selected.is_ssd ? "SSD" : "HDD"}</span>
            </div>
          )}
        </div>

        {selected?.is_ssd && (
          <div className="shred-confirm__warning">
            SSD detected: wipe may not fully overwrite all free cells due to wear-leveling.
          </div>
        )}

        <div className="shred-confirm__warning">
          This will overwrite all unused space on {drive} with random data. The drive
          may become temporarily unresponsive during the operation. This action cannot
          be undone.
        </div>

        <div className="shred-confirm__type-row">
          <label className="shred-confirm__type-label">
            Type DELETE to confirm
          </label>
          <input
            type="text"
            className="shred-confirm__type-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder="DELETE"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="shred-confirm__actions">
          <button className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn shred-actions__main--danger"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            <IconLayers size={16} />
            Wipe free space
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Result box
// ============================================================

function ResultBox({ result }: { result: ShredResult }) {
  const hasErrors = result.errors.length > 0;
  const allOk = !hasErrors && result.verified;

  return (
    <div className={`result-box ${allOk ? "result-box--success" : hasErrors ? "result-box--error" : "result-box--warning"}`}>
      <div className="result-box__title">
        {allOk ? <IconCheck size={16} /> : <IconWarning size={16} />}
        {allOk
          ? "Shredded successfully"
          : hasErrors
            ? `Shredded with ${result.errors.length} ${result.errors.length === 1 ? "error" : "errors"}`
            : "Shredded (verification skipped)"}
      </div>
      <div className="result-box__detail">
        <span>{result.files_shredded} {result.files_shredded === 1 ? "file" : "files"} shredded</span>
        {result.files_skipped > 0 && (
          <span>{result.files_skipped} skipped</span>
        )}
        <span>{formatBytes(result.bytes_overwritten)} overwritten</span>
        <span>{result.algorithm} · {result.passes} {result.passes === 1 ? "pass" : "passes"}</span>
        <span>{result.duration_ms} ms</span>
        {result.verified && <span>verified</span>}
      </div>
      {hasErrors && (
        <div className="result-box__detail" style={{ marginTop: 6, fontSize: 11, color: "var(--danger)" }}>
          {result.errors.slice(0, 3).join(", ")}
          {result.errors.length > 3 && ` +${result.errors.length - 3} more`}
        </div>
      )}
    </div>
  );
}
