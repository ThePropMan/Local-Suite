import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconClose,
  IconCopy,
  IconGrid,
  IconList,
  IconPlus,
  IconSettings,
  IconTrash,
  IconEye,
} from "./shared/components/icons";
import {
  getStoreValue,
  setStoreValue,
  applyTheme,
  isTauri,
  type Theme,
} from "./shared/lib/tauri";
import {
  captureLoupeRegion,
  cancelPick,
  startPick,
  getHistory,
  clearHistory,
  loadPalettes,
  savePalette,
  deletePalette,
  exportPalette,
  hexToRgb,
  formatColor,
  type ColorEntry,
  type Palette,
  type LoupeData,
  type CopyFormat,
} from "./lib/tauri";

type Tab = "history" | "palettes" | "settings";

// Route between the main window and the loupe window.

export default function App() {
  const [windowLabel, setWindowLabel] = useState<string>("main");

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    setWindowLabel(win.label);
  }, []);

  if (windowLabel === "loupe") {
    return <LoupeWindow />;
  }
  return <MainWindow />;
}

// Main window for history, palettes, and settings.

function MainWindow() {
  const [tab, setTab] = useState<Tab>("history");
  const [theme, setTheme] = useState<Theme>("system");
  const [copyFormat, setCopyFormat] = useState<CopyFormat>("hex");
  const [history, setHistory] = useState<ColorEntry[]>([]);
  const [palettes, setPalettes] = useState<Palette[]>([]);
  const [hotkey, setHotkey] = useState("Ctrl+Shift+C");

  // Restore settings and load saved colors.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) { setTheme(t); applyTheme(t); }
    });
    getStoreValue<CopyFormat>("copyFormat").then((v) => v && setCopyFormat(v));
    getStoreValue<string>("hotkey").then((v) => v && setHotkey(v));
    if (isTauri) {
      getHistory().then(setHistory).catch(() => {});
      loadPalettes().then(setPalettes).catch(() => {});
    }
  }, []);

  // Refresh history from the loupe event. Rust sends the updated list with the
  // event, so there is no second disk read or window-to-window race.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen<{ history: ColorEntry[] }>(
        "lens://color-picked",
        (event) => {
          if (event.payload.history) {
            setHistory(event.payload.history);
          }
        }
      );
    };
    setup();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleCopyFormatChange = useCallback(async (f: CopyFormat) => {
    setCopyFormat(f);
    await setStoreValue("copyFormat", f);
  }, []);

  const handleHotkeyChange = useCallback(async (h: string) => {
    setHotkey(h);
    await setStoreValue("hotkey", h);
  }, []);

  const handleCopyColor = useCallback(async (_hex: string, r: number, g: number, b: number) => {
    const text = formatColor(r, g, b, copyFormat);
    try {
      if (isTauri) {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      showToast(`Copied ${text}`, "success");
    } catch (e: any) {
      showToast(`Copy failed: ${e.message || e}`, "error");
    }
  }, [copyFormat]);

  const handlePickNow = useCallback(async () => {
    if (!isTauri) return;
    // Start the same loupe flow used by the global hotkey. The native click
    // thread captures the color, updates history, and emits the event.
    try {
      await startPick();
    } catch (e: any) {
      showToast(`Pick failed: ${e.message || e}`, "error");
    }
  }, []);

  const handleClearHistory = useCallback(async () => {
    if (!isTauri) return;
    await clearHistory();
    setHistory([]);
    showToast("History cleared", "info");
  }, []);

  const handleCreatePalette = useCallback(async () => {
    const name = `Palette ${palettes.length + 1}`;
    const palette: Palette = {
      id: `pal_${Date.now()}`,
      name,
      colors: [],
      created: Date.now(),
    };
    const updated = await savePalette(palette);
    setPalettes(updated);
    showToast(`Created "${name}"`, "success");
  }, [palettes]);

  const handleAddColorToPalette = useCallback(async (paletteId: string, hex: string) => {
    const palette = palettes.find((p) => p.id === paletteId);
    if (!palette) return;
    if (palette.colors.includes(hex)) {
      showToast("Color already in palette", "info");
      return;
    }
    const updated = await savePalette({ ...palette, colors: [...palette.colors, hex] });
    setPalettes(updated);
    showToast(`Added ${hex} to "${palette.name}"`, "success");
  }, [palettes]);

  const handleRemoveColorFromPalette = useCallback(async (paletteId: string, hex: string) => {
    const palette = palettes.find((p) => p.id === paletteId);
    if (!palette) return;
    const updated = await savePalette({ ...palette, colors: palette.colors.filter((c) => c !== hex) });
    setPalettes(updated);
  }, [palettes]);

  const handleDeletePalette = useCallback(async (id: string) => {
    const updated = await deletePalette(id);
    setPalettes(updated);
    showToast("Palette deleted", "info");
  }, []);

  const handleExportPalette = useCallback(async (palette: Palette, format: "json" | "css") => {
    try {
      const content = await exportPalette(palette, format);
      if (isTauri) {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(content);
        showToast(`Exported as ${format.toUpperCase()} to clipboard`, "success");
      }
    } catch (e: any) {
      showToast(`Export failed: ${e.message || e}`, "error");
    }
  }, []);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar
          appName="Lens"
          crumb={tab === "history" ? "History" : tab === "palettes" ? "Palettes" : "Settings"}
        />
        <div className="lens-stage">
          {/* Tab bar */}
          <div className="lens-tabs">
            <button
              className={`lens-tabs__btn ${tab === "history" ? "lens-tabs__btn--active" : ""}`}
              onClick={() => setTab("history")}
            >
              <IconList size={14} />
              History
            </button>
            <button
              className={`lens-tabs__btn ${tab === "palettes" ? "lens-tabs__btn--active" : ""}`}
              onClick={() => setTab("palettes")}
            >
              <IconGrid size={14} />
              Palettes
            </button>
            <button
              className={`lens-tabs__btn ${tab === "settings" ? "lens-tabs__btn--active" : ""}`}
              onClick={() => setTab("settings")}
            >
              <IconSettings size={14} />
              Settings
            </button>
          </div>

          {/* Pick button (always visible) */}
          <div className="lens-pick-bar">
            <button className="btn btn--primary btn--block" onClick={handlePickNow}>
              <IconEye size={15} />
              Pick color (Ctrl+Shift+C)
            </button>
          </div>

          {/* Tab content */}
          <div className="lens-content">
            {tab === "history" && (
              <HistoryTab
                history={history}
                copyFormat={copyFormat}
                onCopy={handleCopyColor}
                onClear={handleClearHistory}
                onAddToPalette={(hex) => {
                  if (palettes.length > 0) {
                    handleAddColorToPalette(palettes[0].id, hex);
                  } else {
                    showToast("Create a palette first", "info");
                  }
                }}
              />
            )}
            {tab === "palettes" && (
              <PalettesTab
                palettes={palettes}
                history={history}
                onCreate={handleCreatePalette}
                onAddColor={handleAddColorToPalette}
                onRemoveColor={handleRemoveColorFromPalette}
                onDelete={handleDeletePalette}
                onExport={handleExportPalette}
                onCopy={handleCopyColor}
              />
            )}
            {tab === "settings" && (
              <SettingsTab
                theme={theme}
                onThemeChange={handleThemeChange}
                copyFormat={copyFormat}
                onCopyFormatChange={handleCopyFormatChange}
                hotkey={hotkey}
                onHotkeyChange={handleHotkeyChange}
              />
            )}
          </div>
        </div>
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

// ============================================================
// History tab
// ============================================================

interface HistoryTabProps {
  history: ColorEntry[];
  copyFormat: CopyFormat;
  onCopy: (hex: string, r: number, g: number, b: number) => void;
  onClear: () => void;
  onAddToPalette: (hex: string) => void;
}

function HistoryTab({ history, copyFormat, onCopy, onClear, onAddToPalette }: HistoryTabProps) {
  if (history.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__title">No colors picked yet</div>
        <div className="empty-state__desc">
          Press Ctrl+Shift+C to pick a color from anywhere on screen.
        </div>
      </div>
    );
  }
  return (
    <div className="lens-history">
      <div className="lens-history__header">
        <span className="lens-history__count">{history.length} colors</span>
        <button className="btn-ghost" onClick={onClear}>
          <IconTrash size={13} />
          Clear
        </button>
      </div>
      <div className="lens-history__grid">
        {history.map((entry, i) => (
          <ColorSwatch
            key={i}
            hex={entry.hex}
            r={entry.r}
            g={entry.g}
            b={entry.b}
            copyFormat={copyFormat}
            onCopy={onCopy}
            onAddToPalette={onAddToPalette}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Color swatch (shared between history and palettes)
// ============================================================

interface ColorSwatchProps {
  hex: string;
  r: number;
  g: number;
  b: number;
  copyFormat: CopyFormat;
  onCopy: (hex: string, r: number, g: number, b: number) => void;
  onAddToPalette?: (hex: string) => void;
  onRemove?: (hex: string) => void;
}

function ColorSwatch({ hex, r, g, b, copyFormat, onCopy, onAddToPalette, onRemove }: ColorSwatchProps) {
  const [expanded, setExpanded] = useState(false);
  const text = formatColor(r, g, b, copyFormat);
  return (
    <div className="color-swatch" onClick={() => setExpanded(!expanded)}>
      <div className="color-swatch__color" style={{ background: hex }} />
      <div className="color-swatch__body">
        <div className="color-swatch__hex">{hex}</div>
        <div className="color-swatch__format">{text}</div>
      </div>
      {expanded && (
        <div className="color-swatch__actions">
          <button className="btn-ghost btn--sm" onClick={(e) => { e.stopPropagation(); onCopy(hex, r, g, b); }}>
            <IconCopy size={12} />
            Copy
          </button>
          {onAddToPalette && (
            <button className="btn-ghost btn--sm" onClick={(e) => { e.stopPropagation(); onAddToPalette(hex); }}>
              <IconPlus size={12} />
              Add to palette
            </button>
          )}
          {onRemove && (
            <button className="btn-ghost btn--sm" onClick={(e) => { e.stopPropagation(); onRemove(hex); }}>
              <IconClose size={12} />
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Palettes tab
// ============================================================

interface PalettesTabProps {
  palettes: Palette[];
  history: ColorEntry[];
  onCreate: () => void;
  onAddColor: (paletteId: string, hex: string) => void;
  onRemoveColor: (paletteId: string, hex: string) => void;
  onDelete: (id: string) => void;
  onExport: (palette: Palette, format: "json" | "css") => void;
  onCopy: (hex: string, r: number, g: number, b: number) => void;
}

function PalettesTab({
  palettes, history, onCreate, onAddColor, onRemoveColor, onDelete, onExport, onCopy,
}: PalettesTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(palettes[0]?.id ?? null);

  useEffect(() => {
    if (palettes.length > 0 && !palettes.find((p) => p.id === selectedId)) {
      setSelectedId(palettes[0].id);
    }
  }, [palettes, selectedId]);

  const selected = palettes.find((p) => p.id === selectedId);

  if (palettes.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__title">No palettes yet</div>
        <div className="empty-state__desc">
          Create a palette to organize your favorite colors.
        </div>
        <button className="btn btn--secondary" style={{ marginTop: 12 }} onClick={onCreate}>
          <IconPlus size={14} />
          New palette
        </button>
      </div>
    );
  }

  return (
    <div className="lens-palettes">
      <div className="lens-palettes__sidebar">
        <button className="btn-ghost btn--block" onClick={onCreate} style={{ marginBottom: 8 }}>
          <IconPlus size={13} />
          New palette
        </button>
        {palettes.map((p) => (
          <button
            key={p.id}
            className={`lens-palettes__item ${selectedId === p.id ? "lens-palettes__item--active" : ""}`}
            onClick={() => setSelectedId(p.id)}
          >
            <span className="lens-palettes__item-name">{p.name}</span>
            <span className="lens-palettes__item-count">{p.colors.length}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="lens-palettes__detail">
          <div className="lens-palettes__detail-header">
            <span className="lens-palettes__detail-name">{selected.name}</span>
            <div className="lens-palettes__detail-actions">
              <button className="btn-ghost btn--sm" onClick={() => onExport(selected, "css")}>
                <IconCopy size={12} />
                CSS
              </button>
              <button className="btn-ghost btn--sm" onClick={() => onExport(selected, "json")}>
                <IconCopy size={12} />
                JSON
              </button>
              <button className="btn-ghost btn--sm" onClick={() => onDelete(selected.id)}>
                <IconTrash size={12} />
                Delete
              </button>
            </div>
          </div>

          {selected.colors.length > 0 ? (
            <div className="lens-palettes__colors">
              {selected.colors.map((hex) => {
                const [r, g, b] = hexToRgb(hex);
                return (
                  <ColorSwatch
                    key={hex}
                    hex={hex}
                    r={r}
                    g={g}
                    b={b}
                    copyFormat="hex"
                    onCopy={onCopy}
                    onRemove={(h) => onRemoveColor(selected.id, h)}
                  />
                );
              })}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "24px 12px" }}>
              <div className="empty-state__desc">Add colors from history or by picking.</div>
            </div>
          )}

          {/* Quick add from history */}
          {history.length > 0 && (
            <div className="lens-palettes__quick-add">
              <div className="eyebrow" style={{ marginBottom: 8 }}>From history</div>
              <div className="lens-palettes__quick-grid">
                {history.slice(0, 12).map((entry, i) => (
                  <button
                    key={i}
                    className="lens-palettes__quick-swatch"
                    style={{ background: entry.hex }}
                    title={entry.hex}
                    onClick={() => onAddColor(selected.id, entry.hex)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Settings tab
// ============================================================

interface SettingsTabProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  copyFormat: CopyFormat;
  onCopyFormatChange: (f: CopyFormat) => void;
  hotkey: string;
  onHotkeyChange: (h: string) => void;
}

function SettingsTab({ theme, onThemeChange, copyFormat, onCopyFormatChange, hotkey, onHotkeyChange }: SettingsTabProps) {
  return (
    <div className="lens-settings">
      <div className="lens-settings__section">
        <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>Theme</label>
        <div className="preset-group">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button
              key={t}
              className={`preset ${theme === t ? "preset--selected" : ""}`}
              onClick={() => onThemeChange(t)}
            >
              <div className="preset__label">{t === "system" ? "System" : t === "light" ? "Light" : "Dark"}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="lens-settings__section">
        <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>Default copy format</label>
        <div className="preset-group">
          {(["hex", "rgb", "hsl"] as CopyFormat[]).map((f) => (
            <button
              key={f}
              className={`preset ${copyFormat === f ? "preset--selected" : ""}`}
              onClick={() => onCopyFormatChange(f)}
            >
              <div className="preset__label">{f.toUpperCase()}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="lens-settings__section">
        <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>Hotkey</label>
        <input
          className="input"
          value={hotkey}
          onChange={(e) => onHotkeyChange(e.target.value)}
          placeholder="Ctrl+Shift+C"
        />
        <p className="lens-settings__hint">
          Restart required after changing the hotkey. Default: Ctrl+Shift+C
        </p>
      </div>

      <div className="lens-settings__section">
        <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>About</label>
        <p className="lens-settings__hint">
          Lens is a screen color picker. Press the hotkey to activate the magnifying loupe,
          then click to pick a color. Colors are copied to clipboard and saved to history.
        </p>
        <p className="lens-settings__hint" style={{ marginTop: 6 }}>
          Lens stays in your system tray. Closing the window hides it — use the tray to quit.
        </p>
      </div>
    </div>
  );
}

// Loupe window for the magnified pixel view.

function LoupeWindow() {
  const [loupeData, setLoupeData] = useState<LoupeData | null>(null);

  // Poll for loupe data (cursor position + captured region).
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let raf = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const data = await captureLoupeRegion(15);
        if (!cancelled) {
          setLoupeData(data);
          raf = window.setTimeout(poll, 16);
        }
      } catch (e) {
        console.error("[loupe] capture error:", e);
        raf = window.setTimeout(poll, 50);
      }
    };
    poll();

    return () => {
      cancelled = true;
      clearTimeout(raf);
    };
  }, []);

  // The native click detector handles capture and history. This window only
  // copies the picked color, using the RGB values in the event payload.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await listen<{ hex: string; r: number; g: number; b: number }>(
        "lens://color-picked",
        async (event) => {
          try {
            const fmt = await getStoreValue<CopyFormat>("copyFormat") ?? "hex";
            const text = formatColor(event.payload.r, event.payload.g, event.payload.b, fmt);
            const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(text);
          } catch (e) {
            console.error("[loupe] clipboard error:", e);
          }
        }
      );
    };
    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Listen for pick-cancelled event (right-click).
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen("lens://pick-cancelled", () => {});
    };
    setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Keyboard: Esc to cancel (Enter is handled by native click detection).
  useEffect(() => {
    if (!isTauri) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelPick().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Render the loupe as a canvas.
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || !loupeData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height, pixels } = loupeData;
    canvas.width = width;
    canvas.height = height;
    const imageData = ctx.createImageData(width, height);
    for (let i = 0; i < pixels.length; i++) {
      imageData.data[i] = pixels[i];
    }
    ctx.putImageData(imageData, 0, 0);
  }, [loupeData]);

  if (!loupeData) {
    return <div className="loupe-loading" />;
  }

  const centerHex = loupeData.center_hex;
  const [r, g, b] = [loupeData.center_r, loupeData.center_g, loupeData.center_b];

  return (
    <div className="loupe">
      <div className="loupe__canvas-wrap">
        <canvas
          ref={canvasRef}
          className="loupe__canvas"
          style={{ imageRendering: "pixelated", width: 120, height: 120 }}
        />
        {/* Crosshair overlay */}
        <div className="loupe__crosshair loupe__crosshair--h" />
        <div className="loupe__crosshair loupe__crosshair--v" />
        <div className="loupe__center-box" />
      </div>
      <div className="loupe__readout" style={{ background: centerHex }}>
        <span className="loupe__hex" style={{ color: getContrastColor(r, g, b) }}>
          {centerHex}
        </span>
      </div>
      <div className="loupe__hint">Click to pick · Right-click or Esc to cancel</div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function getContrastColor(r: number, g: number, b: number): string {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#FFFFFF";
}
