// ============================================================
// Lens — LensLogo.tsx
// ASCII art logo for the Lens color picker app.
// Uses browser-default <pre> styling, matching the suite.
// ============================================================

export function LensLogo() {
  return (
    <pre
      className="lens-logo"
      aria-label="Lens"
      style={{ margin: 0 }}
      dangerouslySetInnerHTML={{
        __html: `<span style="color: var(--text-1)">██╗     ███████╗███╗   ██╗███████╗
██║     ██╔════╝████╗  ██║██╔════╝
██║     █████╗  ██╔██╗ ██║███████╗
██║     ██╔══╝  ██║╚██╗██║╚════██║
███████╗███████╗██║ ╚████║███████║
╚══════╝╚══════╝╚═╝  ╚═══╝╚══════╝</span>`,
      }}
    />
  );
}
