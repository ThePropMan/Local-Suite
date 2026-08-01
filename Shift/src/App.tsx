import { useEffect, useMemo, useState, useCallback } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconCheck,
  IconClose,
  IconFile,
  IconFolder,
  IconRefresh,
  IconTrash,
  IconUpload,
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
  extname,
  fileSize,
  fileModified,
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  collectFilePaths,
  previewRename,
  applyRename,
  undoRename,
  savePreset,
  loadPresets,
  type RenameOp,
  type RenameItem,
  type Preset,
} from "./lib/tauri";
import { ShiftLogo } from "./components/ShiftLogo";

interface WorkFile {
  path: string;
  name: string;
  size: number;
  modified: number | null;
}

interface UiOp {
  id: string;
  enabled: boolean;
  op: RenameOp;
}

const DEFAULT_OP: RenameOp = { type: "find_replace", find: "", replace: "" };

const OP_LABELS: Record<RenameOp["type"], string> = {
  find_replace: "Find & replace",
  add_prefix: "Add prefix",
  add_suffix: "Add suffix",
  insert_at: "Insert at",
  remove_range: "Remove range",
  remove_pattern: "Remove pattern",
  change_case: "Change case",
  number: "Number sequentially",
  date_stamp: "Date stamp",
  web_safe: "Make web-safe",
  truncate: "Truncate",
  change_extension: "Change extension",
};

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [operations, setOperations] = useState<UiOp[]>([{ id: uid(), enabled: true, op: DEFAULT_OP }]);
  const [preview, setPreview] = useState<RenameItem[]>([]);
  const [conflictCount, setConflictCount] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [filterExt, setFilterExt] = useState("");
  const [filterMinSize, setFilterMinSize] = useState<number | "">("");
  const [filterDate, setFilterDate] = useState<"any" | "today" | "week" | "month">("any");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [newPresetName, setNewPresetName] = useState("");
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "shift-recent", max: 20 });

  // Restore settings and saved presets.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<boolean>("recursive").then((v) => v !== undefined && setRecursive(v));
    if (isTauri) {
      loadPresets().then(setPresets).catch(() => {});
    }
  }, []);

  // Rebuild the preview when files or operations change.
  useEffect(() => {
    if (files.length === 0) {
      setPreview([]);
      setConflictCount(0);
      setChangeCount(0);
      return;
    }
    const active = operations.filter((o) => o.enabled).map((o) => o.op);
    let cancelled = false;
    previewRename(
      files.map((f) => f.path),
      active,
    )
      .then((result) => {
        if (cancelled) return;
        setPreview(result.items);
        setConflictCount(result.conflict_count);
        setChangeCount(result.change_count);
      })
      .catch((e) => {
        console.error("[preview]", e);
        showToast(`Preview failed: ${e.message || e}`, "error");
      });
    return () => { cancelled = true; };
  }, [files, operations]);

  // App-level drag-drop
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") {
        document.body.classList.add("dragging");
      } else if (event.type === "leave") {
        document.body.classList.remove("dragging");
      } else if (event.type === "drop") {
        document.body.classList.remove("dragging");
        handlePaths(event.paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Shift] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, [recursive]);

  const handlePaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const collected = await collectFilePaths(paths, recursive);
      if (!collected.length) return;
      const workFiles = await Promise.all(
        collected.map(async (p) => ({
          path: p,
          name: baseNameSync(p),
          size: isTauri ? await fileSize(p).catch(() => 0) : 0,
          modified: isTauri ? await fileModified(p).catch(() => null) : null,
        })),
      );
      setFiles((prev) => [...prev, ...workFiles]);
    } catch (e: any) {
      showToast(`Could not load files: ${e.message || e}`, "error");
    }
  }, [recursive]);

  const handleBrowseFiles = useCallback(async () => {
    const paths = await pickFiles(null, true);
    if (paths.length) handlePaths(paths);
  }, [handlePaths]);

  const handleBrowseFolder = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) handlePaths([dir]);
  }, [handlePaths]);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleRecursiveChange = useCallback(async (v: boolean) => {
    setRecursive(v);
    await setStoreValue("recursive", v);
  }, []);

  const handleAddOperation = useCallback((type: RenameOp["type"]) => {
    let op: RenameOp = DEFAULT_OP;
    switch (type) {
      case "find_replace": op = { type: "find_replace", find: "", replace: "" }; break;
      case "add_prefix": op = { type: "add_prefix", text: "" }; break;
      case "add_suffix": op = { type: "add_suffix", text: "" }; break;
      case "insert_at": op = { type: "insert_at", position: 0, text: "" }; break;
      case "remove_range": op = { type: "remove_range", start: 0, end: 9999 }; break;
      case "remove_pattern": op = { type: "remove_pattern", pattern: "" }; break;
      case "change_case": op = { type: "change_case", mode: "lower" }; break;
      case "number": op = { type: "number", start: 1, step: 1, padding: 3 }; break;
      case "date_stamp": op = { type: "date_stamp", format: "%Y-%m-%d_%H-%M-%S", from_modified: true }; break;
      case "web_safe": op = { type: "web_safe", replace_char: "_" }; break;
      case "truncate": op = { type: "truncate", max_length: 50 }; break;
      case "change_extension": op = { type: "change_extension", new_ext: "" }; break;
    }
    setOperations((prev) => [...prev, { id: uid(), enabled: true, op }]);
  }, []);

  const handleRemoveOperation = useCallback((id: string) => {
    setOperations((prev) => prev.filter((o) => o.id !== id));
  }, []);

  const handleMoveOperation = useCallback((id: string, dir: -1 | 1) => {
    setOperations((prev) => {
      const idx = prev.findIndex((o) => o.id === id);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
  }, []);

  const handleUpdateOperation = useCallback((id: string, op: RenameOp) => {
    setOperations((prev) => prev.map((o) => (o.id === id ? { ...o, op } : o)));
  }, []);

  const handleToggleOperation = useCallback((id: string) => {
    setOperations((prev) => prev.map((o) => (o.id === id ? { ...o, enabled: !o.enabled } : o)));
  }, []);

  const handleClearAll = useCallback(() => {
    setFiles([]);
    setPreview([]);
    setUndoAvailable(false);
  }, []);

  const handleApply = useCallback(async () => {
    if (!preview.length || conflictCount > 0 || processing) return;
    setProcessing(true);
    try {
      const result = await applyRename(preview);
      if (result.errors.length) {
        result.errors.forEach((err) => showToast(err, "error"));
      }
      if (result.renamed > 0) {
        const newPaths = preview.map((i) => i.new_path);
        const newFiles = await Promise.all(
          newPaths.map(async (p) => ({
            path: p,
            name: baseNameSync(p),
            size: isTauri ? await fileSize(p).catch(() => 0) : 0,
            modified: isTauri ? await fileModified(p).catch(() => null) : null,
          })),
        );
        setFiles(newFiles);
        setUndoAvailable(true);
        addRecent({
          name: `${result.renamed} ${result.renamed === 1 ? "file" : "files"}`,
          path: newPaths[0] || "",
          tool: "rename",
          timestamp: Date.now(),
        });
        showToast(`Renamed ${result.renamed} ${result.renamed === 1 ? "file" : "files"}`, "success");
      } else if (result.errors.length === 0) {
        showToast("Nothing to rename", "info");
      }
    } catch (e: any) {
      showToast(`Apply failed: ${e.message || e}`, "error");
    }
    setProcessing(false);
  }, [preview, conflictCount, processing, addRecent]);

  const handleUndo = useCallback(async () => {
    if (processing) return;
    setProcessing(true);
    try {
      const result = await undoRename();
      result.errors.forEach((err) => showToast(err, "error"));
      if (result.restored > 0) {
        const oldPaths = preview.map((i) => i.old_path);
        const newFiles = await Promise.all(
          oldPaths.map(async (p) => ({
            path: p,
            name: baseNameSync(p),
            size: isTauri ? await fileSize(p).catch(() => 0) : 0,
            modified: isTauri ? await fileModified(p).catch(() => null) : null,
          })),
        );
        setFiles(newFiles);
        setUndoAvailable(false);
        showToast(`Undid ${result.restored} rename${result.restored === 1 ? "" : "s"}`, "success");
      }
    } catch (e: any) {
      showToast(`Undo failed: ${e.message || e}`, "error");
    }
    setProcessing(false);
  }, [preview, processing]);

  const handleSavePreset = useCallback(async () => {
    const name = newPresetName.trim();
    if (!name) return;
    const ops = operations.filter((o) => o.enabled).map((o) => o.op);
    try {
      await savePreset(name, ops);
      const list = await loadPresets();
      setPresets(list);
      setNewPresetName("");
      showToast(`Saved preset "${name}"`, "success");
    } catch (e: any) {
      showToast(`Failed to save preset: ${e.message || e}`, "error");
    }
  }, [newPresetName, operations]);

  const handleLoadPreset = useCallback((preset: Preset) => {
    setOperations(preset.operations.map((op) => ({ id: uid(), enabled: true, op })));
    showToast(`Loaded preset "${preset.name}"`, "info");
  }, []);

  const filteredPreview = useMemo(() => {
    const term = filterText.trim().toLowerCase();
    // Build a lookup from path -> WorkFile for metadata-based filters
    const fileMap = new Map(files.map((f) => [f.path, f]));
    // Parse comma-separated extensions into a lowercased set (without dots)
    const extList = filterExt
      .split(",")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    const minBytes = filterMinSize === "" ? 0 : filterMinSize * 1024;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dateCutoff =
      filterDate === "today" ? now - dayMs :
      filterDate === "week" ? now - 7 * dayMs :
      filterDate === "month" ? now - 30 * dayMs :
      0;

    return preview.filter((i) => {
      // Name substring filter
      if (term && !i.old_name.toLowerCase().includes(term) && !i.new_name.toLowerCase().includes(term)) {
        return false;
      }
      // Extension / size / date filters use the original file metadata
      const wf = fileMap.get(i.old_path);
      if (extList.length > 0) {
        const ext = wf ? extname(wf.path) : extname(i.old_path);
        if (!extList.includes(ext)) return false;
      }
      if (minBytes > 0) {
        const sz = wf ? wf.size : 0;
        if (sz < minBytes) return false;
      }
      if (dateCutoff > 0) {
        const mod = wf ? wf.modified : null;
        if (mod === null || mod * 1000 < dateCutoff) return false;
      }
      return true;
    });
  }, [preview, filterText, files, filterExt, filterMinSize, filterDate]);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar appName="Shift" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
        <div className="stage">
          {files.length === 0 ? (
            <DropOverlay
              onBrowse={handleBrowseFiles}
              onBrowseFolder={handleBrowseFolder}
              recent={recent}
              onOpenRecent={(file) => handlePaths([file.path])}
            />
          ) : (
            <WorkingView
              files={files}
              preview={filteredPreview}
              allPreview={preview}
              operations={operations}
              conflictCount={conflictCount}
              changeCount={changeCount}
              processing={processing}
              undoAvailable={undoAvailable}
              filterText={filterText}
              onFilterChange={setFilterText}
              filterExt={filterExt}
              onFilterExtChange={setFilterExt}
              filterMinSize={filterMinSize}
              onFilterMinSizeChange={setFilterMinSize}
              filterDate={filterDate}
              onFilterDateChange={setFilterDate}
              onAddOperation={handleAddOperation}
              onRemoveOperation={handleRemoveOperation}
              onMoveOperation={handleMoveOperation}
              onUpdateOperation={handleUpdateOperation}
              onToggleOperation={handleToggleOperation}
              onApply={handleApply}
              onUndo={handleUndo}
              onAddFiles={handleBrowseFiles}
              onAddFolder={handleBrowseFolder}
              onClearAll={handleClearAll}
              presets={presets}
              newPresetName={newPresetName}
              onNewPresetNameChange={setNewPresetName}
              onSavePreset={handleSavePreset}
              onLoadPreset={handleLoadPreset}
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
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Folders</label>
                <label className="row" style={{ gap: 8, fontSize: 13, color: "var(--text-2)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={recursive}
                    onChange={(e) => handleRecursiveChange(e.target.checked)}
                  />
                  Add folder contents recursively
                </label>
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
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

interface DropOverlayProps {
  onBrowse: () => void;
  onBrowseFolder: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
}

function DropOverlay({ onBrowse, onBrowseFolder, recent, onOpenRecent }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <ShiftLogo />
      <div
        className="drop-zone"
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop files or folders to rename or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Drop files or folders to rename</div>
        <div className="drop-zone__subtext">Or pick from your files</div>
        <div className="row" style={{ marginTop: 6, gap: 8 }}>
          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
            Browse files
          </button>
          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); onBrowseFolder(); }}>
            <IconFolder size={14} /> Add folder
          </button>
        </div>
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
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

interface WorkingViewProps {
  files: WorkFile[];
  preview: RenameItem[];
  allPreview: RenameItem[];
  operations: UiOp[];
  conflictCount: number;
  changeCount: number;
  processing: boolean;
  undoAvailable: boolean;
  filterText: string;
  onFilterChange: (v: string) => void;
  filterExt: string;
  onFilterExtChange: (v: string) => void;
  filterMinSize: number | "";
  onFilterMinSizeChange: (v: number | "") => void;
  filterDate: "any" | "today" | "week" | "month";
  onFilterDateChange: (v: "any" | "today" | "week" | "month") => void;
  onAddOperation: (type: RenameOp["type"]) => void;
  onRemoveOperation: (id: string) => void;
  onMoveOperation: (id: string, dir: -1 | 1) => void;
  onUpdateOperation: (id: string, op: RenameOp) => void;
  onToggleOperation: (id: string) => void;
  onApply: () => void;
  onUndo: () => void;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onClearAll: () => void;
  presets: Preset[];
  newPresetName: string;
  onNewPresetNameChange: (v: string) => void;
  onSavePreset: () => void;
  onLoadPreset: (p: Preset) => void;
}

function WorkingView(props: WorkingViewProps) {
  const {
    files, preview, allPreview, operations, conflictCount, changeCount, processing, undoAvailable,
    filterText, onFilterChange, filterExt, onFilterExtChange, filterMinSize, onFilterMinSizeChange,
    filterDate, onFilterDateChange, onAddOperation, onRemoveOperation, onMoveOperation,
    onUpdateOperation, onToggleOperation, onApply, onUndo, onAddFiles, onAddFolder, onClearAll,
    presets, newPresetName, onNewPresetNameChange, onSavePreset, onLoadPreset,
  } = props;

  return (
    <div className="shift-work">
      <div className="shift-work__topbar">
        <div className="shift-work__topbar-left">
          <span className="shift-work__count">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <span className="shift-work__status">
            {conflictCount > 0 ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}` : `${changeCount} change${changeCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn-ghost" onClick={onAddFiles} disabled={processing}>
            <IconFile size={14} /> Add files
          </button>
          <button className="btn-ghost" onClick={onAddFolder} disabled={processing}>
            <IconFolder size={14} /> Add folder
          </button>
          <button className="btn-ghost" onClick={onClearAll} disabled={processing}>
            <IconTrash size={14} /> Clear
          </button>
        </div>
      </div>

      <div className="shift-work__split">
        <div className="shift-rules">
          <div className="shift-rules__header">
            <span className="eyebrow">Rules</span>
            <select
              className="input input--sm"
              value=""
              onChange={(e) => e.target.value && onAddOperation(e.target.value as RenameOp["type"])}
              style={{ width: "auto" }}
            >
              <option value="">+ Add rule</option>
              {Object.entries(OP_LABELS).map(([type, label]) => (
                <option key={type} value={type}>{label}</option>
              ))}
            </select>
          </div>
          <div className="shift-rules__list">
            {operations.length === 0 && (
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="empty-state__desc">Add a rule to start renaming.</div>
              </div>
            )}
            {operations.map((op, idx) => (
              <RuleCard
                key={op.id}
                index={idx}
                total={operations.length}
                uiOp={op}
                onUpdate={(o) => onUpdateOperation(op.id, o)}
                onRemove={() => onRemoveOperation(op.id)}
                onMove={(dir) => onMoveOperation(op.id, dir)}
                onToggle={() => onToggleOperation(op.id)}
              />
            ))}
          </div>

          <div className="shift-presets">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Presets</div>
            <div className="row" style={{ gap: 6, marginBottom: 8 }}>
              <input
                className="input"
                placeholder="Preset name"
                value={newPresetName}
                onChange={(e) => onNewPresetNameChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSavePreset()}
              />
              <button className="btn btn--secondary btn--sm" onClick={onSavePreset} disabled={!newPresetName.trim()}>
                Save
              </button>
            </div>
            {presets.length > 0 && (
              <div className="preset-group" style={{ justifyContent: "flex-start" }}>
                {presets.map((p, i) => (
                  <button key={i} className="preset" onClick={() => onLoadPreset(p)}>
                    <div className="preset__label">{p.name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="shift-preview">
          <div className="shift-preview__header">
            <span className="eyebrow">Preview</span>
            <input
              className="input input--sm"
              placeholder="Filter names"
              value={filterText}
              onChange={(e) => onFilterChange(e.target.value)}
              style={{ width: 140 }}
            />
          </div>
          <div className="shift-preview__filters">
            <input
              className="input input--sm"
              placeholder="Ext: jpg,png"
              value={filterExt}
              onChange={(e) => onFilterExtChange(e.target.value)}
              style={{ width: 120 }}
            />
            <input
              type="number"
              min={0}
              className="input input--sm"
              placeholder="Min KB"
              value={filterMinSize}
              onChange={(e) => onFilterMinSizeChange(e.target.value === "" ? "" : Number(e.target.value))}
              style={{ width: 90 }}
            />
            <select
              className="input input--sm"
              value={filterDate}
              onChange={(e) => onFilterDateChange(e.target.value as "any" | "today" | "week" | "month")}
              style={{ width: "auto" }}
            >
              <option value="any">Any date</option>
              <option value="today">Modified today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
          </div>
          <div className="shift-preview__table-wrap">
            <table className="shift-preview__table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Original</th>
                  <th style={{ width: 24 }}></th>
                  <th>New</th>
                  <th style={{ width: 80 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((item) => {
                  const realIndex = allPreview.indexOf(item);
                  return (
                    <tr key={realIndex} className={item.conflict ? "shift-preview__row--conflict" : ""}>
                      <td className="text-3">{realIndex + 1}</td>
                      <td className="ellipsis" title={item.old_name}>{item.old_name}</td>
                      <td className="text-3">→</td>
                      <td className="ellipsis" title={item.new_name}>
                        {item.old_name !== item.new_name ? (
                          <DiffName oldName={item.old_name} newName={item.new_name} />
                        ) : (
                          item.new_name
                        )}
                      </td>
                      <td>
                        {item.conflict ? (
                          <span className="shift-status shift-status--conflict"><IconClose size={12} /> Conflict</span>
                        ) : item.status === "no_change" ? (
                          <span className="shift-status shift-status--none">No change</span>
                        ) : (
                          <span className="shift-status shift-status--ok"><IconCheck size={12} /> OK</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {preview.length === 0 && (
                  <tr>
                    <td colSpan={5} className="shift-preview__empty">No files match the filter</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="shift-work__actions">
            <button
              className="btn btn--primary"
              onClick={onApply}
              disabled={processing || conflictCount > 0 || changeCount === 0}
            >
              Apply {changeCount > 0 ? `(${changeCount})` : ""}
            </button>
            <button
              className="btn btn--secondary"
              onClick={onUndo}
              disabled={processing || !undoAvailable}
            >
              <IconRefresh size={14} /> Undo last
            </button>
            {conflictCount > 0 && (
              <span className="danger" style={{ fontSize: 12 }}>Fix {conflictCount} conflict{conflictCount === 1 ? "" : "s"} before applying</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RuleCardProps {
  index: number;
  total: number;
  uiOp: UiOp;
  onUpdate: (op: RenameOp) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onToggle: () => void;
}

function RuleCard({ index, total, uiOp, onUpdate, onRemove, onMove, onToggle }: RuleCardProps) {
  const op = uiOp.op;
  return (
    <div className={`shift-rule ${!uiOp.enabled ? "shift-rule--disabled" : ""}`}>
      <div className="shift-rule__bar">
        <label className="row" style={{ gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={uiOp.enabled} onChange={onToggle} />
          <span className="shift-rule__number">{index + 1}</span>
        </label>
        <select
          className="input input--sm"
          value={op.type}
          onChange={(e) => {
            const type = e.target.value as RenameOp["type"];
            let next: RenameOp = { type: "find_replace", find: "", replace: "" };
            switch (type) {
              case "find_replace": next = { type, find: "", replace: "" }; break;
              case "add_prefix": next = { type, text: "" }; break;
              case "add_suffix": next = { type, text: "" }; break;
              case "insert_at": next = { type, position: 0, text: "" }; break;
              case "remove_range": next = { type, start: 0, end: 9999 }; break;
              case "remove_pattern": next = { type, pattern: "" }; break;
              case "change_case": next = { type, mode: "lower" }; break;
              case "number": next = { type, start: 1, step: 1, padding: 3 }; break;
              case "date_stamp": next = { type, format: "%Y-%m-%d_%H-%M-%S", from_modified: true }; break;
              case "web_safe": next = { type, replace_char: "_" }; break;
              case "truncate": next = { type, max_length: 50 }; break;
              case "change_extension": next = { type, new_ext: "" }; break;
            }
            onUpdate(next);
          }}
        >
          {Object.entries(OP_LABELS).map(([type, label]) => (
            <option key={type} value={type}>{label}</option>
          ))}
        </select>
        <div className="shift-rule__controls">
          <button className="btn-ghost" disabled={index === 0} onClick={() => onMove(-1)} title="Move up">▲</button>
          <button className="btn-ghost" disabled={index === total - 1} onClick={() => onMove(1)} title="Move down">▼</button>
          <button className="btn-ghost" onClick={onRemove} title="Remove"><IconTrash size={14} /></button>
        </div>
      </div>
      <div className="shift-rule__fields">
        {op.type === "find_replace" && (
          <>
            <input className="input" placeholder="Find" value={op.find} onChange={(e) => onUpdate({ ...op, find: e.target.value })} />
            <input className="input" placeholder="Replace" value={op.replace} onChange={(e) => onUpdate({ ...op, replace: e.target.value })} />
            <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--text-2)" }}>
              <input type="checkbox" checked={op.use_regex || false} onChange={(e) => onUpdate({ ...op, use_regex: e.target.checked })} />
              Regex
            </label>
          </>
        )}
        {op.type === "add_prefix" && (
          <input className="input" placeholder="Prefix" value={op.text} onChange={(e) => onUpdate({ ...op, text: e.target.value })} />
        )}
        {op.type === "add_suffix" && (
          <input className="input" placeholder="Suffix" value={op.text} onChange={(e) => onUpdate({ ...op, text: e.target.value })} />
        )}
        {op.type === "insert_at" && (
          <div className="row" style={{ gap: 6 }}>
            <input type="number" min={0} className="input" placeholder="Position" value={op.position} onChange={(e) => onUpdate({ ...op, position: Number(e.target.value) })} style={{ width: 80 }} />
            <input className="input" placeholder="Text" value={op.text} onChange={(e) => onUpdate({ ...op, text: e.target.value })} />
          </div>
        )}
        {op.type === "remove_range" && (
          <div className="row" style={{ gap: 6 }}>
            <input type="number" min={0} className="input" placeholder="Start" value={op.start} onChange={(e) => onUpdate({ ...op, start: Number(e.target.value) })} style={{ width: 80 }} />
            <input type="number" min={0} className="input" placeholder="End" value={op.end ?? ""} onChange={(e) => onUpdate({ ...op, end: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 80 }} />
          </div>
        )}
        {op.type === "remove_pattern" && (
          <>
            <input className="input" placeholder="Pattern" value={op.pattern} onChange={(e) => onUpdate({ ...op, pattern: e.target.value })} />
            <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--text-2)" }}>
              <input type="checkbox" checked={op.use_regex || false} onChange={(e) => onUpdate({ ...op, use_regex: e.target.checked })} />
              Regex
            </label>
          </>
        )}
        {op.type === "change_case" && (
          <select className="input" value={op.mode} onChange={(e) => onUpdate({ ...op, mode: e.target.value as any })}>
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="title">Title Case</option>
            <option value="sentence">Sentence case</option>
          </select>
        )}
        {op.type === "number" && (
          <div className="row" style={{ gap: 6 }}>
            <input type="number" min={0} className="input" placeholder="Start" value={op.start} onChange={(e) => onUpdate({ ...op, start: Number(e.target.value) })} style={{ width: 80 }} />
            <input type="number" min={1} className="input" placeholder="Step" value={op.step ?? 1} onChange={(e) => onUpdate({ ...op, step: Number(e.target.value) })} style={{ width: 80 }} />
            <input type="number" min={0} className="input" placeholder="Padding" value={op.padding ?? 0} onChange={(e) => onUpdate({ ...op, padding: Number(e.target.value) })} style={{ width: 80 }} />
          </div>
        )}
        {op.type === "date_stamp" && (
          <div className="row" style={{ gap: 6 }}>
            <input className="input" placeholder="e.g. %Y-%m-%d" value={op.format} onChange={(e) => onUpdate({ ...op, format: e.target.value })} />
            <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={op.from_modified || false} onChange={(e) => onUpdate({ ...op, from_modified: e.target.checked })} />
              From file date
            </label>
          </div>
        )}
        {op.type === "web_safe" && (
          <input className="input" placeholder="Replacement character" maxLength={1} value={op.replace_char ?? "_"} onChange={(e) => onUpdate({ ...op, replace_char: e.target.value })} style={{ width: 120 }} />
        )}
        {op.type === "truncate" && (
          <input type="number" min={1} className="input" placeholder="Max length" value={op.max_length} onChange={(e) => onUpdate({ ...op, max_length: Number(e.target.value) })} style={{ width: 120 }} />
        )}
        {op.type === "change_extension" && (
          <input className="input" placeholder="New extension (without dot)" value={op.new_ext} onChange={(e) => onUpdate({ ...op, new_ext: e.target.value })} />
        )}
      </div>
    </div>
  );
}

/**
 * Render the new name with the changed characters highlighted. The shared
 * prefix and suffix stay plain, while the middle section gets a highlight span.
 */
function DiffName({ oldName, newName }: { oldName: string; newName: string }) {
  const oldChars = Array.from(oldName);
  const newChars = Array.from(newName);
  const minLen = Math.min(oldChars.length, newChars.length);

  // Common prefix length
  let prefix = 0;
  while (prefix < minLen && oldChars[prefix] === newChars[prefix]) {
    prefix++;
  }

  // Common suffix length (not overlapping the prefix)
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix++;
  }

  const before = newChars.slice(0, prefix).join("");
  const changed = newChars.slice(prefix, newChars.length - suffix).join("");
  const after = newChars.slice(newChars.length - suffix).join("");

  return (
    <>
      {before}
      {changed && <span className="diff-highlight">{changed}</span>}
      {after}
    </>
  );
}
