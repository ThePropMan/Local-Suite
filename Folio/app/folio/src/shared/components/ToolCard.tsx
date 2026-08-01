// ============================================================
// @local/ui — components/ToolCard.tsx
// Home-screen tool tile (icon + name + description).
// ============================================================

interface ToolCardProps {
  name: string;
  description: string;
  icon: React.ReactNode;
  onClick?: () => void;
}

export function ToolCard({ name, description, icon, onClick }: ToolCardProps) {
  return (
    <button className="tool-card" onClick={onClick}>
      <span className="tool-card__icon" aria-hidden="true">{icon}</span>
      <span className="tool-card__body">
        <span className="tool-card__name">{name}</span>
        <span className="tool-card__desc">{description}</span>
      </span>
    </button>
  );
}
