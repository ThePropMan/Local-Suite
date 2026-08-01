mod commands;
mod shared;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// ---------- App state ----------

struct LensState {
    picking: Mutex<bool>,
}

// ---------- Tauri commands (window management) ----------

/// Show the loupe window at the cursor position and start the pick loop.
/// The loupe is click-through (mouse events pass to the desktop).
/// A native thread tracks the cursor at ~60fps and detects left-click
/// via GetAsyncKeyState — no DOM click events needed.
#[tauri::command]
fn start_pick(app: AppHandle, state: tauri::State<LensState>) -> Result<(), String> {
    {
        let mut picking = state.picking.lock().map_err(|e| format!("Lock error: {e}"))?;
        if *picking {
            return Ok(());
        }
        *picking = true;
    }

    // Position loupe near cursor, make click-through, and show it
    if let Some(loupe) = app.get_webview_window("loupe") {
        let (cx, cy) = commands::lens::capture::get_cursor_position();
        let offset = 20i32;
        let _ = loupe.set_position(tauri::PhysicalPosition {
            x: (cx + offset) as f64,
            y: (cy + offset) as f64,
        });
        // Click-through: let mouse events pass to the desktop so the user
        // can click on the actual screen content, not the loupe window.
        let _ = loupe.set_ignore_cursor_events(true);
        let _ = loupe.show();
    }

    // Spawn a native thread: tracks cursor position + detects click natively.
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let offset = 20i32;
        let mut last_x = i32::MIN;
        let mut last_y = i32::MIN;
        let mut lbutton_was_down = false;
        let mut rbutton_was_down = false;

        loop {
            // Check if still picking
            let still_picking = {
                let state = app_for_thread.state::<LensState>();
                let picking = state.picking.lock().unwrap();
                *picking
            };
            if !still_picking {
                break;
            }

            // --- Track cursor position ---
            let (cx, cy) = commands::lens::capture::get_cursor_position();
            if cx != last_x || cy != last_y {
                last_x = cx;
                last_y = cy;
                if let Some(loupe) = app_for_thread.get_webview_window("loupe") {
                    let _ = loupe.set_position(tauri::PhysicalPosition {
                        x: (cx + offset) as f64,
                        y: (cy + offset) as f64,
                    });
                }
            }

            // --- Detect left click (pick color) ---
            #[cfg(windows)]
            {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
                let lbutton_down = (unsafe { GetAsyncKeyState(VK_LBUTTON.into()) } & 0x8000u16 as i16) != 0;
                let rbutton_down = (unsafe { GetAsyncKeyState(VK_RBUTTON.into()) } & 0x8000u16 as i16) != 0;

                // Left click: pick the color
                if lbutton_down && !lbutton_was_down {
                    // Hide loupe FIRST so we capture the real screen pixel,
                    // not the loupe window itself.
                    if let Some(loupe) = app_for_thread.get_webview_window("loupe") {
                        let _ = loupe.hide();
                    }
                    // Brief delay to let the screen repaint without the loupe
                    thread::sleep(Duration::from_millis(30));
                    // Re-read cursor position (it may have moved during the delay)
                    let (px, py) = commands::lens::capture::get_cursor_position();
                    let (r, g, b) = commands::lens::capture::capture_pixel(px, py);
                    let hex = commands::lens::rgb_to_hex(r, g, b);
                    let (h, s, l) = commands::lens::rgb_to_hsl(r, g, b);
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let entry = commands::lens::ColorEntry {
                        hex: hex.clone(),
                        r, g, b,
                        timestamp,
                    };
                    // Add to history in Rust BEFORE emitting, so the event
                    // carries the already-updated list (no race condition).
                    let updated_history = commands::lens::add_to_history_impl(&app_for_thread, entry)
                        .unwrap_or_default();
                    // Emit event with color + updated history to all windows
                    let _ = app_for_thread.emit("lens://color-picked", serde_json::json!({
                        "hex": hex, "r": r, "g": g, "b": b,
                        "h": h, "s": s, "l": l,
                        "history": updated_history
                    }));
                    // Stop picking
                    let state = app_for_thread.state::<LensState>();
                    let mut picking = state.picking.lock().unwrap();
                    *picking = false;
                    break;
                }
                if !lbutton_down {
                    lbutton_was_down = false;
                }

                // Right click: cancel
                if rbutton_down && !rbutton_was_down {
                    let _ = app_for_thread.emit("lens://pick-cancelled", ());
                    let state = app_for_thread.state::<LensState>();
                    let mut picking = state.picking.lock().unwrap();
                    *picking = false;
                    break;
                }
                if !rbutton_down {
                    rbutton_was_down = false;
                }
            }

            thread::sleep(Duration::from_millis(8)); // ~125fps polling for responsive click detection
        }

        // Restore cursor events and hide loupe when tracking ends
        if let Some(loupe) = app_for_thread.get_webview_window("loupe") {
            let _ = loupe.set_ignore_cursor_events(false);
            let _ = loupe.hide();
        }
    });

    Ok(())
}

/// Cancel the pick — hide the loupe window.
#[tauri::command]
fn cancel_pick(app: AppHandle, state: tauri::State<LensState>) -> Result<(), String> {
    {
        let mut picking = state.picking.lock().map_err(|e| format!("Lock error: {e}"))?;
        *picking = false;
    }
    if let Some(loupe) = app.get_webview_window("loupe") {
        let _ = loupe.hide();
    }
    Ok(())
}

/// Complete the pick — hide loupe.
#[tauri::command]
fn finish_pick(app: AppHandle, state: tauri::State<LensState>) -> Result<(), String> {
    {
        let mut picking = state.picking.lock().map_err(|e| format!("Lock error: {e}"))?;
        *picking = false;
    }
    if let Some(loupe) = app.get_webview_window("loupe") {
        let _ = loupe.hide();
    }
    Ok(())
}

/// Show the main window (from tray).
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

/// Hide the main window (minimize to tray).
#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(LensState {
            picking: Mutex::new(false),
        })
        .setup(|app| {
            // ---------- System tray ----------
            let show_item = MenuItem::with_id(app, "show", "Show Lens", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(main) = app.get_webview_window("main") {
                                let _ = main.show();
                                let _ = main.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ---------- Global shortcut ----------
            // Read the hotkey from the store (persisted by the frontend Settings).
            // Falls back to "Ctrl+Shift+C" if not set or store unavailable.
            // on_shortcut registers the shortcut AND wires the handler in one call,
            // so we must NOT call register() separately (causes "HotKey already registered" panic).
            let hotkey_str = tauri_plugin_store::StoreExt::store(app, ".settings.json")
                .ok()
                .and_then(|store| store.get("hotkey"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "Ctrl+Shift+C".to_string());
            let shortcut: Shortcut = hotkey_str.parse()?;
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = _app.state::<LensState>();
                    let _ = start_pick(app_handle.clone(), state);
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // When main window is closed (X button), hide instead of exit (tray resident)
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::lens::pick_color,
            commands::lens::capture_loupe_region,
            commands::lens::get_cursor_pos,
            commands::lens::get_history,
            commands::lens::add_to_history,
            commands::lens::clear_history,
            commands::lens::load_palettes,
            commands::lens::save_palette,
            commands::lens::delete_palette,
            commands::lens::export_palette,
            start_pick,
            cancel_pick,
            finish_pick,
            show_main_window,
            hide_main_window,
            shared::shared_commands::read_file_bytes,
            shared::shared_commands::write_file_bytes,
            shared::shared_commands::file_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
