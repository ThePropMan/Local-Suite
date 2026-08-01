mod commands;
mod shared;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::vault::vault_state())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_exists,
            commands::vault::create_vault,
            commands::vault::unlock_vault,
            commands::vault::lock_vault,
            commands::vault::is_unlocked,
            commands::vault::get_entries,
            commands::vault::save_entry,
            commands::vault::delete_entry,
            commands::vault::generate_password,
            commands::vault::estimate_strength,
            commands::vault::change_master_password,
            commands::vault::export_vault,
            commands::vault::import_vault,
            shared::shared_commands::read_file_bytes,
            shared::shared_commands::write_file_bytes,
            shared::shared_commands::file_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
