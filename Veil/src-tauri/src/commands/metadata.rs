// ============================================================
// commands/metadata.rs — read EXIF/metadata from an image file.
// Uses kamadak-exif to parse the EXIF segment and maps each tag
// to a category (gps / camera / exif). Returns a flat field list
// plus a has_gps flag and the file size.
// ============================================================

use std::fs::File;
use std::io::BufReader;
use serde::Serialize;

use super::jpeg;
use super::png;
use super::webp;

#[derive(Serialize)]
pub struct MetadataField {
    pub key: String,
    pub value: String,
    pub category: String,
}

#[derive(Serialize)]
pub struct MetadataSummary {
    pub fields: Vec<MetadataField>,
    pub has_gps: bool,
    pub has_exif: bool,
    pub has_xmp: bool,
    pub has_iptc: bool,
    pub file_size: u64,
    pub format: String,
}

/// Categorise an EXIF tag into gps / camera / exif by inspecting
/// the tag's display name. This avoids depending on specific enum
/// variant names, which differ across kamadak-exif versions.
fn categorize(tag: &exif::Tag) -> &'static str {
    let name = tag.to_string().to_ascii_lowercase();
    if name.starts_with("gps") || name.contains("gps ") {
        return "gps";
    }
    // Camera / device identifying tags.
    const CAMERA_KEYS: &[&str] = &[
        "make", "model", "software", "lens", "body serial", "camera owner",
        "date time", "exposure", "fnumber", "focal length", "iso", "white balance",
        "flash", "metering", "scene capture", "contrast", "saturation", "sharpness",
        "digital zoom", "focal plane", "max aperture", "light source", "subject distance",
        "spectral sensitivity", "photographic sensitivity", "exposure program",
        "exposure mode", "exposure bias",
    ];
    for key in CAMERA_KEYS {
        if name.contains(key) {
            return "camera";
        }
    }
    "exif"
}

/// Format an exif::Value into a human-readable string.
fn format_value(value: &exif::Value) -> String {
    use exif::Value;
    match value {
        Value::Ascii(bytes) => bytes
            .iter()
            .map(|b| String::from_utf8_lossy(b).trim_end_matches('\0').trim().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        Value::Rational(r) => r
            .iter()
            .map(|v| {
                if v.denom == 1 {
                    format!("{}", v.num)
                } else {
                    format!("{:.4}", v.num as f64 / v.denom as f64)
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Short(v) => v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "),
        Value::Long(v) => v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "),
        Value::Byte(v) => v
            .iter()
            .map(|x| format!("{:02X}", x))
            .collect::<Vec<_>>()
            .join(" "),
        Value::SByte(v) => v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "),
        Value::Undefined(v, _count) => format!("<{} bytes>", v.len()),
        Value::SShort(v) => v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "),
        Value::SLong(v) => v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "),
        Value::SRational(r) => r
            .iter()
            .map(|v| {
                if v.denom == 1 {
                    format!("{}", v.num)
                } else {
                    format!("{:.4}", v.num as f64 / v.denom as f64)
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Float(v) => v.iter().map(|x| format!("{:.4}", x)).collect::<Vec<_>>().join(", "),
        Value::Double(v) => v.iter().map(|x| format!("{:.4}", x)).collect::<Vec<_>>().join(", "),
        Value::Unknown(tag, type_id, count) => format!("<unknown: tag={:?} type={} count={}>", tag, type_id, count),
    }
}

#[tauri::command]
pub fn read_metadata(path: String) -> Result<MetadataSummary, String> {
    let file_size = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Read the first bytes for format detection + XMP/IPTC presence.
    let bytes = std::fs::read(&path).unwrap_or_default();
    let format = detect_format(&bytes);
    let has_exif_segment = match format {
        "jpeg" => jpeg::has_exif(&bytes),
        "png" => png::has_exif(&bytes),
        "webp" => webp::has_exif(&bytes),
        _ => false,
    };
    let has_xmp = match format {
        "jpeg" => jpeg::has_xmp(&bytes),
        "png" => png::has_xmp(&bytes),
        "webp" => webp::has_xmp(&bytes),
        _ => false,
    };
    // IPTC lives in APP13 (FFED) for JPEG. We detect by scanning for the
    // Photoshop 8BIM marker inside APP13. For PNG/WebP we don't detect it.
    let has_iptc = format == "jpeg" && has_iptc_jpeg(&bytes);

    let file = File::open(&path).map_err(|e| format!("Could not open file: {}", e))?;
    let mut buf_reader = BufReader::new(&file);
    let exif_reader = exif::Reader::new();

    let mut fields: Vec<MetadataField> = Vec::new();
    let mut has_gps = false;

    match exif_reader.read_from_container(&mut buf_reader) {
        Ok(exif_data) => {
            for f in exif_data.fields() {
                let category = categorize(&f.tag);
                if category == "gps" {
                    has_gps = true;
                }
                let display_name = f.tag.to_string();
                let value = format_value(&f.value);
                fields.push(MetadataField {
                    key: display_name,
                    value,
                    category: category.to_string(),
                });
            }
        }
        Err(_) => {
            // No EXIF data — that's fine, return empty fields.
        }
    }

    Ok(MetadataSummary {
        fields,
        has_gps,
        has_exif: has_exif_segment,
        has_xmp,
        has_iptc,
        file_size,
        format: format.to_string(),
    })
}

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

/// Crude IPTC detection: look for the "8BIM" marker inside an APP13 segment.
fn has_iptc_jpeg(bytes: &[u8]) -> bool {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return false;
    }
    let mut i = 2usize;
    while i + 4 < bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xDA {
            break; // SOS — image data follows
        }
        if i + 4 > bytes.len() {
            break;
        }
        let len = ((bytes[i + 2] as usize) << 8) | (bytes[i + 3] as usize);
        if len < 2 || i + 2 + len > bytes.len() {
            break;
        }
        if marker == 0xED {
            // APP13 — look for "8BIM" or "Photoshop" inside.
            let seg = &bytes[i + 4..i + 2 + len];
            if seg.windows(4).any(|w| w == b"8BIM") || seg.windows(8).any(|w| w == b"Photoshop") {
                return true;
            }
        }
        i += 2 + len;
    }
    false
}
