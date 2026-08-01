import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconBrand,
  IconClose,
  IconCopy,
  IconSettings,
  IconTrash,
  IconPin,
  IconSearch,
  IconSun,
  IconMoon,
  IconMonitor,
  IconRefresh,
} from "./shared/components/icons";
import {
  applyTheme,
  getStoreValue,
  setStoreValue,
  isTauri,
  type Theme,
} from "./shared/lib/tauri";
import {
  getRecent,
  searchHistory,
  pinEntry,
  unpinEntry,
  deleteEntry,
  clearHistory,
  pasteEntry,
  getSettings,
  setSettings as setSettingsCmd,
  getStats,
  setHotkey,
  type ClipboardEntry,
  type ClipSettings,
  type ClipStats,
} from "./lib/tauri";

// ---------- helpers ----------

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- main app ----------

export default function App() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<ClipSettings | null>(null);
  const [stats, setStats] = useState<ClipStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [autostart, setAutostart] = useState(false);
  const [selected, setSelected] = useState(0);
  const [hotkeyDraft, setHotkeyDraft] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ----- load persisted theme + settings + autostart on mount -----
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) { setTheme(t); applyTheme(t); }
    });
    refreshSettings();
    refreshStats();
    if (isTauri) autostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
      setHotkeyDraft(s.hotkey);
    } catch (e: any) {
      showToast(`Failed to load settings: ${e.message || e}`, "error");
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try { setStats(await getStats()); } catch { /* ignore */ }
  }, []);

  const refreshEntries = useCallback(async () => {
    try {
      const list = query.trim()
        ? await searchHistory(query)
        : await getRecent(200);
      setEntries(list);
    } catch (e: any) {
      showToast(`Failed to load history: ${e.message || e}`, "error");
    }
  }, [query]);

  // ----- reload entries when query changes (debounced) -----
  useEffect(() => {
    const t = setTimeout(refreshEntries, 60);
    return () => clearTimeout(t);
  }, [query, refreshEntries]);

  // ----- clamp selection when entries change -----
  useEffect(() => {
    setSelected((s) => (entries.length === 0 ? 0 : Math.min(s, entries.length - 1)));
  }, [entries]);

  // ----- scroll active entry into view -----
  useEffect(() => {
    if (showSettings) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, entries, showSettings]);

  // ----- listen for new entries from the Rust monitor -----
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    listen("clip://new-entry", () => {
      // Only refresh if we're showing the unfiltered recent list.
      setQuery((q) => {
        if (!q.trim()) void refreshEntries();
        return q;
      });
      void refreshStats();
    }).then((fn) => (unlisten = fn)).catch(() => {});
    return () => { unlisten?.(); };
  }, [refreshEntries, refreshStats]);

  // ----- on window focus (shown via hotkey/tray): refresh + focus search -----
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        setQuery("");
        void refreshEntries();
        void refreshStats();
        // focus search on the next tick after render
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    }).then((fn) => (unlisten = fn)).catch(() => {});
    return () => { unlisten?.(); };
  }, [refreshEntries, refreshStats]);

  // ----- actions -----
  const hideWindow = useCallback(() => {
    if (isTauri) void getCurrentWindow().hide();
  }, []);

  const handlePaste = useCallback(async (entry: ClipboardEntry) => {
    try {
      await pasteEntry(entry.id, settings?.paste_as_plain_text ?? true);
    } catch (e: any) {
      showToast(`Paste failed: ${e.message || e}`, "error");
    }
  }, [settings]);

  const handleTogglePin = useCallback(async (entry: ClipboardEntry) => {
    try {
      if (entry.pinned) await unpinEntry(entry.id);
      else await pinEntry(entry.id);
      await refreshEntries();
      void refreshStats();
    } catch (e: any) {
      showToast(`Pin failed: ${e.message || e}`, "error");
    }
  }, [refreshEntries, refreshStats]);

  const handleDelete = useCallback(async (entry: ClipboardEntry) => {
    try {
      await deleteEntry(entry.id);
      await refreshEntries();
      void refreshStats();
    } catch (e: any) {
      showToast(`Delete failed: ${e.message || e}`, "error");
    }
  }, [refreshEntries, refreshStats]);

  const handleClear = useCallback(async () => {
    if (!entries.some((e) => !e.pinned)) {
      showToast("Nothing to clear (pinned entries are kept)", "info");
      return;
    }
    try {
      await clearHistory();
      await refreshEntries();
      void refreshStats();
      showToast("Cleared history", "success");
    } catch (e: any) {
      showToast(`Clear failed: ${e.message || e}`, "error");
    }
  }, [entries, refreshEntries, refreshStats]);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleSettingsChange = useCallback(async (patch: Partial<ClipSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await setSettingsCmd(next);
      void refreshStats();
    } catch (e: any) {
      showToast(`Failed to save setting: ${e.message || e}`, "error");
    }
  }, [settings, refreshStats]);

  const handleAutostartChange = useCallback(async (on: boolean) => {
    try {
      if (on) await enableAutostart();
      else await disableAutostart();
      setAutostart(on);
    } catch (e: any) {
      showToast(`Autostart change failed: ${e.message || e}`, "error");
    }
  }, []);

  const handleApplyHotkey = useCallback(async () => {
    const hk = hotkeyDraft.trim();
    if (!hk) { showToast("Hotkey cannot be empty", "error"); return; }
    try {
      const active = await setHotkey(hk);
      setSettings((s) => (s ? { ...s, hotkey: active } : s));
      showToast(`Hotkey set to ${active}`, "success");
    } catch (e: any) {
      showToast(`Hotkey change failed: ${e.message || e}`, "error");
      void refreshSettings();
    }
  }, [hotkeyDraft, refreshSettings]);

  // ----- keyboard navigation (search input keeps focus) -----
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); hideWindow(); return; }
    if (entries.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void handlePaste(entry);
    } else if (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void handleTogglePin(entry);
    }
  }, [entries, selected, hideWindow, handlePaste, handleTogglePin]);

  const pinned = useMemo(() => entries.filter((e) => e.pinned), [entries]);

  return (
    <ErrorBoundary>
      <div className="clip">
        <header className="clip__header" data-tauri-drag-region>
          <span className="clip__brand">
            <span className="clip__brand-mark" aria-hidden="true"><IconBrand size={11} /></span>
            Clip
          </span>
          <div className="clip__header-controls">
            <button
              className={`clip__icon-btn ${showSettings ? "clip__icon-btn--active" : ""}`}
              aria-label="Settings"
              title="Settings"
              onClick={() => setShowSettings((s) => !s)}
            >
              <IconSettings size={15} />
            </button>
            <button
              className="clip__icon-btn"
              aria-label="Hide"
              title="Hide"
              onClick={hideWindow}
            >
              <IconClose size={15} />
            </button>
          </div>
        </header>

        {showSettings ? (
          <SettingsView
            theme={theme}
            onThemeChange={handleThemeChange}
            settings={settings}
            onSettingsChange={handleSettingsChange}
            autostart={autostart}
            onAutostartChange={handleAutostartChange}
            hotkeyDraft={hotkeyDraft}
            onHotkeyDraftChange={setHotkeyDraft}
            onApplyHotkey={handleApplyHotkey}
            onClear={handleClear}
            stats={stats}
          />
        ) : (
          <>
            <div className="clip__search">
              <IconSearch size={15} className="clip__search-icon" />
              <input
                ref={searchRef}
                className="clip__search-input"
                placeholder="Search clipboard history…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                autoFocus
                spellCheck={false}
              />
              {entries.length > 0 && (
                <span className="clip__search-count">{entries.length}</span>
              )}
            </div>

            <div className="clip__list" ref={listRef}>
              {entries.length === 0 ? (
                <EmptyState hasQuery={query.trim().length > 0} monitoring={settings?.monitoring_enabled ?? true} />
              ) : (
                <>
                  {pinned.length > 0 && (
                    <div className="clip__section-label">
                      <IconPin size={11} /> Pinned
                    </div>
                  )}
                  {entries.map((entry, idx) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      index={idx}
                      active={idx === selected}
                      onPaste={handlePaste}
                      onTogglePin={handleTogglePin}
                      onDelete={handleDelete}
                      onMouseEnter={() => setSelected(idx)}
                    />
                  ))}
                </>
              )}
            </div>

            <footer className="clip__footer">
              <span className="clip__stats">
                {stats ? `${stats.total} entries · ${stats.pinned} pinned · limit ${stats.limit}` : "—"}
              </span>
              <button
                className="clip__footer-btn"
                onClick={handleClear}
                disabled={!entries.some((e) => !e.pinned)}
                title="Clear all non-pinned entries"
              >
                <IconTrash size={13} /> Clear
              </button>
            </footer>
          </>
        )}

        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

// ---------- entry row ----------

interface EntryRowProps {
  entry: ClipboardEntry;
  index: number;
  active: boolean;
  onPaste: (e: ClipboardEntry) => void;
  onTogglePin: (e: ClipboardEntry) => void;
  onDelete: (e: ClipboardEntry) => void;
  onMouseEnter: () => void;
}

function EntryRow({ entry, index, active, onPaste, onTogglePin, onDelete, onMouseEnter }: EntryRowProps) {
  return (
    <div
      className={`clip__entry ${active ? "clip__entry--active" : ""} ${entry.pinned ? "clip__entry--pinned" : ""}`}
      data-idx={index}
      onMouseEnter={onMouseEnter}
      onClick={() => onPaste(entry)}
      role="button"
      tabIndex={-1}
      title="Click or press Enter to paste"
    >
      <div className="clip__entry-body">
        <div className="clip__entry-preview">{entry.preview || "(empty)"}</div>
        <div className="clip__entry-meta">
          <span>{timeAgo(entry.created_at)}</span>
          <span className="clip__entry-dot">·</span>
          <span>{entry.char_count.toLocaleString()} chars</span>
          {entry.pinned && <><span className="clip__entry-dot">·</span><span className="clip__entry-pin">pinned</span></>}
        </div>
      </div>
      <div className="clip__entry-actions">
        <button
          className="clip__entry-btn"
          aria-label={entry.pinned ? "Unpin" : "Pin"}
          title={entry.pinned ? "Unpin (Ctrl+P)" : "Pin (Ctrl+P)"}
          onClick={(e) => { e.stopPropagation(); onTogglePin(entry); }}
        >
          <IconPin size={13} />
        </button>
        <button
          className="clip__entry-btn"
          aria-label="Paste and dismiss"
          title="Paste from clipboard"
          onClick={(e) => { e.stopPropagation(); onPaste(entry); }}
        >
          <IconCopy size={13} />
        </button>
        <button
          className="clip__entry-btn clip__entry-btn--danger"
          aria-label="Delete"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
        >
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  );
}

// ---------- empty state ----------

function EmptyState({ hasQuery, monitoring }: { hasQuery: boolean; monitoring: boolean }) {
  return (
    <div className="clip__empty">
      {hasQuery ? (
        <>
          <IconSearch size={26} />
          <div className="clip__empty-title">No matches</div>
          <div className="clip__empty-sub">Try a different search term.</div>
        </>
      ) : monitoring ? (
        <>
          <IconCopy size={26} />
          <div className="clip__empty-title">Nothing copied yet</div>
          <div className="clip__empty-sub">Copy text anywhere and it will show up here.</div>
        </>
      ) : (
        <>
          <IconRefresh size={26} />
          <div className="clip__empty-title">Monitoring is off</div>
          <div className="clip__empty-sub">Enable clipboard monitoring in settings.</div>
        </>
      )}
    </div>
  );
}

// ---------- settings view ----------

interface SettingsViewProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  settings: ClipSettings | null;
  onSettingsChange: (patch: Partial<ClipSettings>) => void;
  autostart: boolean;
  onAutostartChange: (on: boolean) => void;
  hotkeyDraft: string;
  onHotkeyDraftChange: (v: string) => void;
  onApplyHotkey: () => void;
  onClear: () => void;
  stats: ClipStats | null;
}

function SettingsView(props: SettingsViewProps) {
  const {
    theme, onThemeChange, settings, onSettingsChange,
    autostart, onAutostartChange, hotkeyDraft, onHotkeyDraftChange,
    onApplyHotkey, onClear, stats,
  } = props;

  return (
    <div className="clip__settings">
      <div className="clip__settings-section">
        <div className="clip__settings-title">Theme</div>
        <div className="preset-group clip__theme-group">
          <button className={`preset ${theme === "system" ? "preset--selected" : ""}`} onClick={() => onThemeChange("system")}>
            <div className="preset__label"><IconMonitor size={13} /> System</div>
          </button>
          <button className={`preset ${theme === "light" ? "preset--selected" : ""}`} onClick={() => onThemeChange("light")}>
            <div className="preset__label"><IconSun size={13} /> Light</div>
          </button>
          <button className={`preset ${theme === "dark" ? "preset--selected" : ""}`} onClick={() => onThemeChange("dark")}>
            <div className="preset__label"><IconMoon size={13} /> Dark</div>
          </button>
        </div>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">History limit</div>
        <div className="clip__settings-row">
          <input
            className="input input--sm clip__settings-number"
            type="number"
            min={50}
            max={5000}
            step={50}
            value={settings?.history_limit ?? 500}
            onChange={(e) => onSettingsChange({ history_limit: Math.max(50, Math.min(5000, Number(e.target.value) || 500)) })}
          />
          <span className="clip__settings-hint">entries kept (50–5000)</span>
        </div>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">Clipboard monitoring</div>
        <label className="clip__toggle">
          <input
            type="checkbox"
            checked={settings?.monitoring_enabled ?? true}
            onChange={(e) => onSettingsChange({ monitoring_enabled: e.target.checked })}
          />
          <span>Capture copied text automatically</span>
        </label>
        <p className="clip__settings-note">
          Sensitive strings that look like passwords are skipped automatically.
        </p>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">Paste behavior</div>
        <label className="clip__toggle">
          <input
            type="checkbox"
            checked={settings?.paste_as_plain_text ?? true}
            onChange={(e) => onSettingsChange({ paste_as_plain_text: e.target.checked })}
          />
          <span>Paste as plain text (strip formatting)</span>
        </label>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">Hotkey</div>
        <div className="clip__settings-row">
          <input
            className="input input--sm clip__settings-hotkey"
            value={hotkeyDraft}
            onChange={(e) => onHotkeyDraftChange(e.target.value)}
            placeholder="Ctrl+Shift+V"
            spellCheck={false}
          />
          <button className="btn btn--secondary btn--sm" onClick={onApplyHotkey}>Apply</button>
        </div>
        <p className="clip__settings-note">
          Use Tauri syntax, e.g. <code>Ctrl+Shift+V</code>, <code>CommandOrControl+Alt+C</code>.
        </p>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">Startup</div>
        <label className="clip__toggle">
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => onAutostartChange(e.target.checked)}
          />
          <span>Launch Clip when you sign in</span>
        </label>
      </div>

      <div className="clip__settings-section">
        <div className="clip__settings-title">Storage</div>
        <p className="clip__settings-note">
          {stats ? `${stats.total} entries stored (${stats.pinned} pinned), limit ${stats.limit}.` : "—"}
          {" History is encrypted at rest with AES-256-GCM."}
        </p>
        <button className="btn btn--danger btn--sm clip__settings-clear" onClick={onClear}>
          <IconTrash size={13} /> Clear non-pinned history
        </button>
      </div>
    </div>
  );
}
