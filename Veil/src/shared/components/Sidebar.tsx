// ============================================================
// @local/ui — components/Sidebar.tsx
// Left navigation, parameterized by sections of nav items.
// ============================================================

import type { NavSection } from "../types";
import { IconBrand } from "./icons";

interface SidebarProps {
  appName: string;
  sections: NavSection[];
  activeId: string;
  onSelect: (id: string) => void;
  footer?: React.ReactNode;
}

export function Sidebar({ appName, sections, activeId, onSelect, footer }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark" aria-hidden="true">
          <IconBrand size={12} />
        </span>
        {appName}
      </div>
      {sections.map((section, i) => (
        <div key={i} className="sidebar__section">
          {section.label && <div className="sidebar__label">{section.label}</div>}
          {section.items.map((item) => (
            <button
              key={item.id}
              className={`sidebar__item ${activeId === item.id ? "sidebar__item--active" : ""}`}
              onClick={() => onSelect(item.id)}
              aria-current={activeId === item.id ? "page" : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          {i < sections.length - 1 && <div className="sidebar__divider" />}
        </div>
      ))}
      {footer && <div className="sidebar__footer">{footer}</div>}
    </aside>
  );
}
