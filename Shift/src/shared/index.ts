// ============================================================
// @local/ui — barrel export
// Apps can `import { TitleBar, DropZone, showToast } from "../shared";
// or import individual modules. Both work.
// ============================================================

export * from "./types";
export * from "./lib/tauri";
export * from "./hooks/useRecentFiles";
export * from "./hooks/useDrop";
export { TitleBar } from "./components/TitleBar";
export { Sidebar } from "./components/Sidebar";
export { DropZone } from "./components/DropZone";
export { ToastContainer, showToast, type ToastKind } from "./components/Toast";
export { ErrorBoundary } from "./components/ErrorBoundary";
export { ToolCard } from "./components/ToolCard";
export { ToolPanel } from "./components/ToolPanel";
export { SettingsPanel, type SettingsSection } from "./components/SettingsPanel";
export { AppShell } from "./components/AppShell";
export * as Icons from "./components/icons";
