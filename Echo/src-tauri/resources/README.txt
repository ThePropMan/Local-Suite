Echo — FFmpeg
=============

FFmpeg is NOT bundled with Echo. Users provide their own ffmpeg.exe.

At runtime, Echo looks for FFmpeg in this order:
  1. A user-configured path (stored in the app settings)
  2. The system PATH (if FFmpeg is installed globally)

The app shows a setup screen on first launch if FFmpeg is not found,
with options to auto-download, browse for an existing ffmpeg.exe, or
drag-drop one in.

During development (`tauri dev` / `cargo check`) FFmpeg is optional — the
app starts and the UI works, but conversion returns a clear error until
FFmpeg is available.
