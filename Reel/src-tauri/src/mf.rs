// ============================================================
// Reel — mf.rs
// Media Foundation pipeline for video conversion on Windows.
//
// Uses IMFSourceReader to decode input files and IMFSinkWriter
// to encode H.264/H.265 + AAC into MP4 containers. The OS handles
// patent licensing for H.264/H.265/AAC.
// ============================================================

#![cfg(target_os = "windows")]

use std::sync::OnceLock;
use std::time::Instant;

use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_Main, eAVEncH265VProfile_Main_420_8, MFCreateMediaType,
    MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFStartup, MF_MT_AVG_BITRATE,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MPEG2_PROFILE, MF_MT_SUBTYPE, MFAudioFormat_AAC, MFAudioFormat_PCM, MFMediaType_Audio,
    MFMediaType_Video, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED,
    MF_SOURCE_READERF_ENDOFSTREAM, MFSTARTUP_FULL, MF_VERSION, MFVideoFormat_H264,
    MFVideoFormat_H265, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::commands::convert::{ConvertOptions, ConvertResult, OutputFormat, ProbeResult};

/// Pack two u32 values into a u64 (high:low), the layout MF uses for
/// frame size (width:height) and frame rate (numerator:denominator).
fn pack_u32_pair(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | (low as u64)
}

/// Unpack a u64 into (high, low) u32 pair.
fn unpack_u64(val: u64) -> (u32, u32) {
    ((val >> 32) as u32, val as u32)
}

/// Process-wide MF startup. Called once; MFShutdown is never called
/// (the OS reclaims at process exit).
fn mf_startup() -> bool {
    static INIT: OnceLock<bool> = OnceLock::new();
    *INIT.get_or_init(|| unsafe {
        // Best-effort COM init. S_FALSE (already init) and
        // RPC_E_CHANGED_MODE are both fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL).is_ok()
    })
}

/// Convert a video file using Media Foundation.
///
/// Flow: Source Reader (decode input) → Sink Writer (encode output).
/// Handles both video and audio streams. The sink writer handles
/// container muxing (MP4) automatically.
pub fn convert_with_mf(
    input_path: &str,
    output_path: &str,
    options: &ConvertOptions,
) -> ConvertResult {
    let start = Instant::now();
    let input_size = std::fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);

    if !mf_startup() {
        return ConvertResult {
            success: false,
            output_path: output_path.to_string(),
            output_size: 0,
            input_size,
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some("Media Foundation failed to initialize".into()),
        };
    }

    match unsafe { convert_inner(input_path, output_path, options) } {
        Ok(output_size) => ConvertResult {
            success: true,
            output_path: output_path.to_string(),
            output_size,
            input_size,
            duration_ms: start.elapsed().as_millis() as u64,
            error: None,
        },
        Err(e) => ConvertResult {
            success: false,
            output_path: output_path.to_string(),
            output_size: 0,
            input_size,
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some(e),
        },
    }
}

unsafe fn convert_inner(
    input_path: &str,
    output_path: &str,
    options: &ConvertOptions,
) -> Result<u64, String> {
    // 1. Create source reader from input file
    let input_hstr = HSTRING::from(input_path);
    let source_reader = MFCreateSourceReaderFromURL(&input_hstr, None)
        .map_err(|e| format!("Failed to create source reader: {e}"))?;

    // 2. Select video and audio streams
    source_reader
        .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
        .map_err(|e| format!("Failed to deselect all streams: {e}"))?;
    source_reader
        .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
        .map_err(|e| format!("Failed to select video stream: {e}"))?;
    // Try to select audio (may not exist)
    let has_audio = source_reader
        .SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true)
        .is_ok();

    // 3. Get input video format from source reader
    let input_video_type = source_reader
        .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        .map_err(|e| format!("Failed to get video media type: {e}"))?;

    let (in_w, in_h) = get_video_dimensions(&input_video_type)?;
    let (fps_num, fps_den) = get_video_framerate(&input_video_type)?;
    let input_fps = if fps_den > 0 {
        fps_num as f64 / fps_den as f64
    } else {
        30.0
    };

    // Calculate output dimensions
    let (out_w, out_h) = calculate_output_size(in_w, in_h, options.width, options.height);

    // Calculate output framerate
    let out_fps = if options.fps > 0 {
        options.fps
    } else {
        input_fps.round() as u32
    };
    let out_fps = out_fps.max(1);

    // 4. Create sink writer for output file
    let output_hstr = HSTRING::from(output_path);
    let sink_writer = MFCreateSinkWriterFromURL(&output_hstr, None, None)
        .map_err(|e| format!("Failed to create sink writer: {e}"))?;

    // 5. Configure output video media type
    let video_out_type = MFCreateMediaType()
        .map_err(|e| format!("Failed to create output media type: {e}"))?;

    let (video_subtype, video_profile) = match options.format {
        OutputFormat::Mp4H264 => (&MFVideoFormat_H264, eAVEncH264VProfile_Main.0 as u32),
        OutputFormat::Mp4H265 => (&MFVideoFormat_H265, eAVEncH265VProfile_Main_420_8.0 as u32),
        _ => return Err("Format not supported by Media Foundation".into()),
    };

    video_out_type
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|e| format!("Set major type: {e}"))?;
    video_out_type
        .SetGUID(&MF_MT_SUBTYPE, video_subtype)
        .map_err(|e| format!("Set subtype: {e}"))?;
    video_out_type
        .SetUINT64(&MF_MT_FRAME_SIZE, pack_u32_pair(out_w, out_h))
        .map_err(|e| format!("Set frame size: {e}"))?;
    video_out_type
        .SetUINT64(&MF_MT_FRAME_RATE, pack_u32_pair(out_fps, 1))
        .map_err(|e| format!("Set frame rate: {e}"))?;
    video_out_type
        .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        .map_err(|e| format!("Set interlace: {e}"))?;
    video_out_type
        .SetUINT32(&MF_MT_MPEG2_PROFILE, video_profile)
        .map_err(|e| format!("Set profile: {e}"))?;

    if options.video_bitrate > 0 {
        video_out_type
            .SetUINT32(&MF_MT_AVG_BITRATE, options.video_bitrate * 1000)
            .map_err(|e| format!("Set bitrate: {e}"))?;
    }

    let video_stream_index = sink_writer
        .AddStream(&video_out_type)
        .map_err(|e| format!("AddStream video: {e}"))?;

    // 6. Configure output audio media type (if audio exists and not stripped)
    let mut audio_stream_index: Option<u32> = None;
    if has_audio && !options.no_audio {
        let audio_out_type = MFCreateMediaType()
            .map_err(|e| format!("Create audio type: {e}"))?;
        audio_out_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|e| format!("Set audio major: {e}"))?;
        audio_out_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(|e| format!("Set audio subtype: {e}"))?;
        audio_out_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
            .map_err(|e| format!("Set audio channels: {e}"))?;
        audio_out_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 44100)
            .map_err(|e| format!("Set audio sample rate: {e}"))?;
        audio_out_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|e| format!("Set audio bits: {e}"))?;

        if let Ok(a_idx) = sink_writer.AddStream(&audio_out_type) {
            audio_stream_index = Some(a_idx);
        }
    }

    // 7. Set input media types on sink writer
    // For video: tell the sink writer we'll provide NV12 frames
    let video_in_type = MFCreateMediaType()
        .map_err(|e| format!("Create video input type: {e}"))?;
    video_in_type
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|e| format!("Set video in major: {e}"))?;
    video_in_type
        .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
        .map_err(|e| format!("Set video in subtype: {e}"))?;
    video_in_type
        .SetUINT64(&MF_MT_FRAME_SIZE, pack_u32_pair(out_w, out_h))
        .map_err(|e| format!("Set video in frame size: {e}"))?;
    video_in_type
        .SetUINT64(&MF_MT_FRAME_RATE, pack_u32_pair(out_fps, 1))
        .map_err(|e| format!("Set video in frame rate: {e}"))?;
    video_in_type
        .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        .map_err(|e| format!("Set video in interlace: {e}"))?;

    sink_writer
        .SetInputMediaType(video_stream_index, &video_in_type, None)
        .map_err(|e| format!("SetInputMediaType video: {e}"))?;

    // For audio: tell the sink writer we'll provide PCM
    if let Some(a_idx) = audio_stream_index {
        let audio_in_type = MFCreateMediaType()
            .map_err(|e| format!("Create audio input type: {e}"))?;
        audio_in_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|e| format!("Set audio in major: {e}"))?;
        audio_in_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|e| format!("Set audio in subtype: {e}"))?;
        audio_in_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
            .map_err(|e| format!("Set audio in channels: {e}"))?;
        audio_in_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 44100)
            .map_err(|e| format!("Set audio in sample rate: {e}"))?;
        audio_in_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|e| format!("Set audio in bits: {e}"))?;

        let _ = sink_writer.SetInputMediaType(a_idx, &audio_in_type, None);
    }

    // 8. Tell source reader to output NV12 for video
    source_reader
        .SetCurrentMediaType(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            None,
            &video_in_type,
        )
        .map_err(|e| format!("Set source reader video type: {e}"))?;

    // 9. Begin writing
    sink_writer
        .BeginWriting()
        .map_err(|e| format!("BeginWriting: {e}"))?;

    // 10. Read → Write loop
    let mut frame_count: u64 = 0;
    let trim_end_frames = if options.trim_end > 0.0 {
        Some((options.trim_end * out_fps as f64) as u64)
    } else {
        None
    };
    let trim_start_frames = (options.trim_start * out_fps as f64) as u64;

    loop {
        let mut stream_index: u32 = 0;
        let mut stream_flags: u32 = 0;
        let mut timestamp: i64 = 0;
        let mut sample: Option<windows::Win32::Media::MediaFoundation::IMFSample> = None;

        let hr = source_reader.ReadSample(
            MF_SOURCE_READER_ALL_STREAMS.0 as u32,
            0, // MF_SOURCE_READER_CONTROL_FLAG_DEFAULT = 0
            Some(&mut stream_index),
            Some(&mut stream_flags),
            Some(&mut timestamp),
            Some(&mut sample),
        );

        if let Err(e) = hr {
            return Err(format!("ReadSample failed: {e}"));
        }

        // Check for end of stream
        if stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }

        // Check for format change
        if stream_flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
            if let Ok(new_type) = source_reader.GetCurrentMediaType(stream_index) {
                let _ = sink_writer.SetInputMediaType(stream_index, &new_type, None);
            }
        }

        let sample = match sample {
            Some(s) => s,
            None => continue,
        };

        // Determine which stream this is
        if stream_index == MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32 {
            // Apply trim
            if frame_count < trim_start_frames {
                frame_count += 1;
                continue;
            }
            if let Some(end) = trim_end_frames {
                if frame_count >= end {
                    break;
                }
            }

            // Adjust timestamp for trim
            let adjusted_ts =
                timestamp - (trim_start_frames as i64 * 10_000_000 / out_fps as i64);
            sample
                .SetSampleTime(adjusted_ts)
                .map_err(|e| format!("SetSampleTime: {e}"))?;

            sink_writer
                .WriteSample(video_stream_index, &sample)
                .map_err(|e| format!("WriteSample video: {e}"))?;
            frame_count += 1;
        } else if let Some(a_idx) = audio_stream_index {
            if stream_index == MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32 {
                let _ = sink_writer.WriteSample(a_idx, &sample);
            }
        }
    }

    // 11. Finalize
    sink_writer
        .Finalize()
        .map_err(|e| format!("Finalize: {e}"))?;

    // Drop COM objects before checking output
    drop(sink_writer);
    drop(source_reader);

    let output_size = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(output_size)
}

/// Probe a video file using Media Foundation source reader.
pub fn probe_with_mf(path: &str) -> ProbeResult {
    let default = ProbeResult {
        duration_sec: 0.0,
        width: 0,
        height: 0,
        fps: 0.0,
        has_audio: false,
        has_video: false,
        codec_video: "unknown".into(),
        codec_audio: "unknown".into(),
        container: path.rsplit('.').next().unwrap_or("unknown").to_uppercase(),
    };

    if !mf_startup() {
        return default;
    }

    unsafe {
        let hstr = HSTRING::from(path);
        let reader = match MFCreateSourceReaderFromURL(&hstr, None) {
            Ok(r) => r,
            Err(_) => return default,
        };

        // Get video stream info
        let mut has_video = false;
        let mut width = 0u32;
        let mut height = 0u32;
        let mut fps = 0.0f64;
        let mut codec_video = "unknown".to_string();

        if let Ok(vtype) =
            reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        {
            has_video = true;
            if let Ok((w, h)) = get_video_dimensions(&vtype) {
                width = w;
                height = h;
            }
            if let Ok((fn_num, fn_den)) = get_video_framerate(&vtype) {
                fps = if fn_den > 0 {
                    fn_num as f64 / fn_den as f64
                } else {
                    0.0
                };
            }
            codec_video = get_video_codec_name(&vtype);
        }

        // Get audio stream info
        let mut has_audio = false;
        let mut codec_audio = "unknown".to_string();

        if let Ok(atype) =
            reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32)
        {
            has_audio = true;
            codec_audio = get_audio_codec_name(&atype);
        }

        ProbeResult {
            duration_sec: 0.0, // TODO: requires PROPVARIANT access
            width,
            height,
            fps,
            has_audio,
            has_video,
            codec_video,
            codec_audio,
            container: path.rsplit('.').next().unwrap_or("unknown").to_uppercase(),
        }
    }
}

// ---------- Helper functions ----------

fn get_video_dimensions(
    mt: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> Result<(u32, u32), String> {
    unsafe {
        let val = mt
            .GetUINT64(&MF_MT_FRAME_SIZE)
            .map_err(|e| format!("GetUINT64 frame size: {e}"))?;
        let (w, h) = unpack_u64(val);
        Ok((w, h))
    }
}

fn get_video_framerate(
    mt: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> Result<(u32, u32), String> {
    unsafe {
        let val = mt
            .GetUINT64(&MF_MT_FRAME_RATE)
            .map_err(|e| format!("GetUINT64 frame rate: {e}"))?;
        let (num, den) = unpack_u64(val);
        Ok((num, den))
    }
}

fn get_video_codec_name(
    mt: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> String {
    unsafe {
        match mt.GetGUID(&MF_MT_SUBTYPE) {
            Ok(guid) => {
                let data = guid.data1;
                match data {
                    0x34363248 | 0x34363268 => "H.264".into(), // H264 / h264
                    0x4356484D | 0x43564853 => "H.265".into(), // HVC1 / SHVC
                    0x39307076 => "VP9".into(),               // vp90
                    0x30385056 => "VP8".into(),               // VP80
                    0x31435641 => "AV1".into(),               // AV01
                    0x3336564D => "WMV3".into(),
                    0x3136564D => "WMV1".into(),
                    0x3156534D => "MSV1".into(),
                    _ => format!("0x{:08X}", data),
                }
            }
            Err(_) => "unknown".into(),
        }
    }
}

fn get_audio_codec_name(
    mt: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> String {
    unsafe {
        match mt.GetGUID(&MF_MT_SUBTYPE) {
            Ok(guid) => {
                let data = guid.data1;
                match data {
                    0x0001 => "PCM".into(),
                    0x0010 => "AAC".into(),
                    0x0055 => "MP3".into(),
                    0x0061 => "WMA".into(),
                    0x0069 => "WMA Pro".into(),
                    0x674F => "Vorbis".into(),
                    0x6F71 => "Opus".into(),
                    _ => format!("0x{:08X}", data),
                }
            }
            Err(_) => "unknown".into(),
        }
    }
}

fn calculate_output_size(in_w: u32, in_h: u32, target_w: u32, target_h: u32) -> (u32, u32) {
    if target_w > 0 && target_h > 0 {
        return (target_w, target_h);
    }
    if target_w > 0 {
        let h = (in_h as f64 * target_w as f64 / in_w as f64).round() as u32;
        return (target_w, h & !1); // Even dimensions for H.264
    }
    if target_h > 0 {
        let w = (in_w as f64 * target_h as f64 / in_h as f64).round() as u32;
        return (w & !1, target_h);
    }
    (in_w, in_h)
}
