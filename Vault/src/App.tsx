import { useEffect, useState, useCallback, useRef } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconLock,
  IconClose,
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconTrash,
  IconRefresh,
  IconDownload,
  IconUpload,
  IconShield,
  IconSearch,
} from "./shared/components/icons";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  isTauri,
  type Theme,
} from "./shared/lib/tauri";
import {
  vaultExists,
  createVault,
  unlockVault,
  lockVault,
  isUnlocked,
  getEntries,
  saveEntry,
  deleteEntry,
  generatePassword,
  estimateStrength,
  changeMasterPassword,
  exportVault,
  importVault,
  copyToClipboard,
  clearClipboard,
  type VaultEntry,
  type GenOptions,
} from "./lib/tauri";
import { VaultLogo } from "./components/VaultLogo";

type View = "locked" | "list" | "editor";

const STRENGTH_LABELS = [
  { min: 0, label: "Very weak", color: "var(--danger)" },
  { min: 40, label: "Weak", color: "var(--danger)" },
  { min: 60, label: "Fair", color: "var(--warning, #c4892f)" },
  { min: 80, label: "Good", color: "var(--success, #4a8)" },
  { min: 120, label: "Strong", color: "var(--success, #4a8)" },
];

function strengthInfo(bits: number) {
  let info = STRENGTH_LABELS[0];
  for (const s of STRENGTH_LABELS) {
    if (bits >= s.min) info = s;
  }
  return info;
}

function newEntry(): VaultEntry {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: crypto.randomUUID(),
    title: "",
    username: "",
    password: "",
    url: null,
    notes: null,
    folder: null,
    tags: [],
    created: now,
    modified: now,
  };
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [view, setView] = useState<View>("locked");
  const [exists, setExists] = useState(false);
  const [masterPw, setMasterPw] = useState("");
  const [masterPw2, setMasterPw2] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<VaultEntry | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [clipCountdown, setClipCountdown] = useState(0);
  const [genOpts, setGenOpts] = useState<GenOptions>({
    length: 20,
    useUppercase: true,
    useLowercase: true,
    useDigits: true,
    useSymbols: true,
    excludeAmbiguous: false,
  });
  const [genResult, setGenResult] = useState("");
  const [genBits, setGenBits] = useState(0);
  const [autoLockMin, setAutoLockMin] = useState(5);
  const [clipClearSec, setClipClearSec] = useState(30);
  const lastActivityRef = useRef<number>(Date.now());

  // ---- Init ----
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) { setTheme(t); applyTheme(t); }
    });
    getStoreValue<number>("autoLockMin").then((v) => v && setAutoLockMin(v));
    getStoreValue<number>("clipClearSec").then((v) => v && setClipClearSec(v));
    getStoreValue<GenOptions>("genOpts").then((v) => v && setGenOpts(v));

    if (!isTauri) return;
    vaultExists().then(setExists);
    isUnlocked().then((unlocked) => {
      if (unlocked) {
        loadEntries();
        setView("list");
      }
    });
  }, []);

  // ---- Auto-lock ----
  useEffect(() => {
    if (view === "locked") return;
    const interval = setInterval(() => {
      const idle = (Date.now() - lastActivityRef.current) / 1000;
      if (idle > autoLockMin * 60) {
        handleLock();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [view, autoLockMin]);

  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // ---- Clipboard auto-clear ----
  // Interval decrements the countdown every second; when it hits zero,
  // clearClipboard() is called. The countdown is reset by handleCopy.
  useEffect(() => {
    if (clipCountdown <= 0) return;
    const interval = setInterval(() => {
      setClipCountdown((c) => {
        if (c <= 1) {
          if (isTauri) clearClipboard().catch(() => {});
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [clipCountdown]);

  // ---- Vault operations ----
  const loadEntries = useCallback(async () => {
    try {
      const e = await getEntries();
      setEntries(e);
    } catch (err) {
      showToast(`Failed to load entries: ${err}`, "error");
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (masterPw.length < 8) {
      setUnlockError("Master password must be at least 8 characters");
      return;
    }
    if (masterPw !== masterPw2) {
      setUnlockError("Passwords don't match");
      return;
    }
    setBusy(true);
    setUnlockError(null);
    try {
      await createVault(masterPw);
      setExists(true);
      setMasterPw("");
      setMasterPw2("");
      await loadEntries();
      setView("list");
      showToast("Vault created", "success");
    } catch (err) {
      setUnlockError(String(err));
    } finally {
      setBusy(false);
    }
  }, [masterPw, masterPw2, loadEntries]);

  const handleUnlock = useCallback(async () => {
    if (!masterPw) return;
    setBusy(true);
    setUnlockError(null);
    try {
      await unlockVault(masterPw);
      setMasterPw("");
      await loadEntries();
      setView("list");
      bumpActivity();
    } catch (err) {
      setUnlockError("Invalid master password");
    } finally {
      setBusy(false);
    }
  }, [masterPw, loadEntries, bumpActivity]);

  const handleLock = useCallback(async () => {
    try {
      await lockVault();
    } catch {}
    setView("locked");
    setEntries([]);
    setSelected(null);
    setShowPw(false);
    setShowSettings(false);
  }, []);

  const handleSaveEntry = useCallback(async (entry: VaultEntry) => {
    try {
      const toSave = { ...entry, modified: Math.floor(Date.now() / 1000) };
      await saveEntry(toSave);
      await loadEntries();
      setSelected(null);
      setView("list");
      showToast("Entry saved", "success");
      bumpActivity();
    } catch (err) {
      showToast(`Failed to save: ${err}`, "error");
    }
  }, [loadEntries, bumpActivity]);

  const handleDeleteEntry = useCallback(async (id: string) => {
    try {
      await deleteEntry(id);
      await loadEntries();
      setSelected(null);
      setView("list");
      showToast("Entry deleted", "success");
      bumpActivity();
    } catch (err) {
      showToast(`Failed to delete: ${err}`, "error");
    }
  }, [loadEntries, bumpActivity]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    if (!text) return;
    await copyToClipboard(text);
    showToast(`Copied ${label}`, "success");
    bumpActivity();
    setClipCountdown(clipClearSec);
  }, [clipClearSec, bumpActivity]);

  const handleGenerate = useCallback(async () => {
    try {
      const pw = await generatePassword(genOpts);
      setGenResult(pw);
      const bits = await estimateStrength(pw);
      setGenBits(bits);
    } catch (err) {
      showToast(`Generator error: ${err}`, "error");
    }
  }, [genOpts]);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleAutoLockChange = useCallback(async (m: number) => {
    setAutoLockMin(m);
    await setStoreValue("autoLockMin", m);
  }, []);

  const handleClipClearChange = useCallback(async (s: number) => {
    setClipClearSec(s);
    await setStoreValue("clipClearSec", s);
  }, []);

  const handleGenOptsChange = useCallback(async (opts: GenOptions) => {
    setGenOpts(opts);
    await setStoreValue("genOpts", opts);
  }, []);

  const handleChangeMasterPw = useCallback(async (oldPw: string, newPw: string) => {
    if (newPw.length < 8) {
      showToast("New password must be at least 8 characters", "error");
      return;
    }
    try {
      await changeMasterPassword(oldPw, newPw);
      showToast("Master password changed", "success");
    } catch (err) {
      showToast(`Failed: ${String(err)}`, "error");
    }
  }, []);

  const handleExport = useCallback(async (format: "json" | "csv") => {
    try {
      const data = await exportVault(format);
      if (isTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({
          defaultPath: `vault-export.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (path) {
          await writeTextFile(path, data);
          showToast("Exported", "success");
        }
      }
      bumpActivity();
    } catch (err) {
      showToast(`Export failed: ${err}`, "error");
    }
  }, [bumpActivity]);

  const handleImport = useCallback(async (format: "json" | "csv") => {
    try {
      if (!isTauri) return;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path || Array.isArray(path)) return;
      const data = await readTextFile(path as string);
      const count = await importVault(data, format);
      await loadEntries();
      showToast(`Imported ${count} entries`, "success");
      bumpActivity();
    } catch (err) {
      showToast(`Import failed: ${err}`, "error");
    }
  }, [loadEntries, bumpActivity]);

  // ---- Filtered entries ----
  const filtered = entries.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q) ||
      (e.url ?? "").toLowerCase().includes(q) ||
      (e.folder ?? "").toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  // ---- Render ----
  if (view === "locked") {
    return (
      <ErrorBoundary>
        <div className="app">
          <TitleBar appName="Vault" />
          <div className="stage">
            <div className="vault-lock">
              <VaultLogo />
              <div className="vault-lock__form">
                <div className="vault-lock__icon">
                  <IconLock size={28} />
                </div>
                <h2 className="vault-lock__title">
                  {exists ? "Unlock your vault" : "Create your vault"}
                </h2>
                <p className="vault-lock__sub">
                  {exists
                    ? "Enter your master password to access your entries."
                    : "Choose a strong master password. It encrypts your vault and cannot be recovered."}
                </p>
                <input
                  className="vault-input"
                  type="password"
                  placeholder="Master password"
                  value={masterPw}
                  onChange={(e) => setMasterPw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (exists) handleUnlock();
                      else if (masterPw2) handleCreate();
                    }
                  }}
                  autoFocus
                />
                {!exists && (
                  <input
                    className="vault-input"
                    type="password"
                    placeholder="Confirm master password"
                    value={masterPw2}
                    onChange={(e) => setMasterPw2(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && masterPw) handleCreate();
                    }}
                  />
                )}
                {unlockError && (
                  <div className="vault-lock__error">{unlockError}</div>
                )}
                <button
                  className="btn btn--primary vault-lock__btn"
                  onClick={exists ? handleUnlock : handleCreate}
                  disabled={busy || !masterPw}
                >
                  {busy ? "..." : exists ? "Unlock" : "Create vault"}
                </button>
              </div>
            </div>
          </div>
          <ToastContainer />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar
          appName="Vault"
          crumb={selected ? selected.title || "New entry" : undefined}
          showSettings={showSettings}
          onToggleSettings={() => setShowSettings((s) => !s)}
          right={
            <button
              className="titlebar__icon-btn"
              aria-label="Lock vault"
              title="Lock vault"
              onClick={handleLock}
            >
              <IconLock size={16} />
            </button>
          }
        />
        <div className="stage" onClick={bumpActivity} onKeyDown={bumpActivity}>
          {showSettings && (
            <SettingsPanel
              theme={theme}
              onThemeChange={handleThemeChange}
              autoLockMin={autoLockMin}
              onAutoLockChange={handleAutoLockChange}
              clipClearSec={clipClearSec}
              onClipClearChange={handleClipClearChange}
              onChangeMasterPw={handleChangeMasterPw}
              onExport={handleExport}
              onImport={handleImport}
              onClose={() => setShowSettings(false)}
            />
          )}
          {view === "list" && (
            <ListView
              entries={filtered}
              allCount={entries.length}
              search={search}
              onSearch={(s) => { setSearch(s); bumpActivity(); }}
              onSelect={(e) => { setSelected(e); setView("editor"); setShowPw(false); bumpActivity(); }}
              onNew={() => { setSelected(newEntry()); setView("editor"); setShowPw(false); bumpActivity(); }}
              onCopy={handleCopy}
              onLock={handleLock}
              clipCountdown={clipCountdown}
            />
          )}
          {view === "editor" && selected && (
            <EditorView
              entry={selected}
              showPw={showPw}
              onTogglePw={() => setShowPw((s) => !s)}
              onSave={handleSaveEntry}
              onDelete={() => handleDeleteEntry(selected.id)}
              onCancel={() => { setSelected(null); setView("list"); }}
              onCopy={handleCopy}
              genOpts={genOpts}
              onGenOptsChange={handleGenOptsChange}
              onGenerate={handleGenerate}
              genResult={genResult}
              genBits={genBits}
              onUseGenerated={(pw) => {
                setSelected((s) => s ? { ...s, password: pw } : s);
                setGenResult("");
              }}
            />
          )}
        </div>
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

// ============================================================
// List View
// ============================================================

interface ListProps {
  entries: VaultEntry[];
  allCount: number;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (e: VaultEntry) => void;
  onNew: () => void;
  onCopy: (text: string, label: string) => void;
  onLock: () => void;
  clipCountdown: number;
}

function ListView({ entries, allCount, search, onSearch, onSelect, onNew, onCopy, clipCountdown }: ListProps) {
  return (
    <div className="vault-list">
      <div className="vault-list__topbar">
        <div className="vault-search">
          <IconSearch size={16} />
          <input
            className="vault-search__input"
            placeholder="Search entries..."
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <button className="btn btn--primary vault-list__add" onClick={onNew}>
          <IconPlus size={16} />
          New
        </button>
      </div>
      {clipCountdown > 0 && (
        <div className="vault-clip-bar">
          Clipboard will clear in {clipCountdown}s
        </div>
      )}
      <div className="vault-list__body">
        {entries.length === 0 ? (
          <div className="vault-empty">
            <IconShield size={32} />
            <p className="vault-empty__title">
              {allCount === 0 ? "No entries yet" : "No matches"}
            </p>
            <p className="vault-empty__sub">
              {allCount === 0
                ? "Click New to add your first password."
                : "Try a different search."}
            </p>
          </div>
        ) : (
          entries.map((e) => (
            <button
              key={e.id}
              className="vault-entry"
              onClick={() => onSelect(e)}
            >
              <div className="vault-entry__icon">
                <div className="vault-entry__avatar">
                  {(e.title || "?").charAt(0).toUpperCase()}
                </div>
              </div>
              <div className="vault-entry__body">
                <div className="vault-entry__title">{e.title || "Untitled"}</div>
                <div className="vault-entry__sub">{e.username || "No username"}</div>
              </div>
              <div className="vault-entry__actions">
                <button
                  className="vault-entry__copy"
                  title="Copy password"
                  onClick={(ev) => { ev.stopPropagation(); onCopy(e.password, "password"); }}
                >
                  <IconCopy size={15} />
                </button>
                <button
                  className="vault-entry__copy"
                  title="Copy username"
                  onClick={(ev) => { ev.stopPropagation(); onCopy(e.username, "username"); }}
                >
                  <IconCopy size={15} />
                </button>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// Editor View
// ============================================================

interface EditorProps {
  entry: VaultEntry;
  showPw: boolean;
  onTogglePw: () => void;
  onSave: (e: VaultEntry) => void;
  onDelete: () => void;
  onCancel: () => void;
  onCopy: (text: string, label: string) => void;
  genOpts: GenOptions;
  onGenOptsChange: (o: GenOptions) => void;
  onGenerate: () => void;
  genResult: string;
  genBits: number;
  onUseGenerated: (pw: string) => void;
}

function EditorView({
  entry, showPw, onTogglePw, onSave, onDelete, onCancel, onCopy,
  genOpts, onGenOptsChange, onGenerate, genResult, genBits, onUseGenerated,
}: EditorProps) {
  const [draft, setDraft] = useState<VaultEntry>(entry);
  const [tagsInput, setTagsInput] = useState(entry.tags.join(", "));
  const [showGen, setShowGen] = useState(false);

  useEffect(() => {
    setDraft(entry);
    setTagsInput(entry.tags.join(", "));
  }, [entry.id]);

  const update = (field: keyof VaultEntry, value: string | null) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const handleSave = () => {
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    onSave({ ...draft, tags });
  };

  const si = strengthInfo(genBits);

  return (
    <div className="vault-editor">
      <div className="vault-editor__body">
        <div className="vault-field">
          <label className="vault-field__label">Title</label>
          <input
            className="vault-input"
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="e.g. GitHub"
            autoFocus
          />
        </div>
        <div className="vault-field">
          <label className="vault-field__label">Username</label>
          <div className="vault-field__row">
            <input
              className="vault-input"
              value={draft.username}
              onChange={(e) => update("username", e.target.value)}
              placeholder="email or username"
            />
            <button
              className="vault-field__btn"
              title="Copy username"
              onClick={() => onCopy(draft.username, "username")}
              disabled={!draft.username}
            >
              <IconCopy size={16} />
            </button>
          </div>
        </div>
        <div className="vault-field">
          <label className="vault-field__label">Password</label>
          <div className="vault-field__row">
            <input
              className="vault-input vault-input--mono"
              type={showPw ? "text" : "password"}
              value={draft.password}
              onChange={(e) => update("password", e.target.value)}
              placeholder="password"
            />
            <button
              className="vault-field__btn"
              title={showPw ? "Hide" : "Show"}
              onClick={onTogglePw}
            >
              {showPw ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button
              className="vault-field__btn"
              title="Copy password"
              onClick={() => onCopy(draft.password, "password")}
              disabled={!draft.password}
            >
              <IconCopy size={16} />
            </button>
            <button
              className="vault-field__btn"
              title="Generate"
              onClick={() => setShowGen((s) => !s)}
            >
              <IconRefresh size={16} />
            </button>
          </div>
          {showGen && (
            <div className="vault-gen">
              <div className="vault-gen__opts">
                <label className="vault-gen__opt">
                  Length
                  <input
                    className="vault-number"
                    type="number"
                    min={4}
                    max={128}
                    value={genOpts.length ?? 20}
                    onChange={(e) => onGenOptsChange({ ...genOpts, length: parseInt(e.target.value) || 20 })}
                  />
                </label>
                <label className="vault-gen__check">
                  <input
                    type="checkbox"
                    checked={genOpts.useUppercase ?? true}
                    onChange={(e) => onGenOptsChange({ ...genOpts, useUppercase: e.target.checked })}
                  />
                  A-Z
                </label>
                <label className="vault-gen__check">
                  <input
                    type="checkbox"
                    checked={genOpts.useLowercase ?? true}
                    onChange={(e) => onGenOptsChange({ ...genOpts, useLowercase: e.target.checked })}
                  />
                  a-z
                </label>
                <label className="vault-gen__check">
                  <input
                    type="checkbox"
                    checked={genOpts.useDigits ?? true}
                    onChange={(e) => onGenOptsChange({ ...genOpts, useDigits: e.target.checked })}
                  />
                  0-9
                </label>
                <label className="vault-gen__check">
                  <input
                    type="checkbox"
                    checked={genOpts.useSymbols ?? true}
                    onChange={(e) => onGenOptsChange({ ...genOpts, useSymbols: e.target.checked })}
                  />
                  !@#
                </label>
                <label className="vault-gen__check">
                  <input
                    type="checkbox"
                    checked={genOpts.excludeAmbiguous ?? false}
                    onChange={(e) => onGenOptsChange({ ...genOpts, excludeAmbiguous: e.target.checked })}
                  />
                  No ambiguous
                </label>
              </div>
              <div className="vault-gen__actions">
                <button className="btn btn--secondary" onClick={onGenerate}>
                  <IconRefresh size={14} />
                  Generate
                </button>
              </div>
              {genResult && (
                <div className="vault-gen__result">
                  <code className="vault-gen__pw">{genResult}</code>
                  <div className="vault-gen__strength">
                    <span style={{ color: si.color }}>{si.label}</span>
                    <span className="vault-gen__bits">{genBits.toFixed(0)} bits</span>
                  </div>
                  <div className="vault-gen__bar">
                    <div
                      className="vault-gen__bar-fill"
                      style={{
                        width: `${Math.min(100, (genBits / 128) * 100)}%`,
                        background: si.color,
                      }}
                    />
                  </div>
                  <button
                    className="btn btn--primary vault-gen__use"
                    onClick={() => { onUseGenerated(genResult); setShowGen(false); }}
                  >
                    Use this password
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="vault-field">
          <label className="vault-field__label">URL</label>
          <input
            className="vault-input"
            value={draft.url ?? ""}
            onChange={(e) => update("url", e.target.value || null)}
            placeholder="https://..."
          />
        </div>
        <div className="vault-field">
          <label className="vault-field__label">Folder</label>
          <input
            className="vault-input"
            value={draft.folder ?? ""}
            onChange={(e) => update("folder", e.target.value || null)}
            placeholder="e.g. Work, Personal"
          />
        </div>
        <div className="vault-field">
          <label className="vault-field__label">Tags</label>
          <input
            className="vault-input"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="comma, separated, tags"
          />
        </div>
        <div className="vault-field">
          <label className="vault-field__label">Notes</label>
          <textarea
            className="vault-input vault-input--area"
            value={draft.notes ?? ""}
            onChange={(e) => update("notes", e.target.value || null)}
            placeholder="Secure notes..."
            rows={4}
          />
        </div>
      </div>
      <div className="vault-editor__footer">
        <button
          className="btn vault-editor__delete"
          onClick={onDelete}
          title="Delete entry"
        >
          <IconTrash size={16} />
        </button>
        <div className="vault-editor__footer-right">
          <button className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSave}>
            <IconCheck size={16} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Settings Panel
// ============================================================

interface SettingsProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  autoLockMin: number;
  onAutoLockChange: (m: number) => void;
  clipClearSec: number;
  onClipClearChange: (s: number) => void;
  onChangeMasterPw: (old: string, newPw: string) => void;
  onExport: (f: "json" | "csv") => void;
  onImport: (f: "json" | "csv") => void;
  onClose: () => void;
}

function SettingsPanel({
  theme, onThemeChange, autoLockMin, onAutoLockChange,
  clipClearSec, onClipClearChange, onChangeMasterPw,
  onExport, onImport, onClose,
}: SettingsProps) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");

  return (
    <div className="vault-settings-overlay" onClick={onClose}>
      <div className="vault-settings" onClick={(e) => e.stopPropagation()}>
        <div className="vault-settings__head">
          <h2>Settings</h2>
          <button className="vault-settings__close" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="vault-settings__body">
          <div className="vault-settings__group">
            <label className="vault-settings__label">Theme</label>
            <div className="vault-settings__row">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={`vault-settings__pill ${theme === t ? "vault-settings__pill--active" : ""}`}
                  onClick={() => onThemeChange(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="vault-settings__group">
            <label className="vault-settings__label">Auto-lock (minutes)</label>
            <input
              className="vault-input vault-number"
              type="number"
              min={1}
              max={120}
              value={autoLockMin}
              onChange={(e) => onAutoLockChange(parseInt(e.target.value) || 5)}
            />
          </div>
          <div className="vault-settings__group">
            <label className="vault-settings__label">Clipboard auto-clear (seconds)</label>
            <input
              className="vault-input vault-number"
              type="number"
              min={5}
              max={300}
              value={clipClearSec}
              onChange={(e) => onClipClearChange(parseInt(e.target.value) || 30)}
            />
          </div>
          <div className="vault-settings__divider" />
          <div className="vault-settings__group">
            <label className="vault-settings__label">Change master password</label>
            <input
              className="vault-input"
              type="password"
              placeholder="Current password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
            />
            <input
              className="vault-input"
              type="password"
              placeholder="New password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <input
              className="vault-input"
              type="password"
              placeholder="Confirm new password"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
            />
            <button
              className="btn btn--secondary"
              disabled={!oldPw || !newPw || newPw !== newPw2}
              onClick={() => {
                onChangeMasterPw(oldPw, newPw);
                setOldPw(""); setNewPw(""); setNewPw2("");
              }}
            >
              Change password
            </button>
          </div>
          <div className="vault-settings__divider" />
          <div className="vault-settings__group">
            <label className="vault-settings__label">Import / Export</label>
            <div className="vault-settings__row">
              <button className="btn btn--secondary" onClick={() => onExport("json")}>
                <IconDownload size={15} />
                Export JSON
              </button>
              <button className="btn btn--secondary" onClick={() => onExport("csv")}>
                <IconDownload size={15} />
                Export CSV
              </button>
            </div>
            <div className="vault-settings__row">
              <button className="btn btn--secondary" onClick={() => onImport("json")}>
                <IconUpload size={15} />
                Import JSON
              </button>
              <button className="btn btn--secondary" onClick={() => onImport("csv")}>
                <IconUpload size={15} />
                Import CSV
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
