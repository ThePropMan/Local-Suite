// ============================================================
// Clip — lib.rs
// Tray-resident clipboard manager. Sets up the SQLite store, the
// background clipboard monitor, the system tray, the global hotkey,
// and the popup window's show/hide behavior.
// ============================================================

mod commands;

use commands::clipboard::{self, AppState};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn build_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Clip", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Clip", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("no default window icon")?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Clip")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => clipboard::toggle_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                clipboard::toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn setup_window_events(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let win: WebviewWindow = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let w = win.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // The popup never truly closes; hide instead so the app stays
            // resident in the tray.
            api.prevent_close();
            let _ = w.hide();
        }
        _ => {}
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gs = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                clipboard::toggle_window(app);
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(gs)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state: AppState = clipboard::init_db(app.handle())?;

            // Register the saved hotkey before anything else can use it.
            let hotkey = clipboard::read_hotkey(&state.db);
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[clip] failed to register hotkey '{hotkey}': {e}");
            }

            // Start the background clipboard monitor. Pass the precomputed
            // key so the monitor never needs to run Argon2.
            let db_mon = state.db.clone();
            let key_mon = state.key;
            let app_mon = app.handle().clone();
            std::thread::spawn(move || clipboard::monitor_loop(db_mon, key_mon, app_mon));

            app.manage(state);

            // Tray is best-effort: if it fails, the window still shows on
            // startup so the user can interact with the app.
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[clip] tray build failed (window will show on startup): {e}");
            }

            setup_window_events(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clipboard::get_recent,
            clipboard::search_history,
            clipboard::pin_entry,
            clipboard::unpin_entry,
            clipboard::delete_entry,
            clipboard::clear_history,
            clipboard::paste_entry,
            clipboard::get_settings,
            clipboard::set_settings,
            clipboard::get_stats,
            clipboard::set_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
