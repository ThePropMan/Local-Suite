mod commands;
mod shared;
#[cfg(target_os = "windows")]
mod mf;
#[cfg(target_os = "windows")]
mod gif_encoder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::convert::convert_video,
            commands::convert::convert_batch,
            commands::convert::probe_video,
            commands::convert::codecs_available,
            shared::shared_commands::read_file_bytes,
            shared::shared_commands::write_file_bytes,
            shared::shared_commands::file_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
