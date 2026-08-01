// ============================================================
// commands/jpeg.rs — lossless JPEG segment editor.
//
// JPEG layout: SOI (FF D8), a sequence of marker segments, then
// SOS + entropy-coded image data, then EOI (FF D9). Each marker
// segment is `FF xx` followed by a 2-byte big-endian length that
// includes the length bytes themselves but not the marker.
//
// Metadata lives in:
//   APP0  (FFE0) — JFIF (kept; not metadata)
//   APP1  (FFE1) — EXIF ("Exif\0\0" + TIFF) or XMP ("http://ns.adobe.com/xap/1.0/\0")
//   APP2  (FFE2) — ICC profile, FlashPix
//   APP13 (FFED) — IPTC / Photoshop
//   APP3..APP15 — vendor blobs (often XMP, MPF, etc.)
//   COM   (FFFE) — comments
//
// We walk the segments and rebuild the file, dropping or rewriting
// the metadata segments. Image data (DQT/DHT/SOF/DRI/SOS/EOI) is
// copied verbatim, so the result is byte-identical pixel content
// with no re-encode artefacts.
// ============================================================

const SOI: [u8; 2] = [0xFF, 0xD8];
const EOI: [u8; 2] = [0xFF, 0xD9];
const SOS: u8 = 0xDA;

/// Read a 2-byte big-endian u16 from a slice.
fn u16be(b: &[u8]) -> u16 {
    ((b[0] as u16) << 8) | (b[1] as u16)
}

/// A parsed JPEG marker segment.
struct Segment {
    marker: u8,       // the second byte of the marker (e.g. 0xE1 for APP1)
    payload: Vec<u8>, // includes the 2-byte length prefix
}

/// Walk every marker segment up to SOS. Returns the segments and the
/// remaining bytes (SOS payload + entropy data + EOI).
fn walk_segments(input: &[u8]) -> Result<(Vec<Segment>, Vec<u8>), String> {
    if input.len() < 4 || input[0] != SOI[0] || input[1] != SOI[1] {
        return Err("Not a JPEG (missing SOI)".to_string());
    }
    let mut i = 2usize;
    let mut segs: Vec<Segment> = Vec::new();

    while i + 1 < input.len() {
        if input[i] != 0xFF {
            return Err(format!("Expected marker prefix 0xFF at offset {i}, found 0x{:02X}", input[i]));
        }
        // Skip fill bytes (0xFF padding before a marker).
        if input[i + 1] == 0xFF {
            i += 1;
            continue;
        }
        let marker = input[i + 1];
        // Standalone markers (no length payload): SOI, EOI, RSTn.
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        // SOS: entropy-coded data follows until the next marker.
        if marker == SOS {
            // Copy the SOS segment payload (the 2-byte length + header) then
            // everything else verbatim (entropy data + EOI + any trailing).
            let rest = input[i..].to_vec();
            return Ok((segs, rest));
        }
        // All other markers carry a 2-byte length.
        if i + 4 > input.len() {
            return Err("Truncated marker segment".to_string());
        }
        let len = u16be(&input[i + 2..i + 4]) as usize;
        if len < 2 || i + 2 + len > input.len() {
            return Err(format!("Bad segment length {} at offset {}", len, i));
        }
        let payload = input[i + 2..i + 2 + len].to_vec();
        segs.push(Segment { marker, payload });
        i += 2 + len;
    }
    Err("Hit end of file before SOS".to_string())
}

/// Reassemble a JPEG from segments + the SOS tail.
fn assemble(segs: &[Segment], tail: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + segs.iter().map(|s| s.payload.len() + 2).sum::<usize>() + tail.len());
    out.extend_from_slice(&SOI);
    for s in segs {
        out.push(0xFF);
        out.push(s.marker);
        out.extend_from_slice(&s.payload);
    }
    out.extend_from_slice(tail);
    out
}

/// True if an APP1 payload begins with the EXIF magic.
fn is_exif_app1(payload: &[u8]) -> bool {
    payload.len() >= 8 && &payload[2..8] == b"Exif\0\0"
}

/// True if an APP1 payload begins with the XMP magic.
fn is_xmp_app1(payload: &[u8]) -> bool {
    const XMP_MAGIC: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    payload.len() >= 2 + XMP_MAGIC.len() && &payload[2..2 + XMP_MAGIC.len()] == XMP_MAGIC
}

/// Strip every metadata segment from a JPEG, losslessly.
/// Keeps APP0 (JFIF) and all image-data markers. Drops APP1 (EXIF/XMP),
/// APP2 (ICC), APP13 (IPTC), APP3..APP15, and COM.
pub fn strip_all(input: &[u8]) -> Result<Vec<u8>, String> {
    let (segs, tail) = walk_segments(input)?;
    let kept: Vec<Segment> = segs
        .into_iter()
        .filter(|s| {
            // Keep APP0 (JFIF) — it's container info, not personal metadata.
            // Drop every other APPn and COM.
            s.marker != 0xFE // COM
                && (s.marker < 0xE0 || s.marker > 0xEF || s.marker == 0xE0)
        })
        .collect();
    Ok(assemble(&kept, &tail))
}

/// Strip only GPS data from a JPEG, losslessly. Removes the GPS IFD
/// from the EXIF TIFF block (tag 0x8825 in IFD0). Leaves every other
/// EXIF/IPTC/XMP segment intact. If there's no EXIF segment or no GPS
/// IFD, the file is returned unchanged.
pub fn strip_gps_only(input: &[u8]) -> Result<Vec<u8>, String> {
    let (segs, tail) = walk_segments(input)?;
    let mut changed = false;
    let new_segs: Vec<Segment> = segs
        .into_iter()
        .map(|s| {
            if s.marker == 0xE1 && is_exif_app1(&s.payload) {
                if let Some(rewritten) = remove_gps_from_exif(&s.payload) {
                    changed = true;
                    return Segment { marker: s.marker, payload: rewritten };
                }
            }
            s
        })
        .collect();
    if !changed {
        // No GPS to remove — return the original bytes verbatim.
        return Ok(input.to_vec());
    }
    Ok(assemble(&new_segs, &tail))
}

/// Strip all metadata but re-insert a minimal EXIF APP1 containing
/// only the Copyright tag (IFD0 tag 0x8298). `copyright` must already
/// be a clean string. If empty, behaves like `strip_all`.
pub fn strip_all_keep_copyright(input: &[u8], copyright: &str) -> Result<Vec<u8>, String> {
    let stripped = strip_all(input)?;
    if copyright.is_empty() {
        return Ok(stripped);
    }
    let app1 = build_minimal_exif_with_copyright(copyright);
    insert_app1_after_jfif(&mut stripped.to_vec(), app1)
}

// ============================================================
// Minimal TIFF/EXIF writer for the copyright-only APP1.
// Builds: "Exif\0\0" + TIFF (little-endian) with a single IFD0
// entry: Copyright (0x8298, ASCII), pointing at the string payload.
// ============================================================

fn build_minimal_exif_with_copyright(copyright: &str) -> Vec<u8> {
    // ASCII value must be NUL-terminated.
    let mut ascii = copyright.as_bytes().to_vec();
    ascii.push(0);
    // Pad to an even length (TIFF fields are word-aligned).
    if ascii.len() % 2 != 0 {
        ascii.push(0);
    }

    // Layout (little-endian):
    //   0  "II"
    //   2  0x002A
    //   4  offset to IFD0 (= 8)
    //   8  IFD0: count(2)=1, entry(12), next IFD offset(4)=0
    //  26  copyright string
    let ifd_offset: u32 = 8;
    let entry_offset: u32 = ifd_offset + 2; // after count
    let data_offset: u32 = entry_offset + 12 + 4; // after entry + next-ifd

    let mut tiff: Vec<u8> = Vec::with_capacity(data_offset as usize + ascii.len());
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&0x002A_u16.to_le_bytes());
    tiff.extend_from_slice(&ifd_offset.to_le_bytes());
    // IFD0 count = 1
    tiff.extend_from_slice(&1_u16.to_le_bytes());
    // Entry: tag 0x8298, type 2 (ASCII), count = ascii.len(), value offset = data_offset
    tiff.extend_from_slice(&0x8298_u16.to_le_bytes());
    tiff.extend_from_slice(&2_u16.to_le_bytes()); // ASCII
    tiff.extend_from_slice(&(ascii.len() as u32).to_le_bytes());
    tiff.extend_from_slice(&data_offset.to_le_bytes());
    // Next IFD offset = 0
    tiff.extend_from_slice(&0_u32.to_le_bytes());
    // The copyright string payload.
    tiff.extend_from_slice(&ascii);

    // APP1 payload = 2-byte length + "Exif\0\0" + TIFF.
    let total_len = 2 + 6 + tiff.len();
    let mut payload = Vec::with_capacity(total_len);
    payload.extend_from_slice(&(total_len as u16).to_be_bytes());
    payload.extend_from_slice(b"Exif\0\0");
    payload.extend_from_slice(&tiff);
    payload
}

/// Insert an APP1 segment right after the SOI (and after APP0/JFIF if present).
fn insert_app1_after_jfif(bytes: &mut Vec<u8>, app1_payload: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() < 4 || bytes[0] != SOI[0] || bytes[1] != SOI[1] {
        return Err("Not a JPEG (missing SOI)".to_string());
    }
    let mut i = 2usize;
    // Skip APP0 (JFIF) and any standalone markers at the very front.
    while i + 4 <= bytes.len() && bytes[i] == 0xFF {
        let marker = bytes[i + 1];
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xE0 {
            // APP0 — skip past it.
            let len = u16be(&bytes[i + 2..i + 4]) as usize;
            i += 2 + len;
            continue;
        }
        break;
    }
    let mut out = Vec::with_capacity(bytes.len() + app1_payload.len() + 2);
    out.extend_from_slice(&bytes[..i]);
    out.push(0xFF);
    out.push(0xE1);
    out.extend_from_slice(&app1_payload);
    out.extend_from_slice(&bytes[i..]);
    Ok(out)
}

// ============================================================
// TIFF IFD parser for GPS removal.
// Zeroes the GPS IFD pointer entry (tag 0x8825) in IFD0 and
// overwrites the GPS IFD data with zeros. The entry count and
// all other offsets are left untouched, so the TIFF stays valid
// for every other reader. Returns Some(new_app1_payload) if GPS
// was found and removed, else None.
// ============================================================

fn remove_gps_from_exif(app1_payload: &[u8]) -> Option<Vec<u8>> {
    // payload = [len:2][Exif\0\0][TIFF...]
    if !is_exif_app1(app1_payload) {
        return None;
    }
    let tiff_start = 8; // 2 (len) + 6 (Exif\0\0)
    let tiff = &app1_payload[tiff_start..];

    let little_endian = match tiff.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return None,
    };
    let read_u16 = |b: &[u8]| -> u16 {
        if little_endian { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
    };
    let read_u32 = |b: &[u8]| -> u32 {
        if little_endian { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }
    };
    let write_u16 = |b: &mut [u8], v: u16| {
        if little_endian { b.copy_from_slice(&v.to_le_bytes()); } else { b.copy_from_slice(&v.to_be_bytes()); }
    };
    let write_u32 = |b: &mut [u8], v: u32| {
        if little_endian { b.copy_from_slice(&v.to_le_bytes()); } else { b.copy_from_slice(&v.to_be_bytes()); }
    };

    if tiff.len() < 8 {
        return None;
    }
    let magic = read_u16(&tiff[2..4]);
    if magic != 0x002A {
        return None;
    }
    let ifd0_offset = read_u32(&tiff[4..8]) as usize;
    if ifd0_offset + 2 > tiff.len() {
        return None;
    }
    let entry_count = read_u16(&tiff[ifd0_offset..ifd0_offset + 2]) as usize;
    let entries_start = ifd0_offset + 2;
    let entries_end = entries_start + entry_count * 12;
    if entries_end + 4 > tiff.len() {
        return None;
    }

    // Find the GPS IFD pointer entry (tag 0x8825) within IFD0.
    let gps_tag: u16 = 0x8825;
    let mut gps_entry_off: Option<usize> = None;
    let mut gps_ifd_offset: Option<u32> = None;
    for i in 0..entry_count {
        let off = entries_start + i * 12;
        let tag = read_u16(&tiff[off..off + 2]);
        if tag == gps_tag {
            gps_entry_off = Some(off);
            // The value is a u32 offset (type LONG = 4, count 1).
            gps_ifd_offset = Some(read_u32(&tiff[off + 8..off + 12]));
            break;
        }
    }

    let entry_off = gps_entry_off?;
    let gps_offset = gps_ifd_offset? as usize;

    // Copy the whole APP1 payload so we can mutate in place.
    let mut new_payload = app1_payload.to_vec();
    let new_tiff = &mut new_payload[tiff_start..];

    // Determine the GPS IFD length so we can zero it.
    let gps_len = if gps_offset + 2 > new_tiff.len() {
        0
    } else {
        let n = read_u16(&new_tiff[gps_offset..gps_offset + 2]) as usize;
        // 2 (count) + n*12 (entries) + 4 (next IFD)
        2 + n * 12 + 4
    };

    // Zero the GPS IFD data region (count + entries + next-ifd).
    let gps_end = (gps_offset + gps_len).min(new_tiff.len());
    for b in &mut new_tiff[gps_offset..gps_end] {
        *b = 0;
    }

    // Neutralise the GPS pointer entry in IFD0: set tag to 0x0000 (unknown,
    // skipped by readers) and zero its value/offset field. We keep the
    // entry count and every other offset identical, so the TIFF remains
    // structurally valid.
    write_u16(&mut new_tiff[entry_off..entry_off + 2], 0x0000);
    // type + count fields left as-is (harmless); zero the value/offset u32.
    write_u32(&mut new_tiff[entry_off + 8..entry_off + 12], 0);

    Some(new_payload)
}

/// Extract the Copyright field (IFD0 tag 0x8298, ASCII) from a JPEG's
/// EXIF segment, if present. Returns the trimmed string.
pub fn read_copyright(input: &[u8]) -> Option<String> {
    let (segs, _tail) = walk_segments(input).ok()?;
    for s in segs {
        if s.marker == 0xE1 && is_exif_app1(&s.payload) {
            if let Some(c) = read_copyright_from_exif(&s.payload) {
                return Some(c);
            }
        }
    }
    None
}

fn read_copyright_from_exif(app1_payload: &[u8]) -> Option<String> {
    let tiff_start = 8;
    let tiff = &app1_payload[tiff_start..];
    let little_endian = match tiff.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return None,
    };
    let read_u16 = |b: &[u8]| -> u16 {
        if little_endian { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
    };
    let read_u32 = |b: &[u8]| -> u32 {
        if little_endian { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }
    };
    if tiff.len() < 8 { return None; }
    let ifd0_offset = read_u32(&tiff[4..8]) as usize;
    if ifd0_offset + 2 > tiff.len() { return None; }
    let n = read_u16(&tiff[ifd0_offset..ifd0_offset + 2]) as usize;
    let entries_start = ifd0_offset + 2;
    let entries_end = entries_start + n * 12;
    if entries_end > tiff.len() { return None; }
    let copyright_tag: u16 = 0x8298;
    for i in 0..n {
        let off = entries_start + i * 12;
        let tag = read_u16(&tiff[off..off + 2]);
        if tag != copyright_tag { continue; }
        let _type = read_u16(&tiff[off + 2..off + 4]);
        let count = read_u32(&tiff[off + 4..off + 8]) as usize;
        // ASCII (type 2). If count <= 4, the value is inline in the 4-byte field.
        let value_field = &tiff[off + 8..off + 12];
        let bytes: &[u8] = if count <= 4 {
            value_field
        } else {
            let val_offset = read_u32(value_field) as usize;
            if val_offset + count > tiff.len() { return None; }
            &tiff[val_offset..val_offset + count]
        };
        let s = std::str::from_utf8(bytes).ok()?;
        return Some(s.trim_end_matches('\0').trim().to_string());
    }
    None
}

/// Quick check: does this JPEG have an EXIF APP1 segment?
pub fn has_exif(input: &[u8]) -> bool {
    if let Ok((segs, _)) = walk_segments(input) {
        segs.iter().any(|s| s.marker == 0xE1 && is_exif_app1(&s.payload))
    } else {
        false
    }
}

/// Quick check: does this JPEG have an XMP APP1 segment?
pub fn has_xmp(input: &[u8]) -> bool {
    if let Ok((segs, _)) = walk_segments(input) {
        segs.iter().any(|s| s.marker == 0xE1 && is_xmp_app1(&s.payload))
    } else {
        false
    }
}

#[allow(dead_code)]
fn _suppress_unused() {
    let _ = (SOS, EOI);
}
