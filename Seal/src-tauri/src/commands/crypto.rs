// ============================================================
// Seal — commands/crypto.rs
// Password-based file encryption using AEAD (ChaCha20-Poly1305
// or AES-256-GCM) with an Argon2id KDF and a STREAM construction
// (per-chunk AEAD). Filenames are encrypted because the payload
// is a tar stream. A BLAKE3 root hash is appended for an
// end-to-end integrity check that can be verified without
// extracting files to disk.
//
// .sec archive format:
//   [16-byte Argon2id salt]
//   [1-byte cipher ID]            // 0 = ChaCha20-Poly1305, 1 = AES-256-GCM
//   [4-byte chunk size (u32 LE)]
//   per chunk:
//     [12-byte nonce]
//     [4-byte ciphertext len (u32 LE, includes 16-byte AEAD tag)]
//     [ciphertext + 16-byte AEAD tag]
//   [32-byte BLAKE3 root hash]    // over the plaintext tar stream
// ============================================================

use std::fs;
use std::io::{Read, Write, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce as AesNonce, aead::Aead};
use chacha20poly1305::{ChaCha20Poly1305, Nonce as ChachaNonce};
use argon2::{Argon2, Algorithm, Version, Params};
use blake3::Hasher as Blake3Hasher;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tar::{Builder, Archive};

// ---------- Constants ----------

const SALT_LEN: usize = 16;
const CIPHER_ID_LEN: usize = 1;
const CHUNK_SIZE_LEN: usize = 4;
const HEADER_LEN: usize = SALT_LEN + CIPHER_ID_LEN + CHUNK_SIZE_LEN; // 21
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const CT_LEN_LEN: usize = 4;
const BLAKE3_LEN: usize = 32;
const DEFAULT_CHUNK_SIZE: usize = 256 * 1024; // 256 KiB

const CIPHER_CHACHA: u8 = 0;
const CIPHER_AES: u8 = 1;

// Argon2id parameters (OWASP minimum recommended).
const ARGON2_M_COST: u32 = 19_456; // 19 MiB
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

// ---------- Result types ----------

#[derive(Serialize, Deserialize)]
pub struct EncryptResult {
    pub output_path: String,
    pub input_size: u64,
    pub output_size: u64,
    pub file_count: u64,
    pub duration_ms: u64,
    pub cipher: String,
}

#[derive(Serialize, Deserialize)]
pub struct DecryptResult {
    pub output_dir: String,
    pub file_count: u64,
    pub output_size: u64,
    pub duration_ms: u64,
    pub verified: bool,
    pub cipher: String,
}

#[derive(Serialize, Deserialize)]
pub struct VerifyResult {
    pub ok: bool,
    pub cipher: String,
    pub file_count: u64,
    pub message: String,
}

// ---------- Progress events ----------

/// Payload emitted to the frontend during long-running encrypt/decrypt
/// operations so the progress bar reflects real work instead of jumping
/// from 0 to 100.
#[derive(Serialize, Clone)]
struct ProgressPayload {
    /// Completion percentage in the range 0..=100.
    progress: u32,
}

/// Emit a `seal-progress` event with the given percentage. Errors are
/// ignored — progress is best-effort and must never break an operation.
fn emit_progress(app: &AppHandle, progress: u32) {
    let _ = app.emit("seal-progress", ProgressPayload { progress });
}

// ---------- Cipher dispatch ----------

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|e| format!("Argon2 params error: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

fn encrypt_chunk(cipher_id: u8, key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    match cipher_id {
        CIPHER_CHACHA => {
            let cipher = ChaCha20Poly1305::new(key.into());
            let nonce = ChachaNonce::from_slice(nonce);
            cipher
                .encrypt(nonce, plaintext)
                .map_err(|e| format!("Encryption failed: {e}"))
        }
        CIPHER_AES => {
            let cipher = Aes256Gcm::new(key.into());
            let nonce = AesNonce::from_slice(nonce);
            cipher
                .encrypt(nonce, plaintext)
                .map_err(|e| format!("Encryption failed: {e}"))
        }
        _ => Err(format!("Unknown cipher id: {cipher_id}")),
    }
}

fn decrypt_chunk(cipher_id: u8, key: &[u8; 32], nonce: &[u8; 12], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    match cipher_id {
        CIPHER_CHACHA => {
            let cipher = ChaCha20Poly1305::new(key.into());
            let nonce = ChachaNonce::from_slice(nonce);
            cipher
                .decrypt(nonce, ciphertext)
                .map_err(|_| "Wrong password or corrupt file (AEAD tag verification failed).".to_string())
        }
        CIPHER_AES => {
            let cipher = Aes256Gcm::new(key.into());
            let nonce = AesNonce::from_slice(nonce);
            cipher
                .decrypt(nonce, ciphertext)
                .map_err(|_| "Wrong password or corrupt file (AEAD tag verification failed).".to_string())
        }
        _ => Err(format!("Unknown cipher id: {cipher_id}")),
    }
}

fn cipher_name(id: u8) -> &'static str {
    match id {
        CIPHER_CHACHA => "ChaCha20-Poly1305",
        CIPHER_AES => "AES-256-GCM",
        _ => "unknown",
    }
}

fn cipher_id_from_str(name: &str) -> Result<u8, String> {
    match name.to_lowercase().as_str() {
        "chacha20-poly1305" | "chacha" | "chacha20" => Ok(CIPHER_CHACHA),
        "aes-256-gcm" | "aes" | "aes256" | "aes-gcm" => Ok(CIPHER_AES),
        _ => Err(format!("Unknown cipher: {name}")),
    }
}

// ---------- Tar helpers ----------

/// Recursively add a path to a tar builder. `entry_name` is the name
/// the path should have inside the archive (basename of the input).
fn add_to_tar(builder: &mut Builder<BufWriter<fs::File>>, path: &Path, entry_name: &str) -> Result<u64, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Cannot stat {}: {e}", path.display()))?;
    let mut count = 0u64;

    if meta.is_dir() {
        // Add the directory entry itself.
        let mut header = tar::Header::new_gnu();
        header.set_path(entry_name).map_err(|e| format!("tar path error: {e}"))?;
        header.set_size(0);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Directory);
        header.set_cksum();
        builder
            .append(&header, &mut std::io::empty())
            .map_err(|e| format!("tar append dir error: {e}"))?;

        // Recurse into children.
        let entries = fs::read_dir(path).map_err(|e| format!("Cannot read dir {}: {e}", path.display()))?;
        let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        paths.sort();
        for child in paths {
            let child_name = child
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| format!("Non-UTF-8 path: {}", child.display()))?;
            let full_name = format!("{entry_name}/{child_name}");
            count += add_to_tar(builder, &child, &full_name)?;
        }
    } else if meta.is_file() {
        let mut file = fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        builder
            .append_file(entry_name, &mut file)
            .map_err(|e| format!("tar append file error: {e}"))?;
        count += 1;
    }
    // Symlinks and other special files are skipped silently in v1.
    Ok(count)
}

/// Build a tar archive of all input paths into a temp file.
/// Returns (temp_file_path, total_plaintext_size, file_count).
fn build_tar(input_paths: &[String]) -> Result<(PathBuf, u64, u64), String> {
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("seal-{}.tar", std::process::id()));
    let file = fs::File::create(&tmp_path).map_err(|e| format!("Cannot create temp tar: {e}"))?;
    let writer = BufWriter::new(file);
    let mut builder = Builder::new(writer);

    let mut total_size = 0u64;
    let mut file_count = 0u64;

    for path_str in input_paths {
        let path = Path::new(path_str);
        if !path.exists() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Path does not exist: {}", path.display()));
        }
        let basename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("Non-UTF-8 path: {}", path.display()))?;
        file_count += add_to_tar(&mut builder, path, basename)?;
        if let Ok(meta) = fs::metadata(path) {
            if meta.is_file() {
                total_size += meta.len();
            } else if meta.is_dir() {
                total_size += dir_size(path);
            }
        }
    }

    builder.finish().map_err(|e| format!("tar finish error: {e}"))?;
    // Flush the BufWriter by dropping the builder.
    drop(builder);
    Ok((tmp_path, total_size, file_count))
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total += meta.len();
                } else if meta.is_dir() {
                    total += dir_size(&p);
                }
            }
        }
    }
    total
}

/// Generate a STREAM nonce: 8 random bytes + 4-byte chunk counter (LE).
fn make_nonce(base: &[u8; 8], chunk_index: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(base);
    nonce[8..12].copy_from_slice(&chunk_index.to_le_bytes());
    nonce
}

// ---------- Commands ----------

/// Encrypt files/folders into a single .sec archive.
#[tauri::command]
pub fn encrypt_file(
    app: AppHandle,
    input_paths: Vec<String>,
    output_path: String,
    password: String,
    cipher: String,
) -> Result<EncryptResult, String> {
    if input_paths.is_empty() {
        return Err("No input paths provided.".to_string());
    }
    if password.is_empty() {
        return Err("Password cannot be empty.".to_string());
    }
    let cipher_id = cipher_id_from_str(&cipher)?;
    let start = Instant::now();

    // 1. Build the tar archive (plaintext) into a temp file.
    let (tar_path, input_size, file_count) = build_tar(&input_paths)?;

    // 2. Generate salt and derive key.
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(&password, &salt)?;

    // 3. Generate random base for STREAM nonces.
    let mut nonce_base = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce_base);

    // 4. Open the output file and write the header.
    let out_file = fs::File::create(&output_path)
        .map_err(|e| format!("Cannot create output file {}: {e}", output_path))?;
    let mut out = BufWriter::new(out_file);
    out.write_all(&salt).map_err(|e| write_err(e))?;
    out.write_all(&[cipher_id]).map_err(|e| write_err(e))?;
    out.write_all(&(DEFAULT_CHUNK_SIZE as u32).to_le_bytes())
        .map_err(|e| write_err(e))?;

    // 5. Read the tar in chunks, encrypt each, write to output.
    //    Feed each plaintext chunk to BLAKE3 for the integrity hash.
    let tar_file = fs::File::open(&tar_path).map_err(|e| format!("Cannot open temp tar: {e}"))?;
    let mut reader = BufReader::new(tar_file);
    let mut buf = vec![0u8; DEFAULT_CHUNK_SIZE];
    let mut blake = Blake3Hasher::new();
    let mut chunk_index = 0u32;
    let mut processed = 0u64;
    let total = input_size.max(1);

    loop {
        let mut filled = 0usize;
        while filled < buf.len() {
            let n = reader.read(&mut buf[filled..]).map_err(|e| format!("tar read error: {e}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        let plaintext = &buf[..filled];
        blake.update(plaintext);
        let nonce = make_nonce(&nonce_base, chunk_index);
        let ciphertext = encrypt_chunk(cipher_id, &key, &nonce, plaintext)?;
        out.write_all(&nonce).map_err(|e| write_err(e))?;
        out.write_all(&(ciphertext.len() as u32).to_le_bytes())
            .map_err(|e| write_err(e))?;
        out.write_all(&ciphertext).map_err(|e| write_err(e))?;
        chunk_index = chunk_index.wrapping_add(1);
        processed += filled as u64;
        let pct = ((processed * 100) / total).min(99) as u32;
        emit_progress(&app, pct);
        if filled < buf.len() {
            break; // last (short) chunk
        }
    }

    // 6. Write the BLAKE3 root hash.
    let hash = blake.finalize();
    out.write_all(hash.as_bytes()).map_err(|e| write_err(e))?;
    out.flush().map_err(|e| write_err(e))?;
    drop(out);

    // 7. Clean up the temp tar.
    let _ = fs::remove_file(&tar_path);

    let output_size = fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(EncryptResult {
        output_path,
        input_size,
        output_size,
        file_count,
        duration_ms,
        cipher: cipher_name(cipher_id).to_string(),
    })
}

/// Decrypt a .sec archive and extract files to the output directory.
#[tauri::command]
pub fn decrypt_file(
    app: AppHandle,
    input_path: String,
    output_dir: String,
    password: String,
) -> Result<DecryptResult, String> {
    let (file_count, output_size, verified, cipher_id, duration_ms) =
        decrypt_stream(&app, &input_path, &password, Some(&output_dir))?;
    Ok(DecryptResult {
        output_dir,
        file_count,
        output_size,
        duration_ms,
        verified,
        cipher: cipher_name(cipher_id).to_string(),
    })
}

/// Verify a .sec archive's integrity without extracting files to disk.
#[tauri::command]
pub fn verify_file(
    app: AppHandle,
    input_path: String,
    password: String,
) -> Result<VerifyResult, String> {
    let (file_count, _output_size, verified, cipher_id, _duration_ms) =
        decrypt_stream(&app, &input_path, &password, None)?;
    let message = if verified {
        "Integrity verified. All AEAD tags and the BLAKE3 root hash match.".to_string()
    } else {
        "BLAKE3 root hash mismatch — the archive may be corrupt.".to_string()
    };
    Ok(VerifyResult {
        ok: verified,
        cipher: cipher_name(cipher_id).to_string(),
        file_count,
        message,
    })
}

/// Core decrypt/verify routine. If `extract_dir` is Some, extracts the
/// decrypted tar to that directory. Returns
/// (file_count, plaintext_size, blake3_verified, cipher_id, duration_ms).
fn decrypt_stream(
    app: &AppHandle,
    input_path: &str,
    password: &str,
    extract_dir: Option<&str>,
) -> Result<(u64, u64, bool, u8, u64), String> {
    let start = Instant::now();
    let file_size = fs::metadata(input_path)
        .map_err(|e| format!("Cannot read input file: {e}"))?
        .len();
    if (file_size as usize) < HEADER_LEN + BLAKE3_LEN {
        return Err("File is too small to be a valid .sec archive.".to_string());
    }

    let mut file = BufReader::new(
        fs::File::open(input_path).map_err(|e| format!("Cannot open input file: {e}"))?,
    );

    // 1. Read header.
    let mut salt = [0u8; SALT_LEN];
    file.read_exact(&mut salt).map_err(|e| format!("Read salt: {e}"))?;
    let mut cipher_id_buf = [0u8; 1];
    file.read_exact(&mut cipher_id_buf).map_err(|e| format!("Read cipher id: {e}"))?;
    let cipher_id = cipher_id_buf[0];
    let mut chunk_size_buf = [0u8; CHUNK_SIZE_LEN];
    file.read_exact(&mut chunk_size_buf).map_err(|e| format!("Read chunk size: {e}"))?;
    let chunk_size = u32::from_le_bytes(chunk_size_buf) as usize;
    if chunk_size == 0 || chunk_size > 64 * 1024 * 1024 {
        return Err(format!("Invalid chunk size in header: {chunk_size}"));
    }

    // 2. Derive key.
    let key = derive_key(password, &salt)?;

    // 3. The encrypted region is everything between the header and the
    //    final 32-byte BLAKE3 hash. Read and decrypt chunk by chunk into
    //    a temp tar file, feeding plaintext to BLAKE3.
    let encrypted_len = file_size as usize - HEADER_LEN - BLAKE3_LEN;
    let mut consumed = 0usize;
    let total = (encrypted_len as u64).max(1);
    let mut blake = Blake3Hasher::new();
    let mut plaintext_size = 0u64;

    let tmp_dir = std::env::temp_dir();
    let tmp_tar = tmp_dir.join(format!("seal-decrypt-{}.tar", std::process::id()));
    let tmp_file = fs::File::create(&tmp_tar).map_err(|e| format!("Create temp tar: {e}"))?;
    let mut tmp_writer = BufWriter::new(tmp_file);

    let mut chunk_index = 0u32;
    while consumed < encrypted_len {
        // Read nonce.
        let mut nonce = [0u8; NONCE_LEN];
        file.read_exact(&mut nonce).map_err(|e| format!("Read nonce: {e}"))?;
        consumed += NONCE_LEN;

        // Read ciphertext length.
        let mut ct_len_buf = [0u8; CT_LEN_LEN];
        file.read_exact(&mut ct_len_buf).map_err(|e| format!("Read ct len: {e}"))?;
        consumed += CT_LEN_LEN;
        let ct_len = u32::from_le_bytes(ct_len_buf) as usize;
        if ct_len < TAG_LEN {
            return Err(format!("Invalid ciphertext length: {ct_len}"));
        }

        // Read ciphertext.
        let mut ciphertext = vec![0u8; ct_len];
        file.read_exact(&mut ciphertext).map_err(|e| format!("Read ciphertext: {e}"))?;
        consumed += ct_len;

        // Decrypt.
        let plaintext = decrypt_chunk(cipher_id, &key, &nonce, &ciphertext)?;
        blake.update(&plaintext);
        plaintext_size += plaintext.len() as u64;
        tmp_writer
            .write_all(&plaintext)
            .map_err(|e| format!("Write temp tar: {e}"))?;
        chunk_index = chunk_index.wrapping_add(1);
        let pct = ((consumed as u64 * 100) / total).min(99) as u32;
        emit_progress(app, pct);
    }

    // 4. Read the stored BLAKE3 hash and compare.
    let mut stored_hash = [0u8; BLAKE3_LEN];
    file.read_exact(&mut stored_hash).map_err(|e| format!("Read blake3 hash: {e}"))?;
    let computed_hash = blake.finalize();
    let verified = computed_hash.as_bytes() == &stored_hash[..];

    tmp_writer.flush().map_err(|e| format!("Flush temp tar: {e}"))?;
    drop(tmp_writer);

    // 5. Optionally extract the tar.
    let mut file_count = 0u64;
    if let Some(dir) = extract_dir {
        let out_dir = Path::new(dir);
        fs::create_dir_all(out_dir).map_err(|e| format!("Cannot create output dir: {e}"))?;
        let tar_file = fs::File::open(&tmp_tar).map_err(|e| format!("Open temp tar: {e}"))?;
        let mut archive = Archive::new(tar_file);
        archive.set_overwrite(true);
        archive.unpack(out_dir).map_err(|e| format!("Extract tar: {e}"))?;
        // Count extracted files.
        let tar_file2 = fs::File::open(&tmp_tar).map_err(|e| format!("Open temp tar: {e}"))?;
        let mut archive2 = Archive::new(tar_file2);
        for entry in archive2.entries().map_err(|e| format!("Read tar entries: {e}"))? {
            if let Ok(entry) = entry {
                if entry.header().entry_type() == tar::EntryType::Regular {
                    file_count += 1;
                }
            }
        }
    } else {
        // Verify-only: count files from tar headers without extracting.
        let tar_file2 = fs::File::open(&tmp_tar).map_err(|e| format!("Open temp tar: {e}"))?;
        let mut archive2 = Archive::new(tar_file2);
        for entry in archive2.entries().map_err(|e| format!("Read tar entries: {e}"))? {
            if let Ok(entry) = entry {
                if entry.header().entry_type() == tar::EntryType::Regular {
                    file_count += 1;
                }
            }
        }
    }

    let _ = fs::remove_file(&tmp_tar);
    let duration_ms = start.elapsed().as_millis() as u64;

    Ok((file_count, plaintext_size, verified, cipher_id, duration_ms))
}

fn write_err(e: std::io::Error) -> String {
    format!("Write error: {e}")
}
