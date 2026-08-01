import { useEffect, useState, useCallback, useMemo } from "react";
import { TitleBar } from "./shared/components/TitleBar";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import {
  IconLock,
  IconUnlock,
  IconCheck,
  IconClose,
  IconShield,
  IconFolder,
  IconFile,
  IconUpload,
  IconEye,
  IconEyeOff,
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
  encryptFile,
  decryptFile,
  verifyFile,
  defaultOutputPath,
  type Cipher,
  type EncryptResult,
  type DecryptResult,
  type VerifyResult,
} from "./lib/tauri";
import { SealLogo } from "./components/SealLogo";

type Mode = "encrypt" | "decrypt";

interface WorkItem {
  path: string;
  name: string;
  size: number;
}

const SEC_EXT = "sec";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [mode, setMode] = useState<Mode>("encrypt");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cipher, setCipher] = useState<Cipher>("ChaCha20-Poly1305");
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<EncryptResult | DecryptResult | VerifyResult | null>(null);
  const [resultKind, setResultKind] = useState<"encrypt" | "decrypt" | "verify" | null>(null);
  const { recent, addRecent, clearRecent } = useRecentFiles({ storeKey: "seal-recent", max: 20 });

  // Restore saved settings.
  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => {
      if (t) {
        setTheme(t);
        applyTheme(t);
      }
    });
    getStoreValue<string>("outputDir").then((v) => v && setOutputDir(v));
    getStoreValue<Cipher>("cipher").then((v) => v && setCipher(v));
    getStoreValue<Mode>("mode").then((v) => v && setMode(v));
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
        const paths = filterForMode(event.paths, mode);
        if (paths.length > 0) handleFiles(paths);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Seal] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, [mode]);

  // Reset result when inputs change.
  useEffect(() => {
    setResult(null);
    setResultKind(null);
  }, [items, password, confirmPassword, cipher, mode]);

  // Listen for real progress events emitted by the Rust encrypt/decrypt
  // commands and update the progress bar as chunks are processed.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ progress: number }>("seal-progress", (event) => {
          const p = event.payload?.progress;
          if (typeof p === "number") setProgress(Math.max(0, Math.min(100, p)));
        }),
      )
      .then((fn) => { if (!cancelled) unlisten = fn; })
      .catch((e) => console.error("[Seal] progress listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleModeChange = useCallback(async (m: Mode) => {
    setMode(m);
    setItems([]);
    setPassword("");
    setConfirmPassword("");
    setResult(null);
    setResultKind(null);
    await setStoreValue("mode", m);
  }, []);

  const handleCipherChange = useCallback(async (c: Cipher) => {
    setCipher(c);
    await setStoreValue("cipher", c);
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

  // ---- File loading ----

  const handleFiles = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const workItems: WorkItem[] = await Promise.all(
      paths.map(async (p) => ({
        path: p,
        name: baseNameSync(p),
        size: await fileSizeSafe(p),
      })),
    );
    setItems((prev) => [...prev, ...workItems]);
  }, []);

  const handleBrowse = useCallback(async () => {
    if (mode === "encrypt") {
      const paths = await pickFiles(null, true);
      if (paths.length > 0) handleFiles(paths);
    } else {
      const paths = await pickFiles([SEC_EXT], true, [{ name: "Seal archives", extensions: [SEC_EXT] }]);
      if (paths.length > 0) handleFiles(paths);
    }
  }, [mode, handleFiles]);

  const handleRemoveItem = useCallback((idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleClearAll = useCallback(() => {
    setItems([]);
    setPassword("");
    setConfirmPassword("");
    setResult(null);
    setResultKind(null);
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    setMode("decrypt");
    setItems([{ path: file.path, name: file.name, size: file.sizeBefore || 0 }]);
    setResult(null);
    setResultKind(null);
  }, []);

  // ---- Actions ----

  const passwordsMatch = mode === "decrypt" || (password.length > 0 && password === confirmPassword);
  const canAct = items.length > 0 && password.length > 0 && passwordsMatch && !processing;

  const handleEncrypt = useCallback(async () => {
    if (!canAct) return;
    setProcessing(true);
    setProgress(0);
    setResult(null);
    setResultKind(null);

    const inputPaths = items.map((i) => i.path);
    const outPath = defaultOutputPath(inputPaths, outputDir);

    try {
      const res = await encryptFile(inputPaths, outPath, password, cipher);
      setResult(res);
      setResultKind("encrypt");
      setProgress(100);
      addRecent({
        name: baseNameSync(res.output_path),
        path: res.output_path,
        tool: "encrypt",
        timestamp: Date.now(),
        sizeBefore: res.input_size,
        sizeAfter: res.output_size,
      });
      showToast(
        `Encrypted ${res.file_count} ${res.file_count === 1 ? "file" : "files"} into ${baseNameSync(res.output_path)} (${formatBytes(res.output_size)})`,
        "success",
      );
    } catch (e: any) {
      console.error("[encrypt] error:", e);
      showToast(`Encryption failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [canAct, items, outputDir, password, cipher, addRecent]);

  const handleDecrypt = useCallback(async () => {
    if (!canAct || items.length === 0) return;
    setProcessing(true);
    setProgress(0);
    setResult(null);
    setResultKind(null);

    if (items.length > 1) {
      showToast("Decrypting first file only", "info");
    }

    const inputPath = items[0].path;
    const outDir = outputDir ?? defaultDecryptDir(inputPath);

    try {
      const res = await decryptFile(inputPath, outDir, password);
      setResult(res);
      setResultKind("decrypt");
      setProgress(100);
      addRecent({
        name: baseNameSync(inputPath),
        path: inputPath,
        tool: "decrypt",
        timestamp: Date.now(),
        sizeBefore: res.output_size,
      });
      showToast(
        `Decrypted ${res.file_count} ${res.file_count === 1 ? "file" : "files"} to ${baseNameSync(outDir)}${res.verified ? " · verified" : ""}`,
        res.verified ? "success" : "info",
      );
    } catch (e: any) {
      console.error("[decrypt] error:", e);
      showToast(`Decryption failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [canAct, items, outputDir, password, addRecent]);

  const handleVerify = useCallback(async () => {
    if (items.length === 0 || password.length === 0 || processing) return;
    setProcessing(true);
    setProgress(0);
    setResult(null);
    setResultKind(null);

    if (items.length > 1) {
      showToast("Verifying first file only", "info");
    }

    try {
      const res = await verifyFile(items[0].path, password);
      setResult(res);
      setResultKind("verify");
      showToast(res.message, res.ok ? "success" : "error");
    } catch (e: any) {
      console.error("[verify] error:", e);
      showToast(`Verify failed: ${e.message || e}`, "error");
    } finally {
      setProcessing(false);
    }
  }, [items, password, processing]);

  // ---- Derived ----

  const hasItems = items.length > 0;
  const totalInputSize = useMemo(() => items.reduce((s, i) => s + i.size, 0), [items]);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar appName="Seal" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
        <div className="stage">
          {!hasItems ? (
            <DropOverlay
              mode={mode}
              onModeChange={handleModeChange}
              onBrowse={handleBrowse}
              recent={recent}
              onOpenRecent={handleOpenRecent}
              dragging={dragging}
            />
          ) : (
            <WorkingView
              mode={mode}
              onModeChange={handleModeChange}
              items={items}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onAddMore={handleBrowse}
              password={password}
              onPasswordChange={setPassword}
              confirmPassword={confirmPassword}
              onConfirmPasswordChange={setConfirmPassword}
              showPassword={showPassword}
              onToggleShowPassword={() => setShowPassword((s) => !s)}
              cipher={cipher}
              onCipherChange={handleCipherChange}
              outputDir={outputDir}
              onPickOutputDir={handlePickOutputDir}
              onClearOutputDir={handleClearOutputDir}
              onEncrypt={handleEncrypt}
              onDecrypt={handleDecrypt}
              onVerify={handleVerify}
              processing={processing}
              progress={progress}
              canAct={canAct}
              passwordsMatch={passwordsMatch}
              totalInputSize={totalInputSize}
              result={result}
              resultKind={resultKind}
            />
          )}
          {showSettings && (
            <div className="settings-overlay">
              <div className="tool-panel__header">Settings</div>
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Default output folder</label>
                <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
                  Where encrypted .sec files are saved (and where decrypted files are extracted). Falls back to the input file's directory.
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
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Default cipher</label>
                <div className="preset-group">
                  {(["ChaCha20-Poly1305", "AES-256-GCM"] as Cipher[]).map((c) => (
                    <button
                      key={c}
                      className={`preset ${cipher === c ? "preset--selected" : ""}`}
                      onClick={() => handleCipherChange(c)}
                    >
                      <div className="preset__label">{c === "ChaCha20-Poly1305" ? "ChaCha20" : "AES-256"}</div>
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

// ============================================================
// Helpers
// ============================================================

function filterForMode(paths: string[], mode: Mode): string[] {
  if (mode === "encrypt") return paths; // accept any file/folder
  // decrypt: only .sec files
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    return lower.endsWith(".sec");
  });
}

async function fileSizeSafe(path: string): Promise<number> {
  if (!isTauri) return 0;
  try {
    const { fileSize } = await import("./shared/lib/tauri");
    return await fileSize(path);
  } catch {
    return 0;
  }
}

function defaultDecryptDir(inputPath: string): string {
  const name = baseNameSync(inputPath);
  const dir = inputPath.slice(0, inputPath.length - name.length);
  const stem = name.toLowerCase().endsWith(".sec") ? name.slice(0, -4) : name;
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  const base = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return `${base}${stem}_decrypted`;
}

// ============================================================
// Drop overlay (home screen)
// ============================================================

interface DropOverlayProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onBrowse: () => void;
  recent: RecentFile[];
  onOpenRecent: (file: RecentFile) => void;
  dragging: boolean;
}

function DropOverlay({ mode, onModeChange, onBrowse, recent, onOpenRecent, dragging }: DropOverlayProps) {
  return (
    <div className="drop-overlay">
      <SealLogo />
      <div className="seal-mode-toggle">
        <button
          className={`seal-mode-toggle__btn ${mode === "encrypt" ? "seal-mode-toggle__btn--active" : ""}`}
          onClick={() => onModeChange("encrypt")}
        >
          <IconLock size={15} />
          Encrypt
        </button>
        <button
          className={`seal-mode-toggle__btn ${mode === "decrypt" ? "seal-mode-toggle__btn--active" : ""}`}
          onClick={() => onModeChange("decrypt")}
        >
          <IconUnlock size={15} />
          Decrypt
        </button>
      </div>
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        aria-label={mode === "encrypt" ? "Drop files to encrypt or press Enter to browse" : "Drop .sec files to decrypt or press Enter to browse"}
        onKeyDown={(e) => { if (e.key === "Enter") onBrowse(); }}
      >
        <IconUpload className="drop-zone__icon" size={28} />
        <div className="drop-zone__heading">
          {mode === "encrypt" ? "Drop files or folders to encrypt" : "Drop .sec files to decrypt"}
        </div>
        <div className="drop-zone__subtext">
          {mode === "encrypt" ? "Any files or folders — or pick from your files" : "Seal archives only — or pick from your files"}
        </div>
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
                <span className="recent-list__icon"><IconShield size={14} /></span>
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
  mode: Mode;
  onModeChange: (m: Mode) => void;
  items: WorkItem[];
  onRemoveItem: (idx: number) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  password: string;
  onPasswordChange: (v: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (v: string) => void;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  cipher: Cipher;
  onCipherChange: (c: Cipher) => void;
  outputDir: string | null;
  onPickOutputDir: () => void;
  onClearOutputDir: () => void;
  onEncrypt: () => void;
  onDecrypt: () => void;
  onVerify: () => void;
  processing: boolean;
  progress: number;
  canAct: boolean;
  passwordsMatch: boolean;
  totalInputSize: number;
  result: EncryptResult | DecryptResult | VerifyResult | null;
  resultKind: "encrypt" | "decrypt" | "verify" | null;
}

function WorkingView(props: WorkingViewProps) {
  const {
    mode, onModeChange, items, onRemoveItem, onClearAll, onAddMore,
    password, onPasswordChange, confirmPassword, onConfirmPasswordChange,
    showPassword, onToggleShowPassword, cipher, onCipherChange,
    outputDir, onPickOutputDir, onClearOutputDir,
    onEncrypt, onDecrypt, onVerify, processing, progress, canAct,
    passwordsMatch, totalInputSize, result, resultKind,
  } = props;

  return (
    <div className="seal-work">
      <div className="seal-work__topbar">
        <div className="seal-work__topbar-left">
          <div className="seal-mode-toggle seal-mode-toggle--sm">
            <button
              className={`seal-mode-toggle__btn ${mode === "encrypt" ? "seal-mode-toggle__btn--active" : ""}`}
              onClick={() => onModeChange("encrypt")}
              disabled={processing}
            >
              <IconLock size={13} />
              Encrypt
            </button>
            <button
              className={`seal-mode-toggle__btn ${mode === "decrypt" ? "seal-mode-toggle__btn--active" : ""}`}
              onClick={() => onModeChange("decrypt")}
              disabled={processing}
            >
              <IconUnlock size={13} />
              Decrypt
            </button>
          </div>
        </div>
        <div className="seal-work__topbar-right">
          <span className="seal-work__count">
            {items.length} {items.length === 1 ? "item" : "items"} · {formatBytes(totalInputSize)}
          </span>
          <button className="btn-ghost" onClick={onAddMore} disabled={processing}>Add more</button>
          <button className="btn-ghost" onClick={onClearAll} disabled={processing}>Clear</button>
        </div>
      </div>

      <div className="seal-work__body">
        {/* File list */}
        <div className="seal-files">
          {items.map((item, idx) => (
            <div key={idx} className="seal-file">
              <span className="seal-file__icon">
                {mode === "encrypt" ? <IconFile size={16} /> : <IconShield size={16} />}
              </span>
              <div className="seal-file__body">
                <div className="seal-file__name">{item.name}</div>
                <div className="seal-file__meta">{formatBytes(item.size)}</div>
              </div>
              {!processing && (
                <button className="seal-file__remove" aria-label="Remove" onClick={() => onRemoveItem(idx)}>
                  <IconClose size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Controls panel */}
        <div className="seal-panel">
          {/* Password */}
          <div className="seal-field">
            <label className="eyebrow" htmlFor="seal-password">Password</label>
            <div className="seal-input-row">
              <input
                id="seal-password"
                type={showPassword ? "text" : "password"}
                className="seal-input"
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                placeholder={mode === "encrypt" ? "Choose a strong password" : "Enter the password"}
                autoComplete="off"
                spellCheck={false}
                disabled={processing}
              />
              <button
                className="seal-input__toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={onToggleShowPassword}
                tabIndex={-1}
              >
                {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
            {mode === "encrypt" && (
              <PasswordStrength password={password} />
            )}
          </div>

          {/* Confirm password (encrypt only) */}
          {mode === "encrypt" && (
            <div className="seal-field">
              <label className="eyebrow" htmlFor="seal-confirm">Confirm password</label>
              <input
                id="seal-confirm"
                type={showPassword ? "text" : "password"}
                className="seal-input"
                value={confirmPassword}
                onChange={(e) => onConfirmPasswordChange(e.target.value)}
                placeholder="Re-enter the password"
                autoComplete="off"
                spellCheck={false}
                disabled={processing}
              />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <div className="seal-field__hint seal-field__hint--error">Passwords do not match.</div>
              )}
            </div>
          )}

          {/* Cipher picker (encrypt only) */}
          {mode === "encrypt" && (
            <div className="seal-field">
              <label className="eyebrow">Cipher</label>
              <div className="preset-group">
                {(["ChaCha20-Poly1305", "AES-256-GCM"] as Cipher[]).map((c) => (
                  <button
                    key={c}
                    className={`preset ${cipher === c ? "preset--selected" : ""}`}
                    onClick={() => onCipherChange(c)}
                    disabled={processing}
                  >
                    <div className="preset__label">{c === "ChaCha20-Poly1305" ? "ChaCha20-Poly1305" : "AES-256-GCM"}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Output folder */}
          <div className="seal-field">
            <label className="eyebrow">Output {mode === "encrypt" ? "file" : "folder"}</label>
            <div className="seal-output-row">
              <button className="btn-ghost" onClick={onPickOutputDir} disabled={processing}>
                <IconFolder size={14} />
                {outputDir ? "Change" : "Choose"}
              </button>
              <span className="seal-output-path">
                {outputDir
                  ? outputDir
                  : mode === "encrypt"
                    ? "Same as input (auto .sec)"
                    : "Next to input (auto _decrypted)"}
              </span>
              {outputDir && (
                <button className="btn-ghost" onClick={onClearOutputDir} disabled={processing}>Clear</button>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="seal-actions">
            {mode === "encrypt" ? (
              <button
                className="btn btn--primary seal-actions__main"
                onClick={onEncrypt}
                disabled={!canAct}
              >
                <IconLock size={16} />
                {processing ? "Encrypting…" : "Encrypt"}
              </button>
            ) : (
              <>
                <button
                  className="btn btn--primary seal-actions__main"
                  onClick={onDecrypt}
                  disabled={!canAct}
                >
                  <IconUnlock size={16} />
                  {processing ? "Decrypting…" : "Decrypt"}
                </button>
                <button
                  className="btn btn--secondary"
                  onClick={onVerify}
                  disabled={!canAct || processing}
                  title="Check integrity without extracting"
                >
                  <IconShield size={16} />
                  Verify only
                </button>
              </>
            )}
          </div>

          {/* Progress */}
          {processing && (
            <div className="seal-progress">
              <div className="seal-progress__bar" style={{ width: `${progress}%` }} />
            </div>
          )}

          {/* Result */}
          {result && resultKind && (
            <ResultBox
              resultKind={resultKind}
              result={result}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Password strength meter
// ============================================================

function PasswordStrength({ password }: { password: string }) {
  const score = scorePassword(password);
  if (password.length === 0) return null;
  const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
  const colors = ["var(--danger)", "var(--danger)", "var(--text-3)", "var(--success)", "var(--success)"];
  return (
    <div className="seal-strength">
      <div className="seal-strength__bars">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="seal-strength__bar"
            style={{
              background: i < score ? colors[score - 1] : "var(--border)",
            }}
          />
        ))}
      </div>
      <span className="seal-strength__label" style={{ color: score > 0 ? colors[score - 1] : "var(--text-3)" }}>
        {labels[Math.max(0, score - 1)]}
      </span>
    </div>
  );
}

function scorePassword(pw: string): number {
  if (pw.length === 0) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  return Math.min(score, 5);
}

// ============================================================
// Result box
// ============================================================

function ResultBox({
  resultKind,
  result,
}: {
  resultKind: "encrypt" | "decrypt" | "verify";
  result: EncryptResult | DecryptResult | VerifyResult;
}) {
  if (resultKind === "encrypt") {
    const r = result as EncryptResult;
    return (
      <div className="result-box result-box--success">
        <div className="result-box__title">
          <IconCheck size={16} />
          Encrypted successfully
        </div>
        <div className="result-box__detail">
          <span>{baseNameSync(r.output_path)}</span>
          <span>{formatBytes(r.input_size)} → {formatBytes(r.output_size)}</span>
          <span>{r.file_count} {r.file_count === 1 ? "file" : "files"} · {r.cipher}</span>
          <span>{r.duration_ms} ms</span>
        </div>
      </div>
    );
  }
  if (resultKind === "decrypt") {
    const r = result as DecryptResult;
    return (
      <div className={`result-box ${r.verified ? "result-box--success" : "result-box--warning"}`}>
        <div className="result-box__title">
          {r.verified ? <IconCheck size={16} /> : <IconShield size={16} />}
          Decrypted {r.verified ? "and verified" : ""}
        </div>
        <div className="result-box__detail">
          <span>{r.file_count} {r.file_count === 1 ? "file" : "files"} extracted</span>
          <span>{formatBytes(r.output_size)} plaintext</span>
          <span>{r.cipher}</span>
          <span>{r.duration_ms} ms</span>
        </div>
      </div>
    );
  }
  const r = result as VerifyResult;
  return (
    <div className={`result-box ${r.ok ? "result-box--success" : "result-box--error"}`}>
      <div className="result-box__title">
        {r.ok ? <IconCheck size={16} /> : <IconClose size={16} />}
        {r.ok ? "Integrity verified" : "Verification failed"}
      </div>
      <div className="result-box__detail">
        <span>{r.file_count} {r.file_count === 1 ? "file" : "files"} in archive</span>
        <span>{r.cipher}</span>
      </div>
    </div>
  );
}
