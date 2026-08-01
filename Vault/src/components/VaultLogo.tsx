// ============================================================
// Vault — VaultLogo.tsx
// ASCII art logo for the Vault password manager app.
// Uses browser-default <pre> styling, matching the suite.
// ============================================================

export function VaultLogo() {
  return (
    <pre
      className="vault-logo"
      role="img"
      aria-label="VAULT"
      title="VAULT"
    >
{`██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗
██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝
██║   ██║███████║██║   ██║██║     ██║
╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║
 ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║
  ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝`}
    </pre>
  );
}
