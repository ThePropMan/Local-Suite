mod commands;
mod shared;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::rename::collect_file_paths,
            commands::rename::preview_rename,
            commands::rename::apply_rename,
            commands::rename::undo_rename,
            commands::rename::save_preset,
            commands::rename::load_presets,
            shared::shared_commands::read_file_bytes,
            shared::shared_commands::write_file_bytes,
            shared::shared_commands::file_size,
            shared::shared_commands::file_modified,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
