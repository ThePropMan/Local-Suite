import { useEffect, useState, useCallback, useMemo } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconClose,
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconGrid,
  IconImage,
  IconLink,
  IconMapPin,
  IconMail,
  IconPhone,
  IconPlus,
  IconRefresh,
  IconShield,
  IconUpload,
  IconWifi,
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
  type Theme,
} from "./shared/lib/tauri";
import type { RecentFile } from "./shared/types";
import {
  generateQr,
  generateQrBatch,
  generatePdf,
  savePreset,
  loadPresets,
  deletePreset,
  DEFAULT_OPTIONS,
  type QrOptions,
  type QrResult,
  type BatchRow,
  type BatchItem,
  type EcLevel,
  type Preset,
} from "./lib/tauri";
import {
  QR_TYPES,
  QR_FIELDS,
  encodeQrPayload,
  payloadSummary,
  type QrType,
} from "./lib/qrTypes";
import { MarkLogo } from "./components/MarkLogo";

type View = "home" | "generate" | "batch";

const SIZE_OPTIONS = [256, 512, 1024, 2048];
const EC_OPTIONS: EcLevel[] = ["L", "M", "Q", "H"];

// ---------- color helpers ----------

function rgbaToHex(c: [number, number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgba(hex: string, a = 255): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0, a];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function svgToBytes(svg: string): Uint8Array {
  return new TextEncoder().encode(svg);
}

function sanitizeFileName(s: string): string {
  return (s || "qr").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "qr";
}

// ---------- type icon mapping ----------

function typeIcon(type: QrType, size = 22) {
  switch (type) {
    case "url": return <IconLink size={size} />;
    case "text": return <IconFile size={size} />;
    case "wifi": return <IconWifi size={size} />;
    case "vcard": return <IconFile size={size} />;
    case "email": return <IconMail size={size} />;
    case "phone": return <IconPhone size={size} />;
    case "sms": return <IconPhone size={size} />;
    case "geo": return <IconMapPin size={size} />;
    case "calendar": return <IconClock size={size} />;
    default: return <IconGrid size={size} />;
  }
}

function typeLabel(type: QrType): string {
  return QR_TYPES.find((t) => t.id === type)?.label ?? type;
}

// ============================================================
// App
// ============================================================

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [view, setView] = useState<View>("home");
  const [selectedType, setSelectedType] = useState<QrType>("url");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<QrOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<QrResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "mark-recent", max: 20 });

  // Restore saved settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) { setTheme(t); applyTheme(t); }
    });
    getStoreValue<QrOptions>("options").then((o) => {
      if (o) setOptions({ ...DEFAULT_OPTIONS, ...o, logo_path: o.logo_path ?? null });
    });
  }, []);

  // Accept dropped CSV files and open the batch view.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onDragDropEvent((event) => {
      if (event.type === "enter" || event.type === "over") setDragging(true);
      else if (event.type === "leave") setDragging(false);
      else if (event.type === "drop") {
        setDragging(false);
        const csv = event.paths.find((p) => p.toLowerCase().endsWith(".csv"));
        if (csv) {
          setView("batch");
          // BatchView reads this hint after it mounts.
          (window as unknown as { __markCsvHint?: string }).__markCsvHint = csv;
          window.dispatchEvent(new CustomEvent("mark-csv-hint"));
        }
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Mark] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleOptionsChange = useCallback(async (next: QrOptions) => {
    setOptions(next);
    await setStoreValue("options", next);
  }, []);

  const startGenerate = useCallback((type: QrType) => {
    setSelectedType(type);
    setFieldValues({});
    setResult(null);
    setView("generate");
  }, []);

  const handleTypeChange = useCallback((type: QrType) => {
    setSelectedType(type);
    setFieldValues({});
    setResult(null);
  }, []);

  const goHome = useCallback(() => {
    setView("home");
    setResult(null);
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    // Recent entries store the type id in `tool`; jump back into that generator.
    const match = QR_TYPES.find((t) => t.label === file.tool);
    if (match) startGenerate(match.id);
  }, [startGenerate]);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar
          appName="Mark"
          crumb={view === "generate" ? typeLabel(selectedType) : view === "batch" ? "Batch" : undefined}
          showSettings={showSettings}
          onToggleSettings={() => setShowSettings((s) => !s)}
        />
        <div className="stage">
          {view === "home" && (
            <HomeScreen
              onPick={startGenerate}
              onOpenRecent={handleOpenRecent}
              onBatch={() => setView("batch")}
              recent={recent}
              dragging={dragging}
            />
          )}
          {view === "generate" && (
            <GenerateView
              type={selectedType}
              onTypeChange={handleTypeChange}
              fieldValues={fieldValues}
              onFieldValues={setFieldValues}
              options={options}
              onOptions={handleOptionsChange}
              result={result}
              onResult={setResult}
              previewing={previewing}
              onPreviewing={setPreviewing}
              optionsOpen={optionsOpen}
              onToggleOptions={setOptionsOpen}
              onBack={goHome}
              onBatch={() => setView("batch")}
              onExported={(name, path) => addRecent({ name, path, tool: typeLabel(selectedType), timestamp: Date.now() })}
            />
          )}
          {view === "batch" && (
            <BatchView
              options={options}
              onBack={goHome}
              onExported={(name, path) => addRecent({ name, path, tool: "Batch", timestamp: Date.now() })}
            />
          )}
          {showSettings && (
            <SettingsOverlay
              theme={theme}
              onThemeChange={handleThemeChange}
              options={options}
              onOptions={handleOptionsChange}
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

// Home screen, using the same drop-overlay pattern as Folio and Veil.

interface HomeScreenProps {
  onPick: (type: QrType) => void;
  onOpenRecent: (file: RecentFile) => void;
  onBatch: () => void;
  recent: RecentFile[];
  dragging: boolean;
}

function HomeScreen({ onPick, onOpenRecent, onBatch, recent, dragging }: HomeScreenProps) {
  return (
    <div className="drop-overlay">
      <MarkLogo />
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Pick a QR code type to generate"
        onKeyDown={(e) => { if (e.key === "Enter") onPick("url"); }}
        onClick={() => onPick("url")}
      >
        <IconPlus className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">Generate a QR code</div>
        <div className="drop-zone__subtext">Pick a type below, or drop a CSV here for batch generation</div>
        <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onBatch(); }}>
          Batch from CSV
        </button>
      </div>
      <div className="mark-types" onClick={(e) => {
        const card = (e.target as HTMLElement).closest("[data-type]") as HTMLElement | null;
        if (card) onPick(card.dataset.type as QrType);
      }}>
        {QR_TYPES.map((t) => (
          <button key={t.id} className="mark-type" data-type={t.id} aria-label={`Generate ${t.label} QR code`}>
            <span className="mark-type__icon">{typeIcon(t.id, 22)}</span>
            <span className="mark-type__label">{t.label}</span>
            <span className="mark-type__hint">{t.hint}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="drop-overlay__recent">
          <div className="drop-overlay__recent-label">Recent</div>
          <div className="recent-list">
            {recent.slice(0, 5).map((file, i) => (
              <button key={i} className="recent-list__item" onClick={() => onOpenRecent(file)}>
                <IconDownload size={14} />
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
// Generate view
// ============================================================

interface GenerateViewProps {
  type: QrType;
  onTypeChange: (t: QrType) => void;
  fieldValues: Record<string, string>;
  onFieldValues: (v: Record<string, string>) => void;
  options: QrOptions;
  onOptions: (o: QrOptions) => void;
  result: QrResult | null;
  onResult: (r: QrResult | null) => void;
  previewing: boolean;
  onPreviewing: (b: boolean) => void;
  optionsOpen: boolean;
  onToggleOptions: (b: boolean) => void;
  onBack: () => void;
  onBatch: () => void;
  onExported: (name: string, path: string) => void;
}

function GenerateView(props: GenerateViewProps) {
  const {
    type, onTypeChange, fieldValues, onFieldValues, options, onOptions,
    result, onResult, previewing, onPreviewing,
    optionsOpen, onToggleOptions, onBack, onBatch, onExported,
  } = props;

  const fields = QR_FIELDS[type];
  const payload = useMemo(() => encodeQrPayload(type, fieldValues), [type, fieldValues]);

  // ---- Live preview, debounced ----
  useEffect(() => {
    if (!payload) { onResult(null); return; }
    let cancelled = false;
    const id = window.setTimeout(() => {
      onPreviewing(true);
      generateQr(payload, options)
        .then((r) => { if (!cancelled) onResult(r); })
        .catch((e) => {
          if (!cancelled) {
            console.error("[generate] error:", e);
            onResult({ png_base64: "", svg: "", modules: 0, size_px: options.size_px, ok: false, message: String(e) });
            showToast(`Failed to generate: ${e}`, "error");
          }
        })
        .finally(() => { if (!cancelled) onPreviewing(false); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [payload, options, onResult, onPreviewing]);

  const handleFieldChange = useCallback((id: string, value: string) => {
    onFieldValues({ ...fieldValues, [id]: value });
  }, [fieldValues, onFieldValues]);

  const handlePickLogo = useCallback(async () => {
    const paths = await pickFiles(["png", "jpg", "jpeg"], false, [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }]);
    if (paths.length > 0) onOptions({ ...options, logo_path: paths[0] });
  }, [options, onOptions]);

  const handleClearLogo = useCallback(() => {
    onOptions({ ...options, logo_path: null });
  }, [options, onOptions]);

  const handleExportPng = useCallback(async () => {
    if (!result?.ok || !result.png_base64) {
      showToast("Nothing to export yet.", "info");
      return;
    }
    const path = await savePath(
      [{ name: "PNG image", extensions: ["png"] }],
      `${sanitizeFileName(payloadSummary(type, fieldValues))}.png`,
    );
    if (!path) return;
    try {
      await writeFileBytes(path, base64ToBytes(result.png_base64));
      onExported(baseNameSync(path), path);
      showToast(`Saved PNG to ${baseNameSync(path)}`, "success");
    } catch (e: any) {
      showToast(`Failed to save PNG: ${e.message || e}`, "error");
    }
  }, [result, type, fieldValues, onExported]);

  const handleExportSvg = useCallback(async () => {
    if (!result?.ok || !result.svg) {
      showToast("Nothing to export yet.", "info");
      return;
    }
    const path = await savePath(
      [{ name: "SVG vector", extensions: ["svg"] }],
      `${sanitizeFileName(payloadSummary(type, fieldValues))}.svg`,
    );
    if (!path) return;
    try {
      await writeFileBytes(path, svgToBytes(result.svg));
      onExported(baseNameSync(path), path);
      showToast(`Saved SVG to ${baseNameSync(path)}`, "success");
    } catch (e: any) {
      showToast(`Failed to save SVG: ${e.message || e}`, "error");
    }
  }, [result, type, fieldValues, onExported]);

  const handleExportPdf = useCallback(async () => {
    if (!result?.ok) {
      showToast("Nothing to export yet.", "info");
      return;
    }
    const path = await savePath(
      [{ name: "PDF document", extensions: ["pdf"] }],
      `${sanitizeFileName(payloadSummary(type, fieldValues))}.pdf`,
    );
    if (!path) return;
    try {
      const pdfBase64 = await generatePdf(payload, options);
      await writeFileBytes(path, base64ToBytes(pdfBase64));
      onExported(baseNameSync(path), path);
      showToast(`Saved PDF to ${baseNameSync(path)}`, "success");
    } catch (e: any) {
      showToast(`Failed to save PDF: ${e.message || e}`, "error");
    }
  }, [result, payload, options, type, fieldValues, onExported]);

  const handleCopyPng = useCallback(async () => {
    if (!result?.ok || !result.png_base64) return;
    try {
      const bytes = base64ToBytes(result.png_base64);
      const blob = new Blob([bytes], { type: "image/png" });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("PNG copied to clipboard", "success");
    } catch (e: any) {
      showToast(`Copy failed: ${e.message || e}`, "error");
    }
  }, [result]);

  // ---- Presets ----
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    loadPresets()
      .then(setPresets)
      .catch((e) => console.error("[presets] load failed:", e));
  }, []);

  const handleSavePreset = useCallback(async () => {
    const name = presetName.trim() || payloadSummary(type, fieldValues) || "Preset";
    try {
      await savePreset(name, type, fieldValues, options);
      const next = await loadPresets();
      setPresets(next);
      setPresetName("");
      showToast(`Saved preset "${name}"`, "success");
    } catch (e: any) {
      showToast(`Failed to save preset: ${e.message || e}`, "error");
    }
  }, [presetName, type, fieldValues, options]);

  const handleLoadPreset = useCallback(async (name: string) => {
    const preset = presets.find((p) => p.name === name);
    if (!preset) return;
    const match = QR_TYPES.find((t) => t.id === preset.qr_type);
    if (match) onTypeChange(match.id);
    onFieldValues(preset.field_values ?? {});
    onOptions({ ...DEFAULT_OPTIONS, ...preset.options, logo_path: preset.options.logo_path ?? null });
    showToast(`Loaded preset "${name}"`, "success");
  }, [presets, onTypeChange, onFieldValues, onOptions]);

  const handleDeletePreset = useCallback(async (name: string) => {
    try {
      await deletePreset(name);
      const next = await loadPresets();
      setPresets(next);
      showToast(`Deleted preset "${name}"`, "info");
    } catch (e: any) {
      showToast(`Failed to delete preset: ${e.message || e}`, "error");
    }
  }, []);

  return (
    <div className="mark-gen">
      <div className="mark-gen__topbar">
        <div className="mark-gen__topbar-left">
          <button className="btn-ghost" onClick={onBack} aria-label="Back to home">
            <IconArrowRight size={14} style={{ transform: "rotate(180deg)" }} /> Back
          </button>
          <span className="mark-gen__title">
            {typeIcon(type, 14)} {typeLabel(type)}
          </span>
        </div>
        <div className="mark-gen__topbar-right">
          {presets.length > 0 && (
            <select
              className="input"
              style={{ padding: "6px 8px", fontSize: 12, maxWidth: 160 }}
              value=""
              onChange={(e) => { if (e.target.value) handleLoadPreset(e.target.value); e.target.value = ""; }}
              title="Load a saved preset"
            >
              <option value="">Presets…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          )}
          <input
            className="input"
            style={{ padding: "6px 8px", fontSize: 12, width: 120 }}
            placeholder="Preset name"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); }}
          />
          <button className="btn-ghost" onClick={handleSavePreset} title="Save current config as a preset">
            <IconPlus size={14} /> Save Preset
          </button>
          {presets.length > 0 && (
            <select
              className="input"
              style={{ padding: "6px 8px", fontSize: 12, maxWidth: 140 }}
              value=""
              onChange={(e) => { if (e.target.value) handleDeletePreset(e.target.value); e.target.value = ""; }}
              title="Delete a saved preset"
            >
              <option value="">Delete…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          )}
          <button className="btn-ghost" onClick={onBatch}>
            Batch
          </button>
        </div>
      </div>

      <div className="mark-gen__split">
        {/* Form */}
        <div className="mark-form">
          <div className="mark-form__type-row">
            <span className="eyebrow">Type</span>
            <select
              className="input"
              style={{ flex: 1, padding: "6px 8px", fontSize: 12 }}
              value={type}
              onChange={(e) => onTypeChange(e.target.value as QrType)}
            >
              {QR_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          {fields.map((f) => (
            <div key={f.id} className="mark-form__field">
              <label className="mark-form__field-label">{f.label}</label>
              {f.options ? (
                <select
                  className="input"
                  value={fieldValues[f.id] ?? f.defaultValue ?? ""}
                  onChange={(e) => handleFieldChange(f.id, e.target.value)}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : f.multiline ? (
                <textarea
                  className="input"
                  rows={3}
                  placeholder={f.placeholder}
                  value={fieldValues[f.id] ?? ""}
                  onChange={(e) => handleFieldChange(f.id, e.target.value)}
                />
              ) : (
                <input
                  className="input"
                  placeholder={f.placeholder}
                  value={fieldValues[f.id] ?? f.defaultValue ?? ""}
                  onChange={(e) => handleFieldChange(f.id, e.target.value)}
                />
              )}
            </div>
          ))}
          <div>
            <div className="mark-form__payload-label">Encoded payload</div>
            <div className="mark-form__payload">{payload || <span style={{ color: "var(--text-4)" }}>—</span>}</div>
          </div>
        </div>

        {/* Preview */}
        <div className="mark-preview">
          <div className="mark-preview__canvas">
            {result?.ok && result.png_base64 ? (
              <img src={`data:image/png;base64,${result.png_base64}`} alt="QR code preview" />
            ) : (
              <div className="mark-preview__empty">
                {previewing ? <IconRefresh size={28} /> : <IconGrid size={28} />}
              </div>
            )}
          </div>
          <div className="mark-preview__meta">
            <span><strong>{result?.modules ?? 0}</strong> modules</span>
            <span><strong>{options.size_px}</strong> px</span>
            <span>EC <strong>{options.ec_level}</strong></span>
            {result?.message && <span style={{ color: "var(--danger)" }}>{result.message}</span>}
          </div>
        </div>
      </div>

      {/* Options */}
      <OptionsPanel
        open={optionsOpen}
        onToggle={() => onToggleOptions(!optionsOpen)}
        options={options}
        onOptions={onOptions}
        onPickLogo={handlePickLogo}
        onClearLogo={handleClearLogo}
      />

      {/* Export bar */}
      <div className="mark-exportbar">
        <div className="mark-exportbar__info">
          <IconShield size={13} /> Generated locally — nothing leaves your machine
        </div>
        <div className="mark-exportbar__spacer" />
        <button className="btn-ghost" onClick={handleCopyPng} disabled={!result?.ok}>
          <IconCopy size={14} /> Copy
        </button>
        <button className="btn btn--secondary" onClick={handleExportSvg} disabled={!result?.ok}>
          <IconDownload size={14} /> SVG
        </button>
        <button className="btn btn--secondary" onClick={handleExportPdf} disabled={!result?.ok}>
          <IconDownload size={14} /> PDF
        </button>
        <button className="btn btn--primary" onClick={handleExportPng} disabled={!result?.ok}>
          <IconDownload size={14} /> Export PNG
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Options panel
// ============================================================

interface OptionsPanelProps {
  open: boolean;
  onToggle: () => void;
  options: QrOptions;
  onOptions: (o: QrOptions) => void;
  onPickLogo: () => void;
  onClearLogo: () => void;
}

function OptionsPanel({ open, onToggle, options, onOptions, onPickLogo, onClearLogo }: OptionsPanelProps) {
  return (
    <div className="mark-options">
      <div className="mark-options__head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span className="mark-options__head-label">Customize</span>
        <IconChevronDownRotated open={open} />
      </div>
      {open && (
        <div className="mark-options__body">
          <div className="mark-options__group">
            <span className="mark-options__label">Error correction</span>
            <div className="preset-group">
              {EC_OPTIONS.map((ec) => (
                <button
                  key={ec}
                  className={`preset ${options.ec_level === ec ? "preset--selected" : ""}`}
                  onClick={() => onOptions({ ...options, ec_level: ec })}
                >
                  <div className="preset__label">{ec}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mark-options__group">
            <span className="mark-options__label">Size</span>
            <div className="preset-group">
              {SIZE_OPTIONS.map((s) => (
                <button
                  key={s}
                  className={`preset ${options.size_px === s ? "preset--selected" : ""}`}
                  onClick={() => onOptions({ ...options, size_px: s })}
                >
                  <div className="preset__label">{s}px</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mark-options__group">
            <span className="mark-options__label">Quiet zone (modules)</span>
            <div className="mark-options__range">
              <input
                type="range"
                min={0}
                max={8}
                step={1}
                value={options.margin_modules}
                onChange={(e) => onOptions({ ...options, margin_modules: Number(e.target.value) })}
              />
              <span className="mark-options__range-val">{options.margin_modules}</span>
            </div>
          </div>

          <div className="mark-options__group">
            <span className="mark-options__label">Foreground</span>
            <div className="mark-color-row">
              <input
                type="color"
                value={rgbaToHex(options.fg_color)}
                onChange={(e) => onOptions({ ...options, fg_color: hexToRgba(e.target.value) })}
              />
              <span className="mark-color-row__hex">{rgbaToHex(options.fg_color)}</span>
            </div>
          </div>

          <div className="mark-options__group">
            <span className="mark-options__label">Background</span>
            <div className="mark-color-row">
              <input
                type="color"
                value={rgbaToHex(options.bg_color)}
                onChange={(e) => onOptions({ ...options, bg_color: hexToRgba(e.target.value) })}
              />
              <span className="mark-color-row__hex">{rgbaToHex(options.bg_color)}</span>
            </div>
          </div>

          <div className="mark-options__group">
            <span className="mark-options__label">Logo</span>
            <div className="row gap-6">
              <button className="btn-ghost" onClick={onPickLogo}>
                <IconImage size={14} /> {options.logo_path ? "Change" : "Choose"}
              </button>
              {options.logo_path && (
                <>
                  <span className="muted ellipsis" style={{ maxWidth: 120 }}>{baseNameSync(options.logo_path)}</span>
                  <button className="btn-ghost" onClick={onClearLogo} aria-label="Remove logo">
                    <IconClose size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconChevronDownRotated({ open }: { open: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ transition: "transform 160ms var(--ease-out-expo)", transform: open ? "rotate(180deg)" : "none", color: "var(--text-3)" }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// ============================================================
// Batch view
// ============================================================

interface BatchViewProps {
  options: QrOptions;
  onBack: () => void;
  onExported: (name: string, path: string) => void;
}

function BatchView({ options, onBack, onExported }: BatchViewProps) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [results, setResults] = useState<BatchItem[] | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Pick up a CSV path dropped at the app level while the batch view is open.
  useEffect(() => {
    const handler = async () => {
      const hint = (window as unknown as { __markCsvHint?: string }).__markCsvHint;
      if (hint) {
        (window as unknown as { __markCsvHint?: string }).__markCsvHint = undefined;
        await loadCsv(hint);
      }
    };
    window.addEventListener("mark-csv-hint", handler);
    return () => window.removeEventListener("mark-csv-hint", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCsv = useCallback(async (path: string) => {
    try {
      const text = new TextDecoder().decode(await readFileBytes(path));
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        showToast("CSV is empty.", "info");
        return;
      }
      // Detect a header row.
      const first = parsed[0].map((c) => c.trim().toLowerCase());
      const labelIdx = first.findIndex((c) => c === "label" || c === "name" || c === "title");
      const dataIdx = first.findIndex((c) => c === "data" || c === "value" || c === "url" || c === "content");
      let start = 0;
      let li = 0, di = 1;
      if (labelIdx >= 0 || dataIdx >= 0) {
        start = 1;
        li = labelIdx >= 0 ? labelIdx : 0;
        di = dataIdx >= 0 ? dataIdx : (labelIdx === 0 ? 1 : 0);
      } else if (parsed[0].length >= 2) {
        li = 0; di = 1;
      } else {
        li = 0; di = 0;
      }
      const out: BatchRow[] = parsed.slice(start)
        .map((r) => ({
          label: (r[li] ?? "").trim() || (r[di] ?? "").trim().slice(0, 24) || "qr",
          data: (r[di] ?? "").trim(),
        }))
        .filter((r) => r.data.length > 0);
      setRows(out);
      setResults(null);
      showToast(`Loaded ${out.length} row${out.length === 1 ? "" : "s"}`, "success");
    } catch (e: any) {
      showToast(`Failed to read CSV: ${e.message || e}`, "error");
    }
  }, []);

  const handleBrowseCsv = useCallback(async () => {
    const paths = await pickFiles(["csv"], false, [{ name: "CSV", extensions: ["csv"] }]);
    if (paths.length > 0) await loadCsv(paths[0]);
  }, [loadCsv]);

  const handleGenerateAll = useCallback(async () => {
    if (!rows.length || processing) return;
    setProcessing(true);
    setProgress(0);
    setResults(null);
    try {
      // Generate in chunks to surface progress.
      const all: BatchItem[] = [];
      const chunk = 8;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const part = await generateQrBatch(slice, options);
        all.push(...part);
        setProgress(Math.round(((i + slice.length) / rows.length) * 100));
      }
      setResults(all);
      const ok = all.filter((r) => r.ok).length;
      showToast(`Generated ${ok}/${all.length} codes`, ok === all.length ? "success" : "info");
    } catch (e: any) {
      showToast(`Batch failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [rows, processing, options]);

  const handleExportAll = useCallback(async () => {
    if (!results) return;
    const dir = await pickDirectory();
    if (!dir) return;
    const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
    const base = dir.endsWith(sep) ? dir : `${dir}${sep}`;
    let written = 0;
    try {
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.ok || !r.png_base64) continue;
        const name = sanitizeFileName(r.label || `qr_${i + 1}`);
        const pngPath = `${base}${name}.png`;
        const svgPath = `${base}${name}.svg`;
        await writeFileBytes(pngPath, base64ToBytes(r.png_base64));
        await writeFileBytes(svgPath, svgToBytes(r.svg));
        written++;
      }
      onExported(`${written} codes`, base);
      showToast(`Exported ${written} PNG + SVG to ${base}`, "success");
    } catch (e: any) {
      showToast(`Export failed: ${e.message || e}`, "error");
    }
  }, [results, onExported]);

  const handleClearRows = useCallback(() => {
    setRows([]);
    setResults(null);
  }, []);

  return (
    <div className="mark-batch">
      <div className="mark-batch__topbar">
        <div className="mark-gen__topbar-left">
          <button className="btn-ghost" onClick={onBack} aria-label="Back to home">
            <IconArrowRight size={14} style={{ transform: "rotate(180deg)" }} /> Back
          </button>
          <span className="mark-gen__title">Batch from CSV</span>
        </div>
        <div className="mark-gen__topbar-right">
          {rows.length > 0 && (
            <button className="btn-ghost" onClick={handleClearRows} disabled={processing}>
              <IconClose size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      <div className="mark-batch__body">
        {rows.length === 0 ? (
          <div
            className={`mark-batch__drop ${dragging ? "mark-batch__drop--active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={handleBrowseCsv}
            onKeyDown={(e) => { if (e.key === "Enter") handleBrowseCsv(); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = Array.from(e.dataTransfer.files).find((f) => f.name.toLowerCase().endsWith(".csv"));
              if (file) {
                const reader = new FileReader();
                reader.onload = () => {
                  const text = String(reader.result ?? "");
                  const parsed = parseCsv(text);
                  const first = parsed[0].map((c) => c.trim().toLowerCase());
                  const labelIdx = first.findIndex((c) => c === "label" || c === "name" || c === "title");
                  const dataIdx = first.findIndex((c) => c === "data" || c === "value" || c === "url" || c === "content");
                  let start = 0, li = 0, di = 1;
                  if (labelIdx >= 0 || dataIdx >= 0) { start = 1; li = labelIdx >= 0 ? labelIdx : 0; di = dataIdx >= 0 ? dataIdx : (labelIdx === 0 ? 1 : 0); }
                  else if (parsed[0].length >= 2) { li = 0; di = 1; } else { li = 0; di = 0; }
                  const out: BatchRow[] = parsed.slice(start)
                    .map((r) => ({ label: (r[li] ?? "").trim() || (r[di] ?? "").trim().slice(0, 24) || "qr", data: (r[di] ?? "").trim() }))
                    .filter((r) => r.data.length > 0);
                  setRows(out); setResults(null);
                  showToast(`Loaded ${out.length} row${out.length === 1 ? "" : "s"}`, "success");
                };
                reader.readAsText(file);
              }
            }}
          >
            <IconUpload size={28} className="drop-zone__icon" />
            <div className="drop-zone__heading">Drop a CSV file here</div>
            <div className="drop-zone__subtext">Columns: <code>label,data</code> — or just one column of URLs/text</div>
            <button className="btn-ghost" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); handleBrowseCsv(); }}>
              <IconFolder size={14} /> Browse
            </button>
          </div>
        ) : (
          <>
            <table className="mark-batch__table">
              <thead>
                <tr>
                  <th style={{ width: 56 }}></th>
                  <th>Label</th>
                  <th>Data</th>
                  <th style={{ width: 70 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const res = results?.[i];
                  return (
                    <tr key={i} className={res && !res.ok ? "mark-batch__row--fail" : ""}>
                      <td>
                        {res?.ok && res.png_base64 ? (
                          <img className="mark-batch__thumb" src={`data:image/png;base64,${res.png_base64}`} alt="" />
                        ) : (
                          <span style={{ color: "var(--text-4)" }}><IconFile size={18} /></span>
                        )}
                      </td>
                      <td>{r.label}</td>
                      <td style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 11 }}>{r.data}</td>
                      <td>
                        {res ? (res.ok
                          ? <span className="success"><IconCheck size={13} /> OK</span>
                          : <span className="danger" title={res.message ?? ""}>Fail</span>)
                          : <span style={{ color: "var(--text-4)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {processing && (
        <div style={{ padding: "0 20px 12px" }}>
          <div className="progress"><div className="progress__bar" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <div className="mark-batch__footer">
        <span className="mark-batch__count">{rows.length} row{rows.length === 1 ? "" : "s"}</span>
        <div className="mark-exportbar__spacer" />
        <button className="btn btn--secondary" onClick={handleExportAll} disabled={!results || processing}>
          <IconDownload size={14} /> Export all
        </button>
        <button className="btn btn--primary" onClick={handleGenerateAll} disabled={!rows.length || processing}>
          {processing ? "Generating…" : <>Generate {rows.length} <IconArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Minimal CSV parser (handles quoted fields, commas, newlines)
// ============================================================

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const norm = text.replace(/\r\n?/g, "\n");
  while (i < norm.length) {
    const c = norm[i];
    if (inQuotes) {
      if (c === '"') {
        if (norm[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

// ============================================================
// Settings overlay
// ============================================================

interface SettingsOverlayProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  options: QrOptions;
  onOptions: (o: QrOptions) => void;
  recentCount: number;
  onClearRecent: () => void;
  onClose: () => void;
}

function SettingsOverlay({ theme, onThemeChange, options, onOptions, recentCount, onClearRecent, onClose }: SettingsOverlayProps) {
  return (
    <aside className="settings-panel" aria-label="Settings">
      <div className="settings-panel__header">
        <span className="settings-panel__title">Settings</span>
        <button className="titlebar__icon-btn" aria-label="Close settings" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="settings-panel__body">
        <div className="settings-panel__section">
          <div className="settings-panel__section-title">Theme</div>
          <div className="preset-group" style={{ maxWidth: 320 }}>
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button
                key={t}
                className={`preset ${theme === t ? "preset--selected" : ""}`}
                onClick={() => onThemeChange(t)}
              >
                <div className="preset__label" style={{ textTransform: "capitalize" }}>{t}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-panel__section">
          <div className="settings-panel__section-title">Defaults</div>
          <div className="settings-panel__section-desc">Used when starting a new code.</div>
          <div className="mark-options__group">
            <span className="mark-options__label">Error correction</span>
            <div className="preset-group">
              {EC_OPTIONS.map((ec) => (
                <button key={ec} className={`preset ${options.ec_level === ec ? "preset--selected" : ""}`}
                  onClick={() => onOptions({ ...options, ec_level: ec })}>
                  <div className="preset__label">{ec}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="mark-options__group">
            <span className="mark-options__label">Default size</span>
            <div className="preset-group">
              {SIZE_OPTIONS.map((s) => (
                <button key={s} className={`preset ${options.size_px === s ? "preset--selected" : ""}`}
                  onClick={() => onOptions({ ...options, size_px: s })}>
                  <div className="preset__label">{s}px</div>
                </button>
              ))}
            </div>
          </div>
          <div className="mark-options__group">
            <span className="mark-options__label">Foreground</span>
            <div className="mark-color-row">
              <input type="color" value={rgbaToHex(options.fg_color)}
                onChange={(e) => onOptions({ ...options, fg_color: hexToRgba(e.target.value) })} />
              <span className="mark-color-row__hex">{rgbaToHex(options.fg_color)}</span>
            </div>
          </div>
          <div className="mark-options__group">
            <span className="mark-options__label">Background</span>
            <div className="mark-color-row">
              <input type="color" value={rgbaToHex(options.bg_color)}
                onChange={(e) => onOptions({ ...options, bg_color: hexToRgba(e.target.value) })} />
              <span className="mark-color-row__hex">{rgbaToHex(options.bg_color)}</span>
            </div>
          </div>
        </div>

        <div className="settings-panel__section">
          <div className="settings-panel__section-title">Recent</div>
          <div className="settings-panel__section-desc">{recentCount} saved entr{recentCount === 1 ? "y" : "ies"}.</div>
          <button className="btn-ghost" onClick={onClearRecent} disabled={recentCount === 0}>
            <IconClose size={14} /> Clear recent
          </button>
        </div>

        <div className="settings-panel__section">
          <div className="settings-panel__section-title">About</div>
          <div className="settings-panel__section-desc">
            Mark generates QR codes entirely on your machine. No servers, no analytics, no accounts.
          </div>
          <div className="row gap-6" style={{ color: "var(--text-3)", fontSize: 11 }}>
            <IconShield size={13} /> Local-first · MIT licensed
          </div>
        </div>
      </div>
    </aside>
  );
}
