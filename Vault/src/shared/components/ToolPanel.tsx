// ============================================================
// @local/ui — components/ToolPanel.tsx
// Slide-in panel anchored to the right edge of the stage.
// Used by Folio for tool options; reusable by other apps.
// ============================================================

import type { ReactNode } from "react";

interface ToolPanelProps {
  open: boolean;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function ToolPanel({ open, title, children, footer }: ToolPanelProps) {
  return (
    <div className={`tool-panel ${open ? "" : "tool-panel--closed"}`} aria-hidden={!open}>
      {title && <div className="tool-panel__header">{title}</div>}
      <div className="tool-panel__body">{children}</div>
      {footer && <div className="tool-panel__footer">{footer}</div>}
    </div>
  );
}
