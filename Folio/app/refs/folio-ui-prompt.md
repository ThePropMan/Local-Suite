# Folio — UI implementation prompt

You are building the frontend UI for **Folio**, a local PDF toolkit desktop app built with React + TypeScript inside a Tauri shell. This prompt covers the UI only — no PDF logic, no Rust, no file system calls. Use placeholder functions wherever real operations would be invoked.

---

## What you are building

A layered desktop UI where the PDF document owns the full window and all tools float over it as overlays. There is no traditional sidebar. The document is always present. Tools come to the user, not the other way around.

---

## Tech stack

- React 18 + TypeScript
- Plain CSS with CSS custom properties (no Tailwind, no CSS-in-JS)
- Tabler Icons outline webfont for all icons
- Vite for bundling

---

## Layout concept

Three layers stacked over a full-bleed document stage:

```
┌─────────────────────────────────────────────────────┐
│  ● ● ●                    Folio                      │  ← titlebar (Tauri drag region)
├─────────────────────────────────────────────────────┤
│ [filename]  [4 pages]              [−] [+] [×]       │  ← top bar (fades on scroll)
│                                                      │
│                                                      │
│              ┌──────────────┐      ┌─────────────┐  │
│              │              │      │  Tool panel  │  │
│              │   PDF page   │      │  (slides in) │  │
│              │              │      │              │  │
│              │              │      │              │  │
│              └──────────────┘      └─────────────┘  │
│                                                      │
│         ╔══════════════════════════════╗             │
│         ║  Merge Split │ ● Compress Fill Sign Redact ║  ← floating toolbar pill
│         ╚══════════════════════════════╝             │
└─────────────────────────────────────────────────────┘
```

---

## CSS variables

Define these on `:root`. The entire UI must use only these — no hardcoded hex values anywhere.

```css
:root {
  --bg:          #ffffff;
  --bg-subtle:   #fafaf9;
  --bg-hover:    #f0f0ee;
  --bg-stage:    #e8e8e6;
  --border:      rgba(0,0,0,0.08);
  --border-mid:  #d3d1c7;
  --text-1:      #1a1a18;
  --text-2:      #5f5e5a;
  --text-3:      #888780;
  --text-4:      #b4b2a9;
  --toolbar-bg:  #1a1a18;
  --toolbar-text:#888780;
  --toolbar-active-bg: #ffffff;
  --toolbar-active-text: #1a1a18;
  --toolbar-divider: #2c2c2a;
  --radius-sm:   7px;
  --radius-md:   10px;
  --radius-pill: 40px;
  --font:        -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --ease:        120ms ease;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:          #141413;
    --bg-subtle:   #1a1a18;
    --bg-hover:    #222220;
    --bg-stage:    #0f0f0e;
    --border:      rgba(255,255,255,0.08);
    --border-mid:  #3a3a38;
    --text-1:      #f0f0ee;
    --text-2:      #888780;
    --text-3:      #5f5e5a;
    --text-4:      #3a3a38;
    --toolbar-bg:  #f0f0ee;
    --toolbar-text:#888780;
    --toolbar-active-bg: #1a1a18;
    --toolbar-active-text: #f0f0ee;
    --toolbar-divider: #d3d1c7;
  }
}
```

---

## File structure

```
src/
├── main.tsx
├── App.tsx
├── styles/
│   ├── global.css
│   └── layout.css
├── components/
│   ├── TitleBar.tsx
│   ├── Stage.tsx          # the full-bleed document viewer
│   ├── TopBar.tsx         # filename, page count, zoom controls
│   ├── Toolbar.tsx        # floating pill at the bottom
│   ├── ToolPanel.tsx      # right-side context panel (router)
│   ├── DropOverlay.tsx    # shown when no file is loaded
│   └── Toast.tsx
├── panels/                # one component per tool
│   ├── MergePanel.tsx
│   ├── SplitPanel.tsx
│   ├── CompressPanel.tsx
│   ├── FillPanel.tsx
│   ├── SignPanel.tsx
│   └── RedactPanel.tsx
└── hooks/
    ├── useActiveTool.ts
    └── useToast.ts
```

---

## State

Manage these at the `App` level and pass down as props or via context:

```ts
type Tool = 'merge' | 'split' | 'compress' | 'fill' | 'sign' | 'redact' | null

interface AppState {
  file: { name: string; pageCount: number } | null
  activeTool: Tool
  zoom: number        // 0.5 – 2.0, default 1.0
  toast: { message: string; type: 'success' | 'error' } | null
}
```

---

## Components

### `TitleBar`

```
height: 40px
background: var(--bg-subtle)
border-bottom: 0.5px solid var(--border)
data-tauri-drag-region attribute on the root div
```

Three traffic-light dots (left), app name "Folio" centred (12px, 500, `var(--text-2)`), nothing on the right.

---

### `Stage`

The document viewport. Always fills the remaining window height after the titlebar.

```
background: var(--bg-stage)
position: relative
overflow: hidden
flex: 1
```

When no file is loaded, render `<DropOverlay />` centred in the stage.

When a file is loaded, render a mock PDF page (white rectangle, `border-radius: 3px`, subtle box-shadow) centred with padding. Inside it, render placeholder content lines (gray `<div>`s of varying widths) so the layout reads clearly as a document. The PDF viewer itself is out of scope — this is the UI shell only.

Apply `transform: scale(var(--zoom))` to the inner page div, driven by the zoom state.

Always render `<TopBar />`, `<Toolbar />`, and `<ToolPanel />` as absolute children of Stage so they float over the document.

---

### `TopBar`

```
position: absolute
top: 0
left: 0
right: 0
padding: 10px 14px
display: flex
align-items: center
justify-content: space-between
background: linear-gradient(to bottom, var(--bg-stage) 0%, transparent 100%)
pointer-events: none on the container; re-enable on children
z-index: 10
```

Left side: file icon (`ti-file-type-pdf`, 14px, `var(--text-3)`), filename (12px 500 `var(--text-1)`), page count pill ("4 pages" — `var(--bg)`, 0.5px border, border-radius 20px, 11px `var(--text-3)`).

Right side: zoom-out button, zoom-in button, close button. Each is a 28px square, `var(--bg)`, 0.5px border, `var(--radius-sm)`, icon 14px `var(--text-2)`. Clicking close sets `file: null` and `activeTool: null`.

Hide TopBar when `file` is null.

---

### `Toolbar`

The centred floating pill. Always visible when a file is loaded.

```
position: absolute
bottom: 16px
left: 50%
transform: translateX(-50%)
background: var(--toolbar-bg)
border-radius: var(--radius-pill)
padding: 6px 8px
display: flex
align-items: center
gap: 2px
z-index: 20
```

Six tool buttons plus one export button, with two vertical dividers (0.5px `var(--toolbar-divider)`, 28px tall, `margin: 0 4px`):

```
[ Merge ][ Split ] | [ Compress ][ Fill ][ Sign ][ Redact ] | [ Export ]
```

Each tool button:
```
display: flex
flex-direction: column
align-items: center
gap: 3px
padding: 7px 10px
border-radius: 30px
border: none
background: transparent
color: var(--toolbar-text)
cursor: pointer
transition: background var(--ease), color var(--ease)

:hover →
  background: #2c2c2a (light) / rgba(255,255,255,0.06) (dark)
  color: var(--text-1) inverse

active (activeTool matches) →
  background: var(--toolbar-active-bg)
  color: var(--toolbar-active-text)
```

Icon: 17px. Label: 9px, 500 weight, letter-spacing 0.02em. No label on the Export button — icon only (`ti-download`, `aria-label="Export"`).

Clicking a tool button that is already active sets `activeTool: null` (toggles the panel closed).

---

### `ToolPanel`

Slides in from the right when `activeTool` is not null.

```
position: absolute
right: 12px
top: 44px
bottom: 56px
width: 200px
background: var(--bg)
border-radius: var(--radius-md)
border: 0.5px solid var(--border)
padding: 16px
display: flex
flex-direction: column
gap: 14px
z-index: 15

transition: transform 200ms ease, opacity 200ms ease

when closed:
  transform: translateX(16px)
  opacity: 0
  pointer-events: none

when open:
  transform: translateX(0)
  opacity: 1
```

Panel header: tool name in 11px uppercase `var(--text-4)` with `letter-spacing: 0.05em`. No close button — clicking the active toolbar button closes it.

Footer of every panel (pinned to bottom with `margin-top: auto`):

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-4)', fontSize: 9 }}>
  <i className="ti ti-lock" aria-hidden="true" style={{ fontSize: 10 }} />
  stays on your device
</div>
```

Route to the correct panel component based on `activeTool`.

---

### Panel components

Each panel renders its own controls inside `ToolPanel`. All actions call placeholder async functions that log to console and show a success toast after 800ms (simulating real work).

#### `MergePanel`
- A list of queued files (show 2–3 placeholder rows: icon + filename + remove button).
- An "Add more files" ghost button.
- A primary CTA: "Merge PDFs".

#### `SplitPanel`
- A text input labelled "Page ranges" with placeholder `1–3, 7, 10–12`.
- A toggle: "Split every page into separate files".
- When toggle is on, disable and grey out the text input.
- Primary CTA: "Split PDF".

#### `CompressPanel`
- Three preset buttons in a row: "Screen" / "Print" / "High". One is active at a time (pill toggle).
- A result row showing before → after size (`4.2 MB → 1.1 MB`) in a subtle inset box.
- A thin progress bar (3px, `var(--text-1)` fill) below the result row — animate it filling over 800ms when the CTA is clicked.
- Primary CTA: "Save compressed PDF".

#### `FillPanel`
- A small instruction: "Click a field in the document to start typing."
- A list of 3 detected fields (placeholder): "Full name", "Date", "Signature" — each with a status dot (filled = `var(--text-1)`, empty = `var(--border-mid)`).
- Primary CTA: "Save filled PDF".

#### `SignPanel`
- Two tabs: "Draw" and "Type". Tab strip: 12px, selected tab has `border-bottom: 1.5px solid var(--text-1)`.
- Draw tab: a 168px × 80px canvas with `border: 0.5px solid var(--border-mid)`, `border-radius: var(--radius-sm)`, `background: var(--bg-subtle)`. Basic mouse drawing (pointerdown / pointermove / pointerup). A "Clear" ghost button below it.
- Type tab: a text input with `font-family: 'Brush Script MT', cursive`, 20px, preview updates live.
- Instruction below: "Drag your signature onto the document."
- Primary CTA: "Apply signature".

#### `RedactPanel`
- Instruction: "Draw over any text or area to redact."
- A counter: "2 regions marked" (placeholder, starts at 0).
- A warning block (`background: var(--bg-subtle)`, `border-radius: var(--radius-sm)`, `border-left: 2px solid var(--text-1)`, padding 8px 10px, 11px `var(--text-2)`): "Redacted content is permanently removed."
- Primary CTA: "Save redacted PDF". Disabled until counter > 0.

---

### `DropOverlay`

Shown centred in the stage when no file is loaded.

```
display: flex
flex-direction: column
align-items: center
gap: 10px
```

A dashed drop zone rectangle:
```
border: 1.5px dashed var(--border-mid)
border-radius: var(--radius-md)
padding: 48px 40px
background: var(--bg-subtle)
```

Inside: upload icon (`ti-file-arrow-up`, 28px, `var(--text-4)`), heading "Drop a PDF to get started" (14px, 500), subtext "or pick from your files" (12px, `var(--text-3)`), a ghost button "Browse files" below.

Dragging a file over the stage should highlight the border (`var(--text-1)`) and slightly lighten the background. Use `dragover` / `dragleave` / `drop` events. On drop, read the filename from the `DataTransfer` object and set a mock file state: `{ name: droppedFile.name, pageCount: 4 }`.

---

### `Toast`

```
position: fixed
bottom: 80px
left: 50%
transform: translateX(-50%)
background: var(--text-1)
color: var(--bg)
border-radius: var(--radius-pill)
padding: 8px 16px
font-size: 13px
display: flex
align-items: center
gap: 8px
z-index: 100
```

Fade in over 150ms, auto-dismiss after 3000ms, fade out over 150ms.

Success: `ti-check` icon. Error: `ti-alert-circle` icon. No colour fills — always monochrome.

---

## Primary button style

Used as the CTA in every panel.

```css
.btn-primary {
  width: 100%;
  padding: 9px;
  background: var(--text-1);
  color: var(--bg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font);
  cursor: pointer;
  transition: opacity var(--ease);
}
.btn-primary:hover { opacity: 0.85; }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
```

---

## Ghost / secondary button style

```css
.btn-ghost {
  padding: 7px 14px;
  background: transparent;
  border: 0.5px solid var(--border-mid);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-1);
  font-family: var(--font);
  cursor: pointer;
  transition: background var(--ease);
}
.btn-ghost:hover { background: var(--bg-hover); }
```

---

## Accessibility

- All icon-only buttons need `aria-label`.
- Toolbar buttons that are active need `aria-pressed="true"`.
- The drop zone needs `role="button"`, `tabIndex={0}`, and `aria-label="Drop a PDF file or press Enter to browse"`.
- All transitions must be wrapped in `@media (prefers-reduced-motion: no-preference)`.
- Focus rings: `outline: 2px solid var(--text-1); outline-offset: 2px` on `:focus-visible`. Never remove outlines globally.

---

## Typography rules

- System sans everywhere: `var(--font)`.
- Weights: 400 regular, 500 medium only. Never 600 or 700.
- Sentence case everywhere. No ALL CAPS except section eyebrows (11px, `letter-spacing: 0.05em`, `var(--text-4)`).
- No font sizes below 9px.

---

## What done looks like

- [ ] Dropping or browsing a PDF populates the stage with the mock document and shows the TopBar and Toolbar.
- [ ] Clicking each tool button opens its panel and highlights the button as active.
- [ ] Clicking the active tool button closes the panel.
- [ ] The panel animates in and out smoothly.
- [ ] Each panel's CTA triggers a simulated 800ms action followed by a success toast.
- [ ] Sign panel Draw tab accepts mouse/touch drawing on the canvas.
- [ ] Compress panel progress bar animates on action.
- [ ] Dark mode works correctly — all colours invert cleanly.
- [ ] Zoom in/out updates the document scale.
- [ ] The close button in the top bar returns to the drop overlay.
- [ ] All buttons are keyboard-navigable with visible focus rings.
- [ ] No hardcoded hex values outside of `:root`.
