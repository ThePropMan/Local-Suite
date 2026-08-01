# Folio — coding agent prompt

You are building **Folio**, a free, open-source, local-first PDF toolkit desktop app. Your job is to implement the full application end to end, from project scaffolding to a shippable v1.

---

## What you are building

A desktop app that lets everyday people do the most common PDF tasks — without uploading their files anywhere, without an account, and without paying. The entire pitch lives in three words: **local, free, clean.**

The target user is not a developer. It is a teacher filling out a form, a freelancer signing an invoice, a parent merging school documents. Every decision should serve that person.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri v2** (Rust) | Small binary (~10 MB), fast startup, OS-native webview, no Chromium bundle |
| Frontend | **React 18 + TypeScript** | Component model suits the tool-per-screen layout |
| Styling | **Plain CSS with CSS variables** | No Tailwind, no CSS-in-JS — keeps the bundle small and styles readable |
| PDF operations (JS) | **pdf-lib** | Merge, split, rotate, fill forms, add signatures in pure JS |
| PDF operations (Rust) | **lopdf crate** | Compression, redaction — operations that need native performance |
| Icons | **Tabler Icons (outline only)** | Consistent, clean, MIT licensed |
| Build | **Vite** | Fast HMR, small output |

Do not add dependencies that are not listed here without a clear justification. Keep `node_modules` lean.

---

## Project structure

Scaffold the project with `create-tauri-app` using the React + TypeScript template, then organise the source as follows:

```
folio/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # Tauri app entry, command registration
│   │   ├── commands/
│   │   │   ├── compress.rs  # Ghostscript / lopdf compression
│   │   │   └── redact.rs    # Permanent text removal
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── main.tsx             # React entry
│   ├── App.tsx              # Root layout: sidebar + main panel router
│   ├── styles/
│   │   ├── global.css       # CSS variables, reset, base typography
│   │   └── components.css   # Shared component styles
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── DropZone.tsx
│   │   ├── ToolCard.tsx
│   │   ├── RecentFiles.tsx
│   │   └── Toast.tsx
│   ├── tools/               # One folder per tool
│   │   ├── merge/
│   │   │   ├── MergeTool.tsx
│   │   │   └── merge.ts     # pdf-lib logic
│   │   ├── split/
│   │   ├── compress/
│   │   ├── sign/
│   │   ├── fill/
│   │   └── redact/
│   ├── hooks/
│   │   ├── useRecentFiles.ts
│   │   └── usePdfDrop.ts
│   └── lib/
│       └── tauri.ts         # Typed wrappers around invoke()
├── index.html
├── vite.config.ts
└── package.json
```

---

## Visual design

### Aesthetic
Black and white. Clean. Minimal. The PDF is the most colourful thing on screen. Think of a well-designed print tool, not a creative suite.

No gradients. No shadows (except a single `0 0 0 1px` focus ring). No animations beyond a 120ms ease opacity fade on toasts and panel transitions.

### CSS variables — define these on `:root`

```css
:root {
  --bg:        #ffffff;
  --bg-subtle: #fafaf9;
  --bg-hover:  #f0f0ee;
  --border:    #e8e8e6;
  --border-mid: #d3d1c7;
  --text-1:    #1a1a18;   /* primary */
  --text-2:    #5f5e5a;   /* secondary */
  --text-3:    #b4b2a9;   /* muted / labels */
  --accent:    #1a1a18;   /* CTA buttons — same as text-1, no colour accent */
  --radius-sm: 7px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --font:      -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono:      "JetBrains Mono", "Fira Code", monospace;
}
```

For dark mode, override under `@media (prefers-color-scheme: dark)`:
```css
  --bg:        #141413;
  --bg-subtle: #1a1a18;
  --bg-hover:  #222220;
  --border:    #2c2c2a;
  --border-mid: #3a3a38;
  --text-1:    #f0f0ee;
  --text-2:    #888780;
  --text-3:    #5f5e5a;
  --accent:    #f0f0ee;
```

### Layout

```
┌─────────────────────────────────────────────────┐
│  ● ● ●   [window chrome]          Folio          │
├──────────┬──────────────────────────────────────┤
│          │                                       │
│ Home     │   [drop zone — tall, centred]         │
│ Recent   │                                       │
│ Settings │   Tools                               │
│          │   [3-col grid of ToolCards]           │
│          │                                       │
│          │   Recent                              │
│ ──────── │   [list of last 5 files]              │
│ All local│                                       │
│ tagline  │                                       │
└──────────┴──────────────────────────────────────┘
```

Sidebar: 176px fixed, `var(--bg-subtle)` background, `0.5px solid var(--border)` right border.  
Main panel: flex-grow, `var(--bg)` background, `28px 32px` padding.  
Window drag region: the titlebar div should have `data-tauri-drag-region`.

### Typography

- Font: system sans (`var(--font)`) everywhere. No web fonts — keep startup instant.
- Sizes: 22px h1, 16px h2, 13px body, 11px label/caption.
- Weight: 400 regular, 500 medium. Never 600 or 700.
- All labels in sentence case. No ALL CAPS except the section eyebrows (11px, `letter-spacing: 0.05em`, `var(--text-3)`).

### Component patterns

**ToolCard**
```
background: var(--bg-subtle)
border: 0.5px solid var(--border)
border-radius: var(--radius-sm)
padding: 14px 12px
cursor: pointer
transition: background 120ms ease

:hover → background: var(--bg-hover), border-color: var(--border-mid)
```
Contains: Tabler icon (20px, `var(--text-2)`), tool name (13px 500 `var(--text-1)`), one-line description (11px `var(--text-3)`).

**Primary button** (used in tool screens for the action CTA)
```
background: var(--accent)
color: var(--bg)
border: none
border-radius: var(--radius-sm)
padding: 9px 20px
font-size: 13px
font-weight: 500
cursor: pointer
```

**Secondary button / ghost**
```
background: transparent
border: 0.5px solid var(--border-mid)
color: var(--text-1)
(same padding/radius as primary)
```

**Toast notifications** — appear bottom-right, 300ms fade in/out, auto-dismiss after 3s.  
Success: `var(--text-1)` text + a small checkmark icon.  
Error: same but with an `x-circle` icon.  
Never use colour fills for toasts — keep them monochrome.

---

## Features — v1 scope

Implement exactly these six tools. Nothing else.

### 1. Merge
- Accept multiple PDF files via drag-and-drop or file picker (multi-select).
- Show a reorderable list of the queued files (drag handle on each row).
- "Merge" button calls `pdf-lib`: loads all PDFs, copies pages in order, saves output.
- Output filename: `merged_[timestamp].pdf`, saved to the same directory as the first input file (or user-chosen via Tauri save dialog).

### 2. Split
- Accept one PDF.
- Show a page range input: "Pages 1–3, 7, 10–12" with plain text parsing.
- Also offer a "Split every page into separate files" toggle.
- Output: one file per range, named `[original]_p1-3.pdf` etc.

### 3. Compress
- Accept one PDF.
- Show three quality presets: Screen (72 dpi), Print (150 dpi), High quality (300 dpi).
- Invoke the Rust `compress` command, which shells out to Ghostscript if available, or falls back to re-saving with `lopdf` at reduced image quality.
- Show before/after file size on completion.
- If Ghostscript is not installed, show a non-blocking notice: "Install Ghostscript for best compression results" with a link to the download page.

### 4. Fill form
- Accept one PDF.
- Render the PDF in a scrollable canvas using `pdf-lib`'s field detection.
- Display form fields as native HTML inputs overlaid on the rendered page.
- "Save filled PDF" exports the completed form.
- If the PDF has no form fields, show a clear message: "This PDF has no fillable fields."

### 5. Sign
- Accept one PDF.
- Show a signature panel with two tabs: Draw (canvas, mouse/touch) and Type (text rendered in a handwriting-style system font — use `"Brush Script MT", cursive` if available).
- User drags the signature to position it on the page.
- Flatten the signature into the PDF on export (not an interactive annotation — a rasterised stamp).

### 6. Redact
- Accept one PDF.
- User draws black rectangles over text/areas to redact.
- On export, invoke the Rust `redact` command which permanently removes the underlying content (not just covers it visually) using `lopdf`.
- Show a warning before export: "Redacted content is permanently removed and cannot be recovered."

---

## Tauri commands (Rust side)

Register these `#[tauri::command]` functions in `main.rs`:

```rust
compress_pdf(input_path: String, output_path: String, quality: String) -> Result<u64, String>
// Returns output file size in bytes. quality is "screen" | "print" | "high".

redact_pdf(input_path: String, output_path: String, regions: Vec<RedactRegion>) -> Result<(), String>
// RedactRegion: { page: u32, x: f32, y: f32, width: f32, height: f32 }
```

All other operations (merge, split, sign, fill) run entirely in the JS/pdf-lib layer and use Tauri's `fs` plugin only for reading/writing files. Do not add Rust commands that aren't necessary.

---

## Recent files

- Store the last 10 opened/processed files in Tauri's local app data store (`tauri-plugin-store`).
- Persist: `{ name, path, tool, timestamp, sizeBefore, sizeAfter? }`.
- Show the last 5 in the home screen Recent list.
- Show all 10 on the Recent page.
- Clicking a recent file reopens it in the tool that last processed it.

---

## Settings screen

Keep it minimal — three options only:

1. Default output folder (directory picker, defaults to same folder as input).
2. Theme: System / Light / Dark.
3. A "Clear recent files" button.

---

## Privacy & security

- **No network requests.** The app must make zero outbound connections. Add a Tauri CSP that blocks all external origins:
  ```json
  "security": {
    "csp": "default-src 'self'; script-src 'self'; connect-src 'none'"
  }
  ```
- **No telemetry.** Do not add any analytics, crash reporting, or update-check that phones home.
- **File access scope.** Use Tauri's `fs` plugin with the minimum required scope — only paths the user explicitly opens or saves to.

---

## Error handling

- All tool operations must be wrapped in try/catch (JS) or `Result` (Rust).
- Surface errors via the Toast system, never via `alert()` or `console.error` alone.
- Error messages must say what went wrong and what to do: "Couldn't read this file. Make sure it's a valid PDF and isn't password-protected."
- Password-protected PDFs: detect early, show a clear message, do not crash.

---

## Accessibility

- All interactive elements must be keyboard-navigable with visible focus rings (`outline: 2px solid var(--text-1); outline-offset: 2px`).
- All icons used as the sole content of a button need `aria-label`. Decorative icons get `aria-hidden="true"`.
- The drop zone must be reachable by keyboard and announce its state to screen readers via `aria-live`.
- Respect `prefers-reduced-motion`: wrap all transitions in `@media (prefers-reduced-motion: no-preference)`.

---

## Platform targets

Build and test on macOS and Windows. Linux support is a bonus but not required for v1. Use Tauri's cross-compilation support. The macOS build must be code-signed for Gatekeeper to allow it to run (use an ad-hoc signature for development: `codesign --deep --force --sign - Folio.app`).

---

## What done looks like

The app is complete when:

- [ ] All six tools work end to end on real PDF files.
- [ ] The app opens in under 1 second on a 2020-era machine.
- [ ] The binary + installer is under 20 MB on macOS and Windows.
- [ ] No network requests are made at any point (verify with a network monitor).
- [ ] Dark mode works correctly on both platforms.
- [ ] All six tools are keyboard-accessible.
- [ ] Recent files persist across app restarts.
- [ ] A `README.md` exists with: what the app is, how to build it locally, and how to contribute.
- [ ] A `LICENSE` file exists (MIT).

---

## What not to build

Do not build any of the following — they are explicitly out of scope for v1:

- OCR or text extraction
- PDF to Word / image conversion
- Cloud sync or sharing
- Collaboration features
- A browser extension
- Any kind of account, login, or user profile
- In-app updates (ship a GitHub releases page instead)
- A page editor or annotation layer beyond signatures and redaction rectangles

---

## Development order

Work in this sequence to keep things unblocked:

1. Scaffold the Tauri + React + TypeScript project.
2. Implement the global layout (sidebar, main panel, CSS variables, dark mode).
3. Build the DropZone and ToolCard components with placeholder navigation.
4. Implement Merge (simplest, pure JS, validates the pdf-lib integration).
5. Implement Split.
6. Implement the Rust compress command + the Compress tool UI.
7. Implement Fill form.
8. Implement Sign.
9. Implement the Rust redact command + Redact tool UI.
10. Wire up Recent files and Settings.
11. Final pass: accessibility, error handling, keyboard nav, CSP lockdown.
12. Write the README.

---

## A note on quality

This app will be used by people who are frustrated with bloated, expensive software. The bar is: it should feel like it was made by someone who cares. That means no loading spinners for operations that take under 200ms, no jargon in error messages, no features that require reading a tooltip to understand, and a UI that looks the same on day one as it does after a year of updates.

When in doubt, do less, and do it well.
