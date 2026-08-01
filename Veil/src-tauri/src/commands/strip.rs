// ============================================================
// commands/strip.rs — strip metadata from an image.
//
// Dispatches by format:
//   JPEG → lossless segment editor (commands::jpeg)
//   PNG  → lossless chunk editor  (commands::png)
//   WebP → lossless RIFF editor   (commands::webp)
//   TIFF → image-crate re-encode  (commands::tiff)
//
// Modes:
//   "all"             — drop every metadata segment/chunk
//   "gps_only"        — drop only GPS-bearing data
//   preserve_copyright — read the Copyright field before strip and
//                       re-insert it after (JPEG/PNG only in v1)
// ============================================================

use std::path::Path;
use serde::{Deserialize, Serialize};

use super::jpeg;
use super::png;
use super::webp;
use super::tiff;

#[derive(Deserialize)]
pub struct StripOptions {
    /// "all" | "gps_only"
    pub mode: String,
    pub preserve_copyright: bool,
}

#[derive(Serialize)]
pub struct StripResult {
    pub input_size: u64,
    pub output_size: u64,
    pub ok: bool,
    pub message: Option<String>,
    /// Format of the input file: "jpeg" | "png" | "webp" | "tiff" | "unknown".
    pub format: String,
    /// Whether the input had EXIF metadata.
    pub had_exif: bool,
    /// Whether the input had XMP metadata.
    pub had_xmp: bool,
    /// The copyright string that was preserved, if any.
    pub preserved_copyright: Option<String>,
}

/// Detect the image format from the first bytes of the file.
fn detect_format(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        return "jpeg";
    }
    if bytes.len() >= 8 && bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return "png";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    if bytes.len() >= 4 {
        let be = bytes[0] == b'M' && bytes[1] == b'M';
        let le = bytes[0] == b'I' && bytes[1] == b'I';
        if (be || le) && ((bytes[2] == 0x2A && bytes[3] == 0x00) || (bytes[2] == 0x00 && bytes[3] == 0x2A)) {
            return "tiff";
        }
    }
    "unknown"
}

#[tauri::command]
pub fn strip_metadata(
    input_path: String,
    output_path: String,
    options: StripOptions,
) -> Result<StripResult, String> {
    let input_bytes = std::fs::read(&input_path)
        .map_err(|e| format!("Could not read input file: {}", e))?;
    let input_size = input_bytes.len() as u64;
    let format = detect_format(&input_bytes);

    let mut had_exif = false;
    let mut had_xmp = false;
    let mut preserved_copyright: Option<String> = None;
    let mut message: Option<String> = None;

    // Read copyright before stripping, if requested and supported.
    let copyright: Option<String> = if options.preserve_copyright {
        match format {
            "jpeg" => jpeg::read_copyright(&input_bytes),
            "png" => png::read_copyright(&input_bytes),
            "webp" => webp::read_copyright(&input_bytes),
            _ => None,
        }
    } else {
        None
    };

    // Detect metadata presence for reporting.
    match format {
        "jpeg" => {
            had_exif = jpeg::has_exif(&input_bytes);
            had_xmp = jpeg::has_xmp(&input_bytes);
        }
        "png" => {
            had_exif = png::has_exif(&input_bytes);
            had_xmp = png::has_xmp(&input_bytes);
        }
        "webp" => {
            had_exif = webp::has_exif(&input_bytes);
            had_xmp = webp::has_xmp(&input_bytes);
        }
        _ => {}
    }

    let output_bytes: Vec<u8> = match format {
        "jpeg" => {
            let c = copyright.as_deref().unwrap_or("");
            match options.mode.as_str() {
                "gps_only" => jpeg::strip_gps_only(&input_bytes)?,
                _ => {
                    if options.preserve_copyright && !c.is_empty() {
                        preserved_copyright = Some(c.to_string());
                        jpeg::strip_all_keep_copyright(&input_bytes, c)?
                    } else {
                        jpeg::strip_all(&input_bytes)?
                    }
                }
            }
        }
        "png" => {
            let c = copyright.as_deref().unwrap_or("");
            match options.mode.as_str() {
                "gps_only" => png::strip_gps_only(&input_bytes)?,
                _ => {
                    if options.preserve_copyright && !c.is_empty() {
                        preserved_copyright = Some(c.to_string());
                        png::strip_all_keep_copyright(&input_bytes, c)?
                    } else {
                        png::strip_all(&input_bytes)?
                    }
                }
            }
        }
        "webp" => {
            let c = copyright.as_deref().unwrap_or("");
            match options.mode.as_str() {
                "gps_only" => webp::strip_gps_only(&input_bytes)?,
                _ => {
                    if options.preserve_copyright && !c.is_empty() {
                        // WebP v1 doesn't re-insert copyright; note it.
                        message = Some("WebP copyright preservation is not yet supported; all metadata was removed.".to_string());
                    }
                    webp::strip_all_keep_copyright(&input_bytes, c)?
                }
            }
        }
        "tiff" => {
            // TIFF uses the image-crate re-encode path (file-based).
            let (in_size, out_size) = match options.mode.as_str() {
                "gps_only" => tiff::strip_gps_only(&input_path, &output_path)?,
                _ => {
                    if options.preserve_copyright {
                        message = Some("TIFF copyright preservation is not yet supported; all metadata was removed.".to_string());
                    }
                    tiff::strip_all_keep_copyright(&input_path, &output_path)?
                }
            };
            return Ok(StripResult {
                input_size: in_size,
                output_size: out_size,
                ok: true,
                message,
                format: format.to_string(),
                had_exif,
                had_xmp,
                preserved_copyright,
            });
        }
        _ => {
            return Err(format!("Unsupported file format: {}", format));
        }
    };

    // Write the output bytes (JPEG/PNG/WebP paths).
    if let Some(parent) = Path::new(&output_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create output directory: {}", e))?;
        }
    }
    std::fs::write(&output_path, &output_bytes)
        .map_err(|e| format!("Could not write output file: {}", e))?;
    let output_size = output_bytes.len() as u64;

    Ok(StripResult {
        input_size,
        output_size,
        ok: true,
        message,
        format: format.to_string(),
        had_exif,
        had_xmp,
        preserved_copyright,
    })
}
