// ============================================================
// commands/tiff.rs — TIFF metadata handling.
//
// TIFF is IFD-based and complex to edit losslessly. For v1 we
// fall back to the `image` crate re-encode for TIFF, which drops
// all metadata by decoding to pixels and re-encoding. This is
// lossy in the container sense (compression may differ) but
// pixel-faithful.
//
// GPS-only and copyright-preservation are not supported for TIFF
// in v1; the strip command surfaces a note when these are
// requested for a TIFF.
// ============================================================

use std::path::Path;
use image::DynamicImage;

pub fn strip_all(input_path: &str, output_path: &str) -> Result<(u64, u64), String> {
    let img = image::open(Path::new(input_path))
        .map_err(|e| format!("Could not decode TIFF: {}", e))?;
    // Preserve colour model: RGB8 for opaque, RGBA8 for alpha.
    let dynamic = if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8())
    };
    dynamic
        .save(Path::new(output_path))
        .map_err(|e| format!("Could not write TIFF: {}", e))?;
    let in_size = std::fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);
    let out_size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    Ok((in_size, out_size))
}

pub fn strip_gps_only(input_path: &str, output_path: &str) -> Result<(u64, u64), String> {
    // Same as strip_all for v1 — selective GPS removal from a TIFF IFD
    // is fragile without a dedicated TIFF writer.
    strip_all(input_path, output_path)
}

pub fn strip_all_keep_copyright(input_path: &str, output_path: &str) -> Result<(u64, u64), String> {
    // v1: no copyright re-insertion for TIFF.
    strip_all(input_path, output_path)
}
