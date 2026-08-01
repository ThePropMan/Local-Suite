// ============================================================
// commands/convert.rs — batch image conversion and compression.
//
// Supported input/output: JPEG, PNG, WebP, TIFF, BMP, GIF.
// Resize: percent, exact dimensions, or preset (max dimension).
// Quality: 1-100 for JPEG. WebP is lossless in v1.
// Strip metadata: re-encode drops metadata; same-format copy
//   preserves metadata if strip_metadata is false.
// ============================================================

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::codecs::bmp::BmpEncoder;
use image::codecs::gif::GifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::tiff::TiffEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder, ImageError, ImageFormat, ImageReader};
use image_webp::WebPEncoder;
use serde::{Deserialize, Serialize};

// ---------- Types sent from / to the frontend ----------

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Bmp,
    Gif,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ResizeModeTag {
    None,
    Percent,
    Exact,
    Preset,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ResizePresetId {
    Web,
    Social,
    Thumbnail,
    Icon,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConvertOptions {
    pub format: OutputFormat,
    pub quality: u8, // 1-100, used for JPEG
    pub resize: ResizeModeTag,
    pub resize_percent: Option<f32>,
    pub resize_width: Option<u32>,
    pub resize_height: Option<u32>,
    pub resize_preset: Option<ResizePresetId>,
    pub strip_metadata: bool,
}

#[derive(Debug, Serialize)]
pub struct ConvertResult {
    pub input_size: u64,
    pub output_size: u64,
    pub ok: bool,
    pub message: Option<String>,
    pub output_path: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct BatchResultItem {
    pub name: String,
    pub input_size: u64,
    pub output_size: u64,
    pub ok: bool,
    pub message: Option<String>,
    pub output_path: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

// ---------- Public commands ----------

#[tauri::command]
pub fn convert_image(input_path: String, output_path: String, options: ConvertOptions) -> Result<ConvertResult, String> {
    convert_one(&input_path, &output_path, &options)
}

#[tauri::command]
pub fn convert_batch(
    input_paths: Vec<String>,
    output_dir: String,
    options: ConvertOptions,
) -> Result<Vec<BatchResultItem>, String> {
    let out_dir = PathBuf::from(&output_dir);
    let mut results = Vec::with_capacity(input_paths.len());

    for path in input_paths {
        let out_path = build_unique_output_path(&path, &out_dir, &options);
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        match convert_one(&path, &out_path.to_string_lossy(), &options) {
            Ok(r) => results.push(BatchResultItem {
                name,
                input_size: r.input_size,
                output_size: r.output_size,
                ok: r.ok,
                message: r.message,
                output_path: r.output_path,
                format: r.format,
                width: r.width,
                height: r.height,
            }),
            Err(e) => results.push(BatchResultItem {
                name,
                input_size: 0,
                output_size: 0,
                ok: false,
                message: Some(e),
                output_path: out_path.to_string_lossy().to_string(),
                format: "unknown".to_string(),
                width: 0,
                height: 0,
            }),
        }
    }

    Ok(results)
}

// ---------- Core conversion ----------

fn convert_one(input_path: &str, output_path: &str, options: &ConvertOptions) -> Result<ConvertResult, String> {
    let input_size = fs::metadata(input_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let input_format = detect_format(input_path)?;
    let target_format = options.format;

    // Same format + no resize + strip_metadata=false = copy to preserve metadata.
    let should_copy = input_format == Some(target_format)
        && matches!(options.resize, ResizeModeTag::None)
        && !options.strip_metadata;

    if should_copy {
        copy_file(input_path, output_path)?;
        let (w, h) = image_dimensions(input_path).unwrap_or((0, 0));
        return Ok(ConvertResult {
            input_size,
            output_size: input_size,
            ok: true,
            message: Some("Copied without changes".to_string()),
            output_path: output_path.to_string(),
            format: format_label(target_format).to_string(),
            width: w,
            height: h,
        });
    }

    // Decode the image.
    let mut img = image::open(input_path)
        .map_err(|e| format!("Could not decode {input_path}: {e}"))?;
    let (orig_w, orig_h) = img.dimensions();

    // Resize.
    if !matches!(options.resize, ResizeModeTag::None) {
        let (nw, nh) = compute_resize(orig_w, orig_h, options)?;
        if nw != orig_w || nh != orig_h {
            img = img.resize(nw, nh, FilterType::Lanczos3);
        }
    }

    let (w, h) = img.dimensions();

    // Ensure directory exists.
    if let Some(parent) = Path::new(output_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create output directory: {e}"))?;
        }
    }

    // Encode.
    let out_file = fs::File::create(output_path)
        .map_err(|e| format!("Could not create {output_path}: {e}"))?;
    let writer = BufWriter::new(out_file);

    let _ = match target_format {
        OutputFormat::Jpeg => encode_jpeg(&img, writer, options.quality),
        OutputFormat::Png => encode_with(&img, PngEncoder::new(writer)),
        OutputFormat::Webp => encode_webp(&img, writer),
        OutputFormat::Tiff => encode_with(&img, TiffEncoder::new(writer)),
        OutputFormat::Bmp => encode_bmp(&img, writer),
        OutputFormat::Gif => encode_with(&img, GifEncoder::new(writer)),
    }?;

    let output_size = fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(ConvertResult {
        input_size,
        output_size,
        ok: true,
        message: None,
        output_path: output_path.to_string(),
        format: format_label(target_format).to_string(),
        width: w,
        height: h,
    })
}

// ---------- Resize logic ----------

fn compute_resize(orig_w: u32, orig_h: u32, options: &ConvertOptions) -> Result<(u32, u32), String> {
    let (nw, nh) = match options.resize {
        ResizeModeTag::Percent => {
            let pct = options.resize_percent.unwrap_or(100.0).clamp(1.0, 100.0);
            (
                ((orig_w as f32) * (pct / 100.0)).round().max(1.0) as u32,
                ((orig_h as f32) * (pct / 100.0)).round().max(1.0) as u32,
            )
        }
        ResizeModeTag::Exact => (
            options.resize_width.unwrap_or(orig_w).max(1),
            options.resize_height.unwrap_or(orig_h).max(1),
        ),
        ResizeModeTag::Preset => {
            let max_dim = match options.resize_preset {
                Some(ResizePresetId::Web) => 1920,
                Some(ResizePresetId::Social) => 1080,
                Some(ResizePresetId::Thumbnail) => 256,
                Some(ResizePresetId::Icon) => 512,
                None => 1920,
            };
            fit_inside(orig_w, orig_h, max_dim)
        }
        ResizeModeTag::None => (orig_w, orig_h),
    };
    Ok((nw, nh))
}

fn fit_inside(w: u32, h: u32, max: u32) -> (u32, u32) {
    fit_inside_box(w, h, max, max)
}

/// Fit an image within a width x height box while preserving aspect ratio.
/// The returned dimensions will never exceed (max_w, max_h) and will only
/// shrink the image (never upscale).
fn fit_inside_box(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    let ratio = (max_w as f32 / w as f32).min(max_h as f32 / h as f32).min(1.0);
    (
        ((w as f32) * ratio).round().max(1.0) as u32,
        ((h as f32) * ratio).round().max(1.0) as u32,
    )
}

// ---------- Encoders ----------

fn encode_jpeg<W: Write>(img: &DynamicImage, writer: W, quality: u8) -> Result<(), String> {
    let q = quality.clamp(1, 100);
    let encoder = JpegEncoder::new_with_quality(writer, q);
    encode_with(img, encoder)
}

fn encode_with<E: ImageEncoder>(img: &DynamicImage, encoder: E) -> Result<(), String> {
    match img.color() {
        image::ColorType::Rgb8 => {
            let rgb = img.to_rgb8();
            let (w, h) = rgb.dimensions();
            encoder
                .write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
                .map_err(|e| e.to_string())
        }
        _ => {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            encoder
                .write_image(rgba.as_raw(), w, h, ExtendedColorType::Rgba8)
                .map_err(|e| e.to_string())
        }
    }
}

fn encode_bmp<W: Write>(img: &DynamicImage, mut writer: W) -> Result<(), String> {
    let encoder = BmpEncoder::new(&mut writer);
    encode_with(img, encoder)
}

fn encode_webp<W: Write>(img: &DynamicImage, writer: W) -> Result<(), String> {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let encoder = WebPEncoder::new(writer);
    encoder
        .encode(rgba.as_raw(), w, h, image_webp::ColorType::Rgba8)
        .map_err(|e| e.to_string())
}

// ---------- Path helpers ----------

fn build_unique_output_path(input_path: &str, output_dir: &Path, options: &ConvertOptions) -> PathBuf {
    let ext = extension_for_format(options.format);
    let stem = Path::new(input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");

    let base_name = format!("{}.{}", stem, ext);
    let mut candidate = output_dir.join(&base_name);
    let mut counter = 1;
    while candidate.exists() {
        candidate = output_dir.join(format!("{} ({}).{}", stem, counter, ext));
        counter += 1;
    }
    candidate
}

fn extension_for_format(fmt: OutputFormat) -> &'static str {
    match fmt {
        OutputFormat::Jpeg => "jpg",
        OutputFormat::Png => "png",
        OutputFormat::Webp => "webp",
        OutputFormat::Tiff => "tiff",
        OutputFormat::Bmp => "bmp",
        OutputFormat::Gif => "gif",
    }
}

fn format_label(fmt: OutputFormat) -> &'static str {
    match fmt {
        OutputFormat::Jpeg => "jpeg",
        OutputFormat::Png => "png",
        OutputFormat::Webp => "webp",
        OutputFormat::Tiff => "tiff",
        OutputFormat::Bmp => "bmp",
        OutputFormat::Gif => "gif",
    }
}

// ---------- Format detection ----------

fn detect_format(path: &str) -> Result<Option<OutputFormat>, String> {
    let fmt = ImageFormat::from_path(path)
        .map_err(|e| format!("Could not determine format of {path}: {e}"))?;
    Ok(map_image_format(fmt))
}

fn map_image_format(fmt: ImageFormat) -> Option<OutputFormat> {
    match fmt {
        ImageFormat::Jpeg => Some(OutputFormat::Jpeg),
        ImageFormat::Png => Some(OutputFormat::Png),
        ImageFormat::WebP => Some(OutputFormat::Webp),
        ImageFormat::Tiff => Some(OutputFormat::Tiff),
        ImageFormat::Bmp => Some(OutputFormat::Bmp),
        ImageFormat::Gif => Some(OutputFormat::Gif),
        _ => None,
    }
}

fn image_dimensions(path: &str) -> Result<(u32, u32), ImageError> {
    let reader = ImageReader::open(path)?;
    let (w, h) = reader.into_dimensions()?;
    Ok((w, h))
}

fn copy_file(input_path: &str, output_path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(output_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create output directory: {e}"))?;
        }
    }
    fs::copy(input_path, output_path)
        .map_err(|e| format!("Could not copy {input_path} to {output_path}: {e}"))?;
    Ok(())
}
