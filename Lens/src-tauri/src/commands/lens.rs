// ============================================================
// Lens — commands/lens.rs
// Screen pixel capture, color conversion, history, palettes.
// ============================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ---------- Types ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ColorResult {
    pub hex: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub h: f64,
    pub s: f64,
    pub l: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ColorEntry {
    pub hex: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Palette {
    pub id: String,
    pub name: String,
    pub colors: Vec<String>, // hex strings
    pub created: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LoupeData {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>, // RGBA, row-major, width*height*4
    pub center_hex: String,
    pub center_r: u8,
    pub center_g: u8,
    pub center_b: u8,
}

// ---------- Color conversion ----------

pub fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-9 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + (if g < b { 6.0 } else { 0.0 })
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s * 100.0, l * 100.0)
}

fn make_color_result(r: u8, g: u8, b: u8) -> ColorResult {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    ColorResult {
        hex: rgb_to_hex(r, g, b),
        r,
        g,
        b,
        h: (h * 10.0).round() / 10.0,
        s: (s * 10.0).round() / 10.0,
        l: (l * 10.0).round() / 10.0,
    }
}

// ---------- Storage paths ----------

fn app_data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn history_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("history.json")
}

fn palettes_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("palettes.json")
}

// ---------- Screen capture (Windows) ----------

#[cfg(windows)]
pub mod win_capture {
    use windows_sys::Win32::Foundation::{POINT, COLORREF};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetPixel, SelectObject, StretchBlt,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
        GetDC, ReleaseDC,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    pub fn get_cursor_position() -> (i32, i32) {
        unsafe {
            let mut point = POINT { x: 0, y: 0 };
            let _ = GetCursorPos(&mut point);
            (point.x, point.y)
        }
    }

    pub fn capture_pixel(x: i32, y: i32) -> (u8, u8, u8) {
        unsafe {
            let hdc = GetDC(0 as _);
            if hdc.is_null() {
                return (0, 0, 0);
            }
            let color: COLORREF = GetPixel(hdc, x, y);
            ReleaseDC(0 as _, hdc);
            let r = (color & 0xFF) as u8;
            let g = ((color >> 8) & 0xFF) as u8;
            let b = ((color >> 16) & 0xFF) as u8;
            (r, g, b)
        }
    }

    pub fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
        unsafe {
            let hdc_screen = GetDC(0 as _);
            if hdc_screen.is_null() {
                return vec![0; (w * h * 4) as usize];
            }
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ReleaseDC(0 as _, hdc_screen);
                return vec![0; (w * h * 4) as usize];
            }
            let hbmp = CreateCompatibleBitmap(hdc_screen, w, h);
            if hbmp.is_null() {
                DeleteDC(hdc_mem);
                ReleaseDC(0 as _, hdc_screen);
                return vec![0; (w * h * 4) as usize];
            }
            let old = SelectObject(hdc_mem, hbmp);

            // Use StretchBlt for CAPTUREBLT (includes layered windows)
            let _ = StretchBlt(
                hdc_mem, 0, 0, w, h,
                hdc_screen, x, y, w, h,
                SRCCOPY | CAPTUREBLT,
            );

            // Read pixels via GetDIBits
            let mut bi = std::mem::zeroed::<BITMAPINFO>();
            let hdr = &mut bi.bmiHeader;
            hdr.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            hdr.biWidth = w;
            hdr.biHeight = -h; // top-down
            hdr.biPlanes = 1;
            hdr.biBitCount = 32;
            hdr.biCompression = BI_RGB;

            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let _ = windows_sys::Win32::Graphics::Gdi::GetDIBits(
                hdc_mem,
                hbmp,
                0,
                h as u32,
                pixels.as_mut_ptr() as *mut _,
                &mut bi as *mut BITMAPINFO,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc_mem, old);
            let _ = DeleteObject(hbmp);
            DeleteDC(hdc_mem);
            ReleaseDC(0 as _, hdc_screen);

            // GetDIBits returns BGRA; convert to RGBA
            let mut rgba = vec![0u8; pixels.len()];
            for i in (0..pixels.len()).step_by(4) {
                rgba[i] = pixels[i + 2];     // R
                rgba[i + 1] = pixels[i + 1]; // G
                rgba[i + 2] = pixels[i];     // B
                rgba[i + 3] = 255;           // A
            }
            rgba
        }
    }
}

#[cfg(not(windows))]
pub mod fallback_capture {
    pub fn get_cursor_position() -> (i32, i32) { (0, 0) }
    pub fn capture_pixel(_x: i32, _y: i32) -> (u8, u8, u8) { (0, 0, 0) }
    pub fn capture_region(_x: i32, _y: i32, w: i32, h: i32) -> Vec<u8> {
        vec![0; (w * h * 4) as usize]
    }
}

#[cfg(windows)]
pub use win_capture as capture;
#[cfg(not(windows))]
pub use fallback_capture as capture;

// ---------- Tauri commands ----------

/// Capture the pixel under the cursor.
#[tauri::command]
pub fn pick_color() -> Result<ColorResult, String> {
    let (x, y) = capture::get_cursor_position();
    let (r, g, b) = capture::capture_pixel(x, y);
    Ok(make_color_result(r, g, b))
}

/// Capture a small region around the cursor for the loupe.
/// Returns RGBA pixels + center color.
#[tauri::command]
pub fn capture_loupe_region(size: Option<u32>) -> Result<LoupeData, String> {
    let size = size.unwrap_or(15) as i32;
    let half = size / 2;
    let (cx, cy) = capture::get_cursor_position();
    let x = cx - half;
    let y = cy - half;
    let pixels = capture::capture_region(x, y, size, size);
    let (r, g, b) = capture::capture_pixel(cx, cy);
    Ok(LoupeData {
        width: size as u32,
        height: size as u32,
        pixels,
        center_hex: rgb_to_hex(r, g, b),
        center_r: r,
        center_g: g,
        center_b: b,
    })
}

/// Get cursor position (for positioning the loupe window).
#[tauri::command]
pub fn get_cursor_pos() -> Result<(i32, i32), String> {
    Ok(capture::get_cursor_position())
}

// ---------- History ----------

/// Core logic: add a color to history and return the updated list.
/// Shared between the Tauri command and the native click thread.
pub fn add_to_history_impl(app: &AppHandle, color: ColorEntry) -> Result<Vec<ColorEntry>, String> {
    let path = history_path(app);
    let mut history = if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read history: {e}"))?;
        serde_json::from_str::<Vec<ColorEntry>>(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    // Deduplicate: remove existing entry with same hex, then prepend
    history.retain(|e| e.hex != color.hex);
    history.insert(0, color);
    // Cap at 50 entries
    history.truncate(50);
    let json = serde_json::to_string_pretty(&history).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write history: {e}"))?;
    Ok(history)
}

#[tauri::command]
pub fn get_history(app: AppHandle) -> Result<Vec<ColorEntry>, String> {
    let path = history_path(&app);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read history: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse history: {e}"))
}

#[tauri::command]
pub fn add_to_history(app: AppHandle, color: ColorEntry) -> Result<Vec<ColorEntry>, String> {
    add_to_history_impl(&app, color)
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to clear history: {e}"))?;
    }
    Ok(())
}

// ---------- Palettes ----------

#[tauri::command]
pub fn load_palettes(app: AppHandle) -> Result<Vec<Palette>, String> {
    let path = palettes_path(&app);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read palettes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse palettes: {e}"))
}

#[tauri::command]
pub fn save_palette(app: AppHandle, palette: Palette) -> Result<Vec<Palette>, String> {
    let path = palettes_path(&app);
    let mut palettes = if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read palettes: {e}"))?;
        serde_json::from_str::<Vec<Palette>>(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    // Replace if same id, otherwise add
    if let Some(existing) = palettes.iter_mut().find(|p| p.id == palette.id) {
        *existing = palette;
    } else {
        palettes.push(palette);
    }
    let json = serde_json::to_string_pretty(&palettes).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write palettes: {e}"))?;
    Ok(palettes)
}

#[tauri::command]
pub fn delete_palette(app: AppHandle, id: String) -> Result<Vec<Palette>, String> {
    let path = palettes_path(&app);
    let mut palettes = if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read palettes: {e}"))?;
        serde_json::from_str::<Vec<Palette>>(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    palettes.retain(|p| p.id != id);
    let json = serde_json::to_string_pretty(&palettes).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write palettes: {e}"))?;
    Ok(palettes)
}

#[tauri::command]
pub fn export_palette(palette: Palette, format: String) -> Result<String, String> {
    match format.as_str() {
        "json" => serde_json::to_string_pretty(&palette.colors)
            .map_err(|e| format!("Export error: {e}")),
        "css" => {
            let mut css = String::from(":root {\n");
            for (i, color) in palette.colors.iter().enumerate() {
                css.push_str(&format!("  --color-{}: {};\n", i, color));
            }
            css.push_str("}\n");
            Ok(css)
        }
        _ => Err(format!("Unknown export format: {format}")),
    }
}
