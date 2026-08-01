// ============================================================
// commands/generate.rs — QR code generation, PNG/SVG export,
// logo compositing, and CSV batch generation.
//
// All computation happens locally in Rust. The frontend sends
// the already-encoded QR payload string plus rendering options;
// this module turns it into a raster PNG (base64) and a vector
// SVG string.
// ============================================================

use std::io::Cursor;
use std::path::Path;

use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use qrcode::{EcLevel, QrCode, types::Color};
use serde::{Deserialize, Serialize};

// ---------- Types ----------

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct QrOptions {
    /// Error correction level: "L" | "M" | "Q" | "H"
    pub ec_level: String,
    /// Output raster size in pixels (square).
    pub size_px: u32,
    /// Quiet zone width in modules.
    pub margin_modules: u32,
    /// Foreground (dark module) color, RGBA 0-255.
    pub fg_color: [u8; 4],
    /// Background (light module) color, RGBA 0-255.
    pub bg_color: [u8; 4],
    /// Optional path to a logo image composited into the center.
    pub logo_path: Option<String>,
    /// Logo size as a fraction of the QR width (0.0 - 0.3). Default 0.2.
    pub logo_ratio: Option<f32>,
}

#[derive(Serialize)]
pub struct QrResult {
    pub png_base64: String,
    pub svg: String,
    pub modules: usize,
    pub size_px: u32,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct BatchRow {
    /// File-name friendly label for this row.
    pub label: String,
    /// Already-encoded QR payload.
    pub data: String,
}

#[derive(Serialize)]
pub struct BatchItem {
    pub label: String,
    pub png_base64: String,
    pub svg: String,
    pub ok: bool,
    pub message: Option<String>,
}

// ---------- EC level parsing ----------

fn parse_ec(s: &str) -> Result<EcLevel, String> {
    match s.to_ascii_uppercase().as_str() {
        "L" => Ok(EcLevel::L),
        "M" => Ok(EcLevel::M),
        "Q" => Ok(EcLevel::Q),
        "H" => Ok(EcLevel::H),
        other => Err(format!("Unknown error correction level: {other}")),
    }
}

// ---------- Color helpers ----------

fn to_rgba(c: [u8; 4]) -> Rgba<u8> {
    Rgba([c[0], c[1], c[2], c[3]])
}

/// Format an RGBA array as `#rrggbb` (alpha dropped — SVG QRs are opaque).
fn to_hex(c: [u8; 4]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Format an f32 for SVG attributes, trimming trailing zeros (e.g. `4.5`, `12`).
fn format_float(n: f32) -> String {
    let rounded = (n * 1000.0).round() / 1000.0;
    let s = format!("{:.3}", rounded);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

// ---------- Core render ----------

/// Build the QR matrix, the raster PNG bytes, and the SVG string for one payload.
/// Returns `(png_bytes, svg_string, module_count, optional_warning)`.
fn render_qr(data: &str, options: &QrOptions) -> Result<(Vec<u8>, String, usize, Option<String>), String> {
    let ec = parse_ec(&options.ec_level)?;
    let code = QrCode::with_error_correction_level(data.as_bytes(), ec)
        .map_err(|e| format!("Failed to encode QR: {e}"))?;
    let modules = code.width();
    let margin = options.margin_modules;
    let total = (modules as u32) + 2 * margin;

    // ---- Raster PNG ----
    let size_px = options.size_px.max(64);
    // Pixels per module (floor). The rendered QR is centered in size_px.
    let scale = (size_px / total).max(1);
    let rendered = scale * total;
    let offset = (size_px - rendered) / 2;

    let mut img: RgbaImage = ImageBuffer::from_pixel(size_px, size_px, to_rgba(options.bg_color));

    let fg = to_rgba(options.fg_color);
    for y in 0..modules {
        for x in 0..modules {
            if code[(x, y)] == Color::Dark {
                let px = offset + (margin + x as u32) * scale;
                let py = offset + (margin + y as u32) * scale;
                for dy in 0..scale {
                    for dx in 0..scale {
                        img.put_pixel(px + dx, py + dy, fg);
                    }
                }
            }
        }
    }

    // ---- Logo compositing ----
    let mut message: Option<String> = None;
    if let Some(path) = options.logo_path.as_deref() {
        if !path.is_empty() && Path::new(path).exists() {
            match image::open(path) {
                Ok(logo) => {
                    let ratio = options.logo_ratio.unwrap_or(0.2).clamp(0.05, 0.3);
                    // Logo occupies `ratio` of the QR width (the quiet zone excluded).
                    let qr_rendered = scale * (modules as u32);
                    let logo_target = ((qr_rendered as f32) * ratio).round() as u32;
                    let pad = (logo_target / 8).max(4);
                    let box_size = logo_target + 2 * pad;
                    let cx = size_px / 2;
                    let cy = size_px / 2;
                    let box_x = cx.saturating_sub(box_size / 2);
                    let box_y = cy.saturating_sub(box_size / 2);

                    // White padding box behind the logo.
                    let white = Rgba([255, 255, 255, 255]);
                    for dy in 0..box_size {
                        for dx in 0..box_size {
                            let x = box_x + dx;
                            let y = box_y + dy;
                            if x < size_px && y < size_px {
                                img.put_pixel(x, y, white);
                            }
                        }
                    }

                    // Resize and overlay the logo.
                    let resized = logo.resize_exact(
                        logo_target,
                        logo_target,
                        image::imageops::FilterType::Lanczos3,
                    );
                    let logo_x = cx.saturating_sub(logo_target / 2);
                    let logo_y = cy.saturating_sub(logo_target / 2);
                    let view = resized.to_rgba8();
                    for (lx, ly, pixel) in view.enumerate_pixels() {
                        let x = logo_x + lx;
                        let y = logo_y + ly;
                        if x < size_px && y < size_px && pixel.0[3] > 0 {
                            img.put_pixel(x, y, *pixel);
                        }
                    }
                }
                Err(e) => {
                    message = Some(format!("Could not load logo: {e}"));
                }
            }
        }
    }

    let mut png_buf: Vec<u8> = Vec::new();
    DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut png_buf), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {e}"))?;

    // ---- SVG ----
    let fg_hex = to_hex(options.fg_color);
    let bg_hex = to_hex(options.bg_color);
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {total}\" shape-rendering=\"crispEdges\" width=\"{total}\" height=\"{total}\">\n  <rect width=\"{total}\" height=\"{total}\" fill=\"{bg_hex}\"/>\n",
        total = total,
        bg_hex = bg_hex,
    );
    // One path rect per dark module, using a single <path> with relative h/v commands.
    let mut path = String::with_capacity(modules * modules / 2);
    for y in 0..modules {
        for x in 0..modules {
            if code[(x, y)] == Color::Dark {
                let gx = (margin + x as u32) as i32;
                let gy = (margin + y as u32) as i32;
                path.push_str(&format!("M{gx},{gy}h1v1h-1z"));
            }
        }
    }
    svg.push_str(&format!("  <path fill=\"{fg_hex}\" d=\"{path}\"/>\n", fg_hex = fg_hex));

    // ---- Logo embedding (SVG) ----
    // Mirrors the PNG compositing: a white padding box behind the logo,
    // centered on the QR. Coordinates are in module units (the SVG viewBox).
    if let Some(path) = options.logo_path.as_deref() {
        if !path.is_empty() && Path::new(path).exists() {
            match image::open(path) {
                Ok(logo) => {
                    let ratio = options.logo_ratio.unwrap_or(0.2).clamp(0.05, 0.3);
                    // Logo occupies `ratio` of the QR width (quiet zone excluded).
                    let logo_target = (modules as f32) * ratio;
                    let pad = (logo_target / 8.0).max(4.0 / scale as f32);
                    let box_size = logo_target + 2.0 * pad;
                    let cx = total as f32 / 2.0;
                    let cy = total as f32 / 2.0;
                    let box_x = cx - box_size / 2.0;
                    let box_y = cy - box_size / 2.0;
                    let logo_x = cx - logo_target / 2.0;
                    let logo_y = cy - logo_target / 2.0;

                    // White padding box behind the logo.
                    svg.push_str(&format!(
                        "  <rect x=\"{bx}\" y=\"{by}\" width=\"{bw}\" height=\"{bh}\" fill=\"#ffffff\"/>\n",
                        bx = format_float(box_x),
                        by = format_float(box_y),
                        bw = format_float(box_size),
                        bh = format_float(box_size),
                    ));

                    // Re-encode the logo as PNG and embed as a base64 data URI.
                    let resized = logo.resize_exact(
                        logo_target.round().max(1.0) as u32,
                        logo_target.round().max(1.0) as u32,
                        image::imageops::FilterType::Lanczos3,
                    );
                    let mut logo_buf: Vec<u8> = Vec::new();
                    let encode_logo = DynamicImage::ImageRgba8(resized.to_rgba8())
                        .write_to(&mut Cursor::new(&mut logo_buf), image::ImageFormat::Png);
                    match encode_logo {
                        Ok(()) => {
                            let b64 = general_purpose::STANDARD.encode(&logo_buf);
                            svg.push_str(&format!(
                                "  <image href=\"data:image/png;base64,{b64}\" x=\"{lx}\" y=\"{ly}\" width=\"{lw}\" height=\"{lh}\" preserveAspectRatio=\"none\"/>\n",
                                b64 = b64,
                                lx = format_float(logo_x),
                                ly = format_float(logo_y),
                                lw = format_float(logo_target),
                                lh = format_float(logo_target),
                            ));
                        }
                        Err(e) => {
                            if message.is_none() {
                                message = Some(format!("Could not encode logo for SVG: {e}"));
                            }
                        }
                    }
                }
                Err(e) => {
                    if message.is_none() {
                        message = Some(format!("Could not load logo: {e}"));
                    }
                }
            }
        }
    }

    svg.push_str("</svg>\n");

    Ok((png_buf, svg, modules, message))
}

// ---------- Commands ----------

#[tauri::command]
pub fn generate_qr(data: String, options: QrOptions) -> Result<QrResult, String> {
    if data.trim().is_empty() {
        return Ok(QrResult {
            png_base64: String::new(),
            svg: String::new(),
            modules: 0,
            size_px: options.size_px,
            ok: false,
            message: Some("Nothing to encode yet — type something to generate a code.".into()),
        });
    }
    let (png, svg, modules, message) = render_qr(&data, &options)?;
    let png_base64 = general_purpose::STANDARD.encode(&png);
    Ok(QrResult {
        png_base64,
        svg,
        modules,
        size_px: options.size_px,
        ok: true,
        message,
    })
}

/// Wrap a PNG into a minimal single-page PDF (one page containing the image).
/// The PDF is a hand-crafted text structure that embeds the PNG as an XObject.
fn png_to_pdf(png: &[u8], size_px: u32) -> Result<Vec<u8>, String> {
    // Use PostScript points: 1 pt = 1/72 inch. Place the square image on a
    // page sized to the image with a small margin so it isn't clipped.
    let margin_pt = 18.0; // 0.25 inch
    let img_pt = size_px as f32 * 0.75; // 96 dpi -> 72 dpi (px * 72/96)
    let page_w = img_pt + 2.0 * margin_pt;
    let page_h = page_w;

    let png_b64 = general_purpose::STANDARD.encode(png);
    let png_len = png.len();

    // Build the PDF objects. We reference the PNG bytes as a hex-encoded
    // stream (ASCIIHexDecode) so the whole document stays text-based and
    // easy to assemble without binary offsets.
    let mut objects: Vec<String> = Vec::new();

    // Object 1: Catalog
    objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string());
    // Object 2: Pages
    objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string());
    // Object 3: Page
    objects.push(format!(
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        pw = format_float(page_w),
        ph = format_float(page_h),
    ));
    // Object 4: Image XObject (the PNG, hex-encoded stream)
    objects.push(format!(
        "4 0 obj\n<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length {len} >>\nstream\n{b64}>\nendstream\nendobj\n",
        w = size_px,
        h = size_px,
        len = png_b64.len() + 1, // hex digits plus trailing '>'
        b64 = png_b64,
    ));
    // Object 5: Content stream — draw the image centered on the page.
    let _ = png_len; // referenced via the hex stream above
    let content = format!(
        "q\n{w} 0 0 {h} {x} {y} cm\n/Im1 Do\nQ\n",
        w = format_float(img_pt),
        h = format_float(img_pt),
        x = format_float(margin_pt),
        y = format_float(margin_pt),
    );
    objects.push(format!(
        "5 0 obj\n<< /Length {len} >>\nstream\n{content}endstream\nendobj\n",
        len = content.len(),
        content = content,
    ));

    let mut pdf = String::new();
    pdf.push_str("%PDF-1.4\n");
    let mut offsets: Vec<usize> = Vec::new();
    for obj in &objects {
        offsets.push(pdf.len());
        pdf.push_str(obj);
    }
    let xref_start = pdf.len();
    pdf.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    pdf.push_str("0000000000 65535 f \n");
    for off in &offsets {
        pdf.push_str(&format!("{:010} 00000 n \n", off));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        size = objects.len() + 1,
        xref = xref_start,
    ));

    Ok(pdf.into_bytes())
}

#[tauri::command]
pub fn generate_pdf(data: String, options: QrOptions) -> Result<String, String> {
    if data.trim().is_empty() {
        return Err("Nothing to encode yet — type something to generate a code.".into());
    }
    let (png, _svg, _modules, _message) = render_qr(&data, &options)?;
    let pdf = png_to_pdf(&png, options.size_px)?;
    Ok(general_purpose::STANDARD.encode(&pdf))
}

#[tauri::command]
pub fn generate_qr_batch(rows: Vec<BatchRow>, options: QrOptions) -> Result<Vec<BatchItem>, String> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if row.data.trim().is_empty() {
            out.push(BatchItem {
                label: row.label,
                png_base64: String::new(),
                svg: String::new(),
                ok: false,
                message: Some("Empty payload.".into()),
            });
            continue;
        }
        match render_qr(&row.data, &options) {
            Ok((png, svg, _modules, message)) => {
                out.push(BatchItem {
                    label: row.label,
                    png_base64: general_purpose::STANDARD.encode(&png),
                    svg,
                    ok: true,
                    message,
                });
            }
            Err(e) => {
                out.push(BatchItem {
                    label: row.label,
                    png_base64: String::new(),
                    svg: String::new(),
                    ok: false,
                    message: Some(e),
                });
            }
        }
    }
    Ok(out)
}
