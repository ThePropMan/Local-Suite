// Convert raster images to SVG with vtracer and return a local preview.
// When SVG rasterization is unavailable, the preview uses the original image
// at the target size. The SVG remains the actual output.

use std::io::Cursor;
use std::path::Path;

use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use vtracer::{ColorImage, ColorMode, Config, Hierarchical, SvgFile};
use visioncortex::PathSimplifyMode;

// ---------- Types ----------

#[derive(Deserialize, Clone)]
pub struct VectorOptions {
    pub color_mode: String,
    pub hierarchical: String,
    pub filter_speckle: usize,
    pub color_precision: i32,
    pub layer_difference: i32,
    pub mode: String,
    pub corner_threshold: i32,
    pub length_threshold: f64,
    pub max_iterations: usize,
    pub splice_threshold: i32,
    pub path_precision: Option<u32>,
}

#[derive(Serialize)]
pub struct VectorResult {
    pub preview_png_base64: String,
    pub svg: String,
    pub width: usize,
    pub height: usize,
    pub svg_bytes: usize,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct BatchVectorResult {
    pub name: String,
    pub preview_png_base64: String,
    pub svg: String,
    pub svg_bytes: usize,
    pub ok: bool,
    pub message: Option<String>,
}

// ---------- Config parsing ----------

fn parse_color_mode(s: &str) -> Result<ColorMode, String> {
    match s {
        "color" => Ok(ColorMode::Color),
        "binary" => Ok(ColorMode::Binary),
        other => Err(format!("Unknown color_mode: {other}")),
    }
}

fn parse_hierarchical(s: &str) -> Result<Hierarchical, String> {
    match s {
        "stacked" => Ok(Hierarchical::Stacked),
        "cutout" => Ok(Hierarchical::Cutout),
        other => Err(format!("Unknown hierarchical: {other}")),
    }
}

fn parse_path_mode(s: &str) -> Result<PathSimplifyMode, String> {
    match s {
        "spline" => Ok(PathSimplifyMode::Spline),
        "polygon" => Ok(PathSimplifyMode::Polygon),
        "none" => Ok(PathSimplifyMode::None),
        other => Err(format!("Unknown path mode: {other}")),
    }
}

fn build_config(opts: &VectorOptions) -> Result<Config, String> {
    Ok(Config {
        color_mode: parse_color_mode(&opts.color_mode)?,
        hierarchical: parse_hierarchical(&opts.hierarchical)?,
        filter_speckle: opts.filter_speckle,
        color_precision: opts.color_precision,
        layer_difference: opts.layer_difference,
        mode: parse_path_mode(&opts.mode)?,
        corner_threshold: opts.corner_threshold,
        length_threshold: opts.length_threshold,
        max_iterations: opts.max_iterations,
        splice_threshold: opts.splice_threshold,
        path_precision: opts.path_precision,
    })
}

// ---------- Image loading ----------

fn load_color_image(path: &str) -> Result<(ColorImage, usize, usize), String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open image {path}: {e}"))?;
    let rgba = img.to_rgba8();
    let width = rgba.width() as usize;
    let height = rgba.height() as usize;
    let pixels = rgba.into_raw();
    Ok((ColorImage { pixels, width, height }, width, height))
}

// ---------- Preview rasterization ----------

/// Rasterize the SVG string to a PNG for preview.
///
/// We don't bundle a full SVG renderer in Rust, so instead we
/// re-render the *original* image at a preview-friendly size.
/// The SVG is the actual output — this preview just gives the
/// user a visual reference of what the source looks like while
/// they adjust settings. The frontend also renders the SVG
/// inline for the true vectorized preview.
fn render_preview_png(path: &str, max_dim: u32) -> Result<Vec<u8>, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open image for preview: {e}"))?;
    let w = img.width();
    let h = img.height();
    let scale = if w > max_dim || h > max_dim {
        max_dim as f32 / w.max(h) as f32
    } else {
        1.0
    };
    let pw = (w as f32 * scale).round().max(1.0) as u32;
    let ph = (h as f32 * scale).round().max(1.0) as u32;
    let resized = img.resize_exact(pw, ph, image::imageops::FilterType::Lanczos3);
    let mut buf: Vec<u8> = Vec::new();
    DynamicImage::ImageRgba8(resized.to_rgba8())
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview PNG: {e}"))?;
    Ok(buf)
}

/// Create a 1x1 transparent PNG placeholder.
fn empty_png_base64() -> String {
    let img: RgbaImage = ImageBuffer::from_pixel(1, 1, Rgba([0, 0, 0, 0]));
    let mut buf: Vec<u8> = Vec::new();
    DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .ok();
    general_purpose::STANDARD.encode(&buf)
}

// ---------- Core conversion ----------

fn convert_one(path: &str, options: &VectorOptions) -> VectorResult {
    let (img, width, height) = match load_color_image(path) {
        Ok(v) => v,
        Err(e) => {
            return VectorResult {
                preview_png_base64: empty_png_base64(),
                svg: String::new(),
                width: 0,
                height: 0,
                svg_bytes: 0,
                ok: false,
                message: Some(e),
            };
        }
    };

    let config = match build_config(options) {
        Ok(c) => c,
        Err(e) => {
            return VectorResult {
                preview_png_base64: empty_png_base64(),
                svg: String::new(),
                width,
                height,
                svg_bytes: 0,
                ok: false,
                message: Some(e),
            };
        }
    };

    let svg_file: SvgFile = match vtracer::convert(img, config) {
        Ok(s) => s,
        Err(e) => {
            return VectorResult {
                preview_png_base64: empty_png_base64(),
                svg: String::new(),
                width,
                height,
                svg_bytes: 0,
                ok: false,
                message: Some(format!("Vectorization failed: {e}")),
            };
        }
    };

    let svg_string = svg_file.to_string();
    let svg_bytes = svg_string.len();

    let preview = match render_preview_png(path, 512) {
        Ok(png) => general_purpose::STANDARD.encode(&png),
        Err(_) => empty_png_base64(),
    };

    VectorResult {
        preview_png_base64: preview,
        svg: svg_string,
        width,
        height,
        svg_bytes,
        ok: true,
        message: None,
    }
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string()
}

// ---------- Commands ----------

#[tauri::command]
pub fn vectorize_file(path: String, options: VectorOptions) -> Result<VectorResult, String> {
    Ok(convert_one(&path, &options))
}

#[tauri::command]
pub fn vectorize_batch(
    paths: Vec<String>,
    options: VectorOptions,
) -> Result<Vec<BatchVectorResult>, String> {
    let results: Vec<BatchVectorResult> = paths
        .iter()
        .map(|p| {
            let r = convert_one(p, &options);
            BatchVectorResult {
                name: base_name(p),
                preview_png_base64: r.preview_png_base64,
                svg: r.svg,
                svg_bytes: r.svg_bytes,
                ok: r.ok,
                message: r.message,
            }
        })
        .collect();
    Ok(results)
}
