# @local/ui

Shared design system, components, and Tauri wrappers for the **Local** app suite
(Folio, Veil, Mark, Shift). Distributed as a git subtree into each app at
`src/shared/`.

## What's inside

```
src/
  styles/
    global.css       # design tokens (OKLCH), reset, base component styles
    components.css   # shared component styles (sidebar, titlebar, drop-zone, ...)
  components/
    TitleBar.tsx     # custom window chrome (parameterized by app name)
    DropZone.tsx     # drag-and-drop + click-to-pick (parameterized by extensions)
    Toast.tsx        # bottom-center pill notifications + showToast()
    ErrorBoundary.tsx
    ToolCard.tsx     # home-screen tool tile
    ToolPanel.tsx    # slide-in panel from the right
    Sidebar.tsx      # left navigation (parameterized by nav sections)
    AppShell.tsx     # standard layout: TitleBar + Sidebar + main
    SettingsPanel.tsx# theme picker + app-specific rows
    icons.tsx        # consistent SVG icon set
  lib/
    tauri.ts         # generalized wrappers (pickFiles, pickDirectory, store, ...)
  hooks/
    useRecentFiles.ts
    useDrop.ts
  types.ts           # Theme, RecentFile, DroppedFile, NavItem, NavSection
```

## Usage in an app

Each app pulls this repo in as a git subtree at `src/shared/`:

```bash
git subtree add --prefix=src/shared https://github.com/micha/local-ui.git main --squash
```

Then import from the shared directory:

```tsx
import { TitleBar } from "../shared/components/TitleBar";
import { DropZone } from "../shared/components/DropZone";
import { showToast } from "../shared/components/Toast";
import { pickFiles, pickDirectory } from "../shared/lib/tauri";
import { useRecentFiles } from "../shared/hooks/useRecentFiles";
```

In `main.tsx`, import the shared styles before app-specific ones:

```tsx
import "../shared/styles/global.css";
import "../shared/styles/components.css";
import "./styles/layout.css";
```

## Design system

- Pure monochrome OKLCH palette (light/dark/system themes)
- System sans font only
- Motion: 140–180ms with `--ease-out-expo`, respects `prefers-reduced-motion`
- Custom window chrome (no native decorations) on all apps
- No per-app accent color — the monochrome palette is the brand

## Shared Rust commands

`rust/shared_commands.rs` provides `read_file_bytes`, `write_file_bytes`, and
`file_size` — the file I/O wrappers the frontend `lib/tauri.ts` expects. Each
app copies it into `src-tauri/src/shared/` and includes it:

```rust
#[path = "shared/shared_commands.rs"]
mod shared_commands;
```

Then register the handlers in `run()`:

```rust
.invoke_handler(tauri::generate_handler![
    shared_commands::read_file_bytes,
    shared_commands::write_file_bytes,
    shared_commands::file_size,
    // app-specific commands…
])
```

## License

MIT
