# Local | Tools that stay on your machine

A suite of thirteen free, open-source desktop apps for the work you do every day. PDF, metadata, QR codes, renaming, vectorizing, image, audio, and video conversion, clipboard, encryption, color picking, secure delete, password manager. Nothing is uploaded, no account is needed, and there is no subscription. Your files never leave your computer.

[staylocal.tools](https://staylocal.tools)

## Apps

| # | App | What it does | Replaces |
|---|-----|-------------|----------|
| 01 | **Folio** | PDF toolkit: merge, split, compress, fill, sign, redact, reorder, number | Acrobat ($180/yr) |
| 02 | **Veil** | Metadata stripper: EXIF, GPS, IPTC, XMP from photos | Exif Metadata ($25/yr) |
| 03 | **Mark** | QR generator: typed payloads, colors, logo embed, CSV batch, SVG/PNG | Beaconstac ($180/yr) |
| 04 | **Shift** | File renamer: stackable rules, live preview, conflict detection, undo | Renamer ($40) |
| 05 | **Vector** | Image vectorizer: raster to SVG, presets, live preview | Vector Magic (paid) |
| 06 | **Forge** | Image converter: batch convert and compress, resize, quality, metadata strip | CloudConvert (freemium) |
| 07 | **Echo** | Audio converter: MP3, WAV, FLAC, OGG, Opus, AAC, trim silence, normalize, fade | Freemake (nagware) |
| 08 | **Reel** | Video converter: H.264, H.265, GIF, resize, trim, framerate, no FFmpeg | HandBrake (GPL) |
| 09 | **Clip** | Clipboard manager: fuzzy search, pinned snippets, encrypted at rest, tray | Ditto (dated) |
| 10 | **Seal** | File encryptor: AES-256-GCM / ChaCha20-Poly1305, Argon2id KDF | VeraCrypt (overkill) |
| 11 | **Lens** | Color picker: hotkey eyedropper, magnifying loupe, hex/RGB/HSL, palettes, tray | PowerToys (regression) |
| 12 | **Shred** | Secure delete: DoD 5220.22-M, Gutmann, custom passes, free-space wipe | File Shredder (abandoned) |
| 13 | **Vault** | Password manager: encrypted vault, Argon2id + AES-256-GCM, generator, secure notes | Bitwarden (needs server) |

## Principles

1. **Local-first**: Files never leave the machine.
2. **Single-purpose**: one app does one job well.
3. **Free and open**: MIT licensed, no paywalls, no upsells, no pro tiers.
4. **Fast and small**: Tauri v2 shell, system fonts, <15 MB installers.
5. **Honest pricing**: free.

## Tech stack

- **Tauri v2** (Rust backend + webview frontend)
- **React + TypeScript** (UI)
- **local-ui** (shared design system: pure monochrome OKLCH, system fonts, distributed via git subtree)
- **Rust crates** for all file processing (image, qrcode, vtracer, rav1e, vpx, opus, gif, argon2, chacha20poly1305, etc.)

## Build

Each app builds independently:

```bash
cd <app>
npm install
npm run build        # tsc + vite build (frontend)
cd src-tauri
cargo check          # Rust check
```

To run in dev mode:

```bash
cd <app>
npm run tauri dev
```

## Structure

```
Local/
├── local-ui/             Shared design tokens, components, hooks (git subtree source)
├── space_logo.js         ASCII logo generator (ANSI Shadow figlet)
├── README.md             This file
├── .gitignore            Root gitignore
├── Folio/                PDF toolkit
│   ├── app/folio/        Tauri app
├── Veil/                 Metadata stripper
├── Mark/                 QR generator
├── Shift/                File renamer
├── Vector/               Image vectorizer
├── Forge/                Image converter
├── Echo/                 Audio converter
├── Reel/                 Video converter
├── Clip/                 Clipboard manager
├── Seal/                 File encryptor
├── Shred/                Secure delete
├── Lens/                 Color picker
└── Vault/                Password manager
```

## Design system

All apps share the same pure-monochrome OKLCH palette, system font stack, border radii, and motion tokens via `local-ui/global.css`. No per-app accent color.

## License

MIT
