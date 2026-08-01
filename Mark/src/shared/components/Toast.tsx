// ============================================================
// @local/ui — components/Toast.tsx
// Bottom-center pill notifications. Use `showToast()` from
// anywhere in the app; <ToastContainer/> mounts once near root.
// ============================================================

import { useEffect, useState } from "react";
import { IconCheck, IconWarning, IconInfo, IconClose } from "./icons";

export type ToastKind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  timeout: number;
}

let pushExternal: ((kind: ToastKind, message: string, timeout?: number) => void) | null = null;
// Queue toasts that fire before ToastContainer mounts so they aren't lost.
const pending: Array<[ToastKind, string, number | undefined]> = [];

export function showToast(message: string, kind: ToastKind = "info", timeout = 3200): void {
  if (pushExternal) pushExternal(kind, message, timeout);
  else pending.push([kind, message, timeout]);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    pushExternal = (kind, message, timeout = 3200) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, kind, message, timeout }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, timeout);
    };
    // Flush anything queued before mount.
    while (pending.length) {
      const [kind, message, timeout] = pending.shift()!;
      pushExternal(kind, message, timeout);
    }
    return () => { pushExternal = null; };
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--visible toast--${t.kind}`} role="status">
          <span className="toast__icon">
            {t.kind === "success" && <IconCheck size={16} />}
            {t.kind === "error" && <IconWarning size={16} />}
            {t.kind === "info" && <IconInfo size={16} />}
          </span>
          <span>{t.message}</span>
          <button className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
