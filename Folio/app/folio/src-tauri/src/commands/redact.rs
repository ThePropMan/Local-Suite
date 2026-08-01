use lopdf::{Document, Object, Stream};
use lopdf::content::{Content, Operation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedactRegion {
    pub page: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[tauri::command]
pub fn redact_pdf(input_path: String, output_path: String, regions: Vec<RedactRegion>) -> Result<(), String> {
    let mut doc = Document::load(&input_path)
        .map_err(|e| format!("Could not load PDF: {}", e))?;

    // Frontend sends 0-based page indices; lopdf uses 1-based page numbers.
    let regions_by_page: HashMap<u32, Vec<&RedactRegion>> = regions.iter()
        .fold(HashMap::new(), |mut acc, region| {
            acc.entry(region.page + 1).or_default().push(region);
            acc
        });

    let pages = doc.get_pages();
    for (page_num, page_id) in pages.iter() {
        if let Some(page_regions) = regions_by_page.get(page_num) {
            redact_page(&mut doc, *page_id, page_regions, *page_num)?;
        }
    }

    doc.save(&output_path)
        .map_err(|e| format!("Could not save redacted PDF: {}", e))?;

    Ok(())
}

fn redact_page(doc: &mut Document, page_id: (u32, u16), regions: &[&RedactRegion], page_number: u32) -> Result<(), String> {
    // First: strip text operators that fall within redaction regions from all
    // content streams on this page so the underlying text is truly gone (not
    // just visually hidden).
    strip_text_in_regions(doc, page_id, regions, page_number)?;

    // Second: append opaque black boxes over each region so the area is
    // visually blacked out even if some content wasn't perfectly matched
    // (e.g. images, vector graphics, odd text encodings).
    let mut ops: Vec<Operation> = Vec::new();
    for region in regions {
        ops.push(Operation::new("q", vec![]));
        ops.push(Operation::new(
            "rg",
            vec![Object::Integer(0), Object::Integer(0), Object::Integer(0)],
        ));
        ops.push(Operation::new(
            "re",
            vec![
                Object::Real(region.x),
                Object::Real(region.y),
                Object::Real(region.width),
                Object::Real(region.height),
            ],
        ));
        ops.push(Operation::new("f", vec![]));
        ops.push(Operation::new("Q", vec![]));
    }

    let content = Content { operations: ops };
    let encoded = content.encode()
        .map_err(|e| format!("Page {} redaction stream encoding failed: {}", page_number, e))?;

    let overlay_stream = Stream::new(lopdf::Dictionary::new(), encoded);
    let overlay_id = doc.add_object(Object::Stream(overlay_stream));

    let page_obj = doc.get_object_mut(page_id)
        .map_err(|e| format!("Page {} not found: {}", page_number, e))?;
    let page_dict = page_obj.as_dict_mut()
        .map_err(|e| format!("Page {} is not a dictionary: {}", page_number, e))?;

    let existing = page_dict.get(b"Contents")
        .map_err(|_| format!("Page {} has no Contents entry", page_number))?
        .clone();

    let new_contents = match existing {
        Object::Reference(r) => {
            Object::Array(vec![Object::Reference(r), Object::Reference(overlay_id)])
        }
        Object::Array(mut arr) => {
            arr.push(Object::Reference(overlay_id));
            Object::Array(arr)
        }
        _ => {
            return Err(format!("Page {} Contents has unexpected type", page_number));
        }
    };

    page_dict.set("Contents", new_contents);

    Ok(())
}

/// Walk each content stream on the page, track the graphics/text state, and
/// remove any text-showing operators whose current text position falls within
/// one of the redaction regions.
fn strip_text_in_regions(doc: &mut Document, page_id: (u32, u16), regions: &[&RedactRegion], page_number: u32) -> Result<(), String> {
    // Gather all content stream object IDs for this page.
    let stream_ids = {
        let page_obj = doc.get_object(page_id)
            .map_err(|e| format!("Page {} not found: {}", page_number, e))?;
        let page_dict = page_obj.as_dict()
            .map_err(|e| format!("Page {} is not a dictionary: {}", page_number, e))?;
        let contents = page_dict.get(b"Contents")
            .map_err(|_| format!("Page {} has no Contents entry", page_number))?;
        match contents {
            Object::Reference(r) => vec![*r],
            Object::Array(arr) => {
                arr.iter()
                    .filter_map(|o| if let Object::Reference(r) = o { Some(*r) } else { None })
                    .collect()
            }
            _ => return Ok(()),
        }
    };

    for stream_id in stream_ids {
        let raw_content = {
            let obj = doc.get_object(stream_id)
                .map_err(|e| format!("Page {} stream missing: {}", page_number, e))?;
            match obj.as_stream() {
                // Content streams are frequently compressed (e.g. FlateDecode).
                // `stream.content` is the raw (still-compressed) bytes; we need
                // the decompressed form to parse it as PDF operators.
                Ok(stream) => match stream.get_plain_content() {
                    Ok(bytes) => bytes,
                    Err(_) => continue,
                },
                Err(_) => continue,
            }
        };

        let parsed = match Content::decode(&raw_content) {
            Ok(c) => c,
            Err(_) => continue, // If we can't parse it, skip (don't break the PDF).
        };

        let mut state = GState::new();
        let mut new_ops: Vec<Operation> = Vec::new();
        let mut modified = false;

        for op in &parsed.operations {
            match op.operator.as_ref() {
                // Graphics state
                "q" => { state.save(); new_ops.push(op.clone()); }
                "Q" => { state.restore(); new_ops.push(op.clone()); }
                "cm" => {
                    if let Ok(m) = parse_matrix(&op.operands) {
                        state.ctm = mat_mul(state.ctm, m);
                    }
                    new_ops.push(op.clone());
                }
                // Text state
                "BT" => { state.reset_text(); new_ops.push(op.clone()); }
                "ET" => { new_ops.push(op.clone()); }
                "Tm" => {
                    if let Ok(m) = parse_matrix(&op.operands) {
                        state.tm = m;
                        state.tlm = m;
                    }
                    new_ops.push(op.clone());
                }
                "Td" => {
                    if op.operands.len() >= 2 {
                        let tx = num_val(&op.operands[0]);
                        let ty = num_val(&op.operands[1]);
                        let m = [1.0, 0.0, 0.0, 1.0, tx, ty];
                        state.tlm = mat_mul(m, state.tlm);
                        state.tm = state.tlm;
                    }
                    new_ops.push(op.clone());
                }
                "TD" => {
                    if op.operands.len() >= 2 {
                        let tx = num_val(&op.operands[0]);
                        let ty = num_val(&op.operands[1]);
                        state.leading = -ty;
                        let m = [1.0, 0.0, 0.0, 1.0, tx, ty];
                        state.tlm = mat_mul(m, state.tlm);
                        state.tm = state.tlm;
                    }
                    new_ops.push(op.clone());
                }
                "T*" => {
                    let m = [1.0, 0.0, 0.0, 1.0, 0.0, -state.leading];
                    state.tlm = mat_mul(m, state.tlm);
                    state.tm = state.tlm;
                    new_ops.push(op.clone());
                }
                "TL" => {
                    if !op.operands.is_empty() {
                        state.leading = num_val(&op.operands[0]);
                    }
                    new_ops.push(op.clone());
                }
                "Tf" => {
                    if op.operands.len() >= 2 {
                        state.font_size = num_val(&op.operands[1]);
                    }
                    new_ops.push(op.clone());
                }
                // Text-showing operators — remove if position is inside a region
                "Tj" | "TJ" | "'" | "\"" => {
                    let (px, py) = text_position(&state);
                    // Use a generous vertical range: check both the baseline
                    // and up to font_size above it (where glyphs actually are).
                    let in_region = regions.iter().any(|r| {
                        px >= r.x && px <= r.x + r.width &&
                        // Text baseline might be at py, glyphs extend upward.
                        // Check if any part of the glyph area overlaps the
                        // region vertically.
                        py + state.font_size >= r.y && py <= r.y + r.height
                    });
                    if in_region {
                        modified = true;
                    } else {
                        new_ops.push(op.clone());
                    }
                }
                _ => { new_ops.push(op.clone()); }
            }
        }

        if modified {
            let new_content = Content { operations: new_ops };
            let encoded = new_content.encode()
                .map_err(|e| format!("Page {} re-encode failed: {}", page_number, e))?;

            let stream_obj = doc.get_object_mut(stream_id)
                .map_err(|e| format!("Page {} stream update failed: {}", page_number, e))?;
            if let Ok(stream) = stream_obj.as_stream_mut() {
                // Writes the uncompressed bytes and correctly updates Length
                // while clearing Filter/DecodeParms (we're not re-compressing).
                stream.set_plain_content(encoded);
            }
        }
    }

    Ok(())
}

fn text_position(state: &GState) -> (f32, f32) {
    // Transform text matrix origin through CTM to get user-space position.
    let m = mat_mul(state.tm, state.ctm);
    (m[4], m[5])
}

fn num_val(obj: &Object) -> f32 {
    match obj {
        Object::Real(v) => *v,
        Object::Integer(v) => *v as f32,
        _ => 0.0,
    }
}

fn parse_matrix(operands: &[Object]) -> Result<[f32; 6], ()> {
    if operands.len() < 6 { return Err(()); }
    let mut m = [0.0f32; 6];
    for i in 0..6 {
        m[i] = num_val(&operands[i]);
    }
    Ok(m)
}

fn mat_mul(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

#[derive(Clone)]
struct GState {
    ctm: [f32; 6],
    tm: [f32; 6],
    tlm: [f32; 6],
    leading: f32,
    font_size: f32,
    stack: Vec<GStateSaved>,
}

#[derive(Clone)]
struct GStateSaved {
    ctm: [f32; 6],
}

impl GState {
    fn new() -> Self {
        Self {
            ctm: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            tm: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            tlm: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            leading: 0.0,
            font_size: 12.0,
            stack: Vec::new(),
        }
    }

    fn save(&mut self) {
        self.stack.push(GStateSaved { ctm: self.ctm });
    }

    fn restore(&mut self) {
        if let Some(saved) = self.stack.pop() {
            self.ctm = saved.ctm;
        }
    }

    fn reset_text(&mut self) {
        self.tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        self.tlm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    }
}
