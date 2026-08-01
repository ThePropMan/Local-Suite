// ============================================================
// @local/ui — components/SettingsPanel.tsx
// Slide-over settings panel from the right edge. Renders a
// theme picker (system/light/dark) plus app-supplied sections.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { IconClose, IconSun, IconMoon, IconMonitor } from "./icons";
import { getStoreValue, setStoreValue, applyTheme, type Theme } from "../lib/tauri";

export interface SettingsSection {
  title: string;
  description?: string;
  children: ReactNode;
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  sections: SettingsSection[];
  /** Persisted store name (defaults to ".settings.json"). */
  storeName?: string;
}

export function SettingsPanel({ open, onClose, sections, storeName }: SettingsPanelProps) {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    getStoreValue<Theme>("theme", storeName).then((t) => t && setTheme(t));
  }, [storeName]);

  const handleTheme = async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t, storeName);
  };

  return (
    <aside
      className={`settings-panel ${open ? "" : "settings-panel--closed"}`}
      aria-hidden={!open}
      aria-label="Settings"
    >
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
            <button
              className={`preset ${theme === "system" ? "preset--selected" : ""}`}
              onClick={() => void handleTheme("system")}
            >
              <div className="preset__label" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <IconMonitor size={13} /> System
              </div>
            </button>
            <button
              className={`preset ${theme === "light" ? "preset--selected" : ""}`}
              onClick={() => void handleTheme("light")}
            >
              <div className="preset__label" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <IconSun size={13} /> Light
              </div>
            </button>
            <button
              className={`preset ${theme === "dark" ? "preset--selected" : ""}`}
              onClick={() => void handleTheme("dark")}
            >
              <div className="preset__label" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <IconMoon size={13} /> Dark
              </div>
            </button>
          </div>
        </div>
        {sections.map((s, i) => (
          <div key={i} className="settings-panel__section">
            <div className="settings-panel__section-title">{s.title}</div>
            {s.description && <div className="settings-panel__section-desc">{s.description}</div>}
            {s.children}
          </div>
        ))}
      </div>
    </aside>
  );
}
