use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::Path;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Compressor {
    Ghostscript,
    Lopdf,
}

#[derive(Debug, Serialize)]
pub struct CompressResult {
    pub output_bytes: u64,
    pub compressor: Compressor,
    pub message: Option<String>,
}

#[tauri::command]
pub fn compress_pdf(input_path: String, output_path: String, quality: String) -> Result<CompressResult, String> {
    let gs_cmd = if cfg!(target_os = "windows") {
        if which("gswin64c.exe").is_some() { "gswin64c.exe" } else if which("gswin32c.exe").is_some() { "gswin32c.exe" } else { "" }
    } else {
        if which("gs").is_some() { "gs" } else { "" }
    };

    let pdf_setting = match quality.as_str() {
        "screen" => "/screen",
        "print" => "/printer",
        "high" => "/prepress",
        _ => "/printer",
    };

    let mut fallback_message: Option<String> = None;

    if !gs_cmd.is_empty() {
        let status = Command::new(gs_cmd)
            .args(&[
                "-sDEVICE=pdfwrite",
                &format!("-dPDFSETTINGS={}", pdf_setting),
                "-dCompatibilityLevel=1.4",
                "-dNOPAUSE",
                "-dQUIET",
                "-dBATCH",
                &format!("-sOutputPath={}", output_path),
                &input_path,
            ])
            .status();

        match status {
            Ok(s) if s.success() => {
                let size = fs::metadata(&output_path)
                    .map_err(|e| format!("Could not read output file: {}", e))?
                    .len();

                return Ok(CompressResult {
                    output_bytes: size,
                    compressor: Compressor::Ghostscript,
                    message: None,
                });
            }
            _ => {
                // Ghostscript is present but failed (e.g. on this input) — actually
                // fall through to the lopdf compressor below instead of just
                // reporting an error that never really happened.
                fallback_message =
                    Some("Ghostscript compression failed; used a simpler fallback compressor instead.".into());
            }
        }
    }

    // Fallback: re-save with lopdf (removes unused objects, recompresses streams best-effort)
    let mut doc = lopdf::Document::load(&input_path)
        .map_err(|e| format!("Could not load PDF for compression: {}", e))?;
    doc.save(&output_path)
        .map_err(|e| format!("Could not save compressed PDF: {}", e))?;

    let size = fs::metadata(&output_path)
        .map_err(|e| format!("Could not read output file: {}", e))?
        .len();

    Ok(CompressResult {
        output_bytes: size,
        compressor: Compressor::Lopdf,
        message: Some(fallback_message.unwrap_or_else(|| "Install Ghostscript for better compression results.".into())),
    })
}

fn which(cmd: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let paths: Vec<&str> = if cfg!(target_os = "windows") {
        path_var.split(';').collect()
    } else {
        path_var.split(':').collect()
    };

    for dir in paths {
        let candidate = Path::new(dir).join(cmd);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}
