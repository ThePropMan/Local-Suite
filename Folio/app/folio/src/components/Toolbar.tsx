export type Tool = "merge" | "split" | "delete" | "reorder" | "compress" | "number" | "fill" | "sign" | "redact" | "scan";

interface ToolbarProps {
  activeTool: Tool | null;
  onToolClick: (tool: Tool) => void;
  onExport: () => void;
}

interface ToolDef { id: Tool; label: string; icon: React.ReactNode; }

const TOOLS: ToolDef[] = [
  {
    id: "merge",
    label: "Merge",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM4 7h4M16 7h4M4 17h4M16 17h4"/></svg>,
  },
  {
    id: "split",
    label: "Split",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM12 7v10"/></svg>,
  },
  {
    id: "delete",
    label: "Delete",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM10 11v4M14 11v4M6 7h12M10 7l1-2h2l1 2"/></svg>,
  },
  {
    id: "reorder",
    label: "Reorder",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM7 9l-3 3 3 3M17 9l3 3-3 3"/></svg>,
  },
  {
    id: "compress",
    label: "Compress",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM4 12h16"/></svg>,
  },
  {
    id: "number",
    label: "Number",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM10 11h4M12 11v5"/></svg>,
  },
  {
    id: "fill",
    label: "Fill",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 7h8v10H8zM9 11h6M9 14h4"/></svg>,
  },
  {
    id: "sign",
    label: "Sign",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 17l4-10 4 10 4-7 4 7"/></svg>,
  },
  {
    id: "redact",
    label: "Redact",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 5h14v14H5zM5 5l14 14M19 5L5 19"/></svg>,
  },
  {
    id: "scan",
    label: "Scan",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 7v10h16V7M4 12h16M8 9h8"/></svg>,
  },
];

// Group tools so the toolbar reads as: pages, content, annotate.
const GROUPS: ToolDef[][] = [
  TOOLS.filter((t) => ["merge", "split", "delete", "reorder"].includes(t.id)),
  TOOLS.filter((t) => ["compress", "number"].includes(t.id)),
  TOOLS.filter((t) => ["fill", "sign", "redact", "scan"].includes(t.id)),
];

export function Toolbar({ activeTool, onToolClick, onExport }: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="PDF tools">
      {GROUPS.map((group, gi) => (
        <div key={gi} className="toolbar__group">
          {group.map((tool) => (
            <button
              key={tool.id}
              className={`toolbar__btn anim ${activeTool === tool.id ? "toolbar__btn--active" : ""}`}
              aria-pressed={activeTool === tool.id}
              onClick={() => onToolClick(tool.id)}
            >
              {tool.icon}
              <span className="toolbar__label">{tool.label}</span>
            </button>
          ))}
          {gi < GROUPS.length - 1 && <div className="toolbar__divider" />}
        </div>
      ))}
      <div className="toolbar__divider" />
      <button className="toolbar__export anim" aria-label="Export" onClick={onExport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
        </svg>
      </button>
    </div>
  );
}
