// ============================================================
// @local/ui — components/TitleBar.tsx
// Custom window chrome: drag region, app brand, optional
// crumb, settings gear, and three-dot window controls.
// ============================================================

import { useEffect, useState } from "react";
import { IconBrand, IconSettings } from "./icons";
import { isTauri, minimizeWindow, toggleMaximizeWindow, closeWindow } from "../lib/tauri";

interface TitleBarProps {
  /** App display name shown in the titlebar. */
  appName: string;
  /** Optional secondary crumb (e.g. current file name or view). */
  crumb?: string;
  /** Whether the settings panel is currently open (toggles gear highlight). */
  showSettings?: boolean;
  onToggleSettings?: () => void;
  /** Optional extra elements rendered on the right, before the controls. */
  right?: React.ReactNode;
}

export function TitleBar({ appName, crumb, showSettings, onToggleSettings, right }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.isMaximized().then(setMaximized).catch(() => {});
      const fn = await win.onResized(() => win.isMaximized().then(setMaximized).catch(() => {}));
      if (!cancelled) unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar__drag" data-tauri-drag-region>
        <span className="titlebar__brand">
          <span className="titlebar__brand-mark" aria-hidden="true">
            <IconBrand size={11} />
          </span>
          {appName}
        </span>
        {crumb && (
          <>
            <span className="titlebar__sep">/</span>
            <span className="titlebar__crumb">{crumb}</span>
          </>
        )}
      </div>

      <div className="titlebar__right">
        {right}
        {onToggleSettings && (
          <button
            className={`titlebar__icon-btn ${showSettings ? "titlebar__icon-btn--active" : ""}`}
            aria-label="Settings"
            title="Settings"
            onClick={onToggleSettings}
          >
            <IconSettings />
          </button>
        )}
        <div className="titlebar__controls">
          <button
            className="titlebar__control"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void minimizeWindow()}
          />
          <button
            className="titlebar__control"
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => void toggleMaximizeWindow()}
            style={maximized ? { borderRadius: "3px" } : undefined}
          />
          <button
            className="titlebar__control titlebar__control--close"
            aria-label="Close"
            title="Close"
            onClick={() => void closeWindow()}
          />
        </div>
      </div>
    </div>
  );
}
