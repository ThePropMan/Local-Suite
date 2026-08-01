// ============================================================
// @local/ui — components/AppShell.tsx
// Standard layout: TitleBar on top, Sidebar on the left,
// main content area on the right, optional slide-over
// SettingsPanel. Apps pass their main view as children.
// ============================================================

import type { ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { SettingsPanel, type SettingsSection } from "./SettingsPanel";
import type { NavSection } from "../types";

interface AppShellProps {
  appName: string;
  crumb?: string;
  sections: NavSection[];
  activeId: string;
  onSelect: (id: string) => void;
  showSettings: boolean;
  onToggleSettings: () => void;
  settingsSections?: SettingsSection[];
  sidebarFooter?: ReactNode;
  titleBarRight?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  appName,
  crumb,
  sections,
  activeId,
  onSelect,
  showSettings,
  onToggleSettings,
  settingsSections = [],
  sidebarFooter,
  titleBarRight,
  children,
}: AppShellProps) {
  return (
    <div className="app">
      <TitleBar
        appName={appName}
        crumb={crumb}
        showSettings={showSettings}
        onToggleSettings={onToggleSettings}
        right={titleBarRight}
      />
      <div className="app__body">
        <Sidebar
          appName={appName}
          sections={sections}
          activeId={activeId}
          onSelect={onSelect}
          footer={sidebarFooter}
        />
        <main className="main-panel">
          {children}
        </main>
        <SettingsPanel
          open={showSettings}
          onClose={onToggleSettings}
          sections={settingsSections}
        />
      </div>
    </div>
  );
}
