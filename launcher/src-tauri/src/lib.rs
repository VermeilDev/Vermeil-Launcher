// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

mod commands;
mod error;
mod models;
mod services;
mod util;

pub use error::AppError;

use commands::{app_updater, auth, cf_import, cloud_sync, files, instances, java, launch, meta, mods, settings, skins};
use services::app_updater::PendingUpdate;
use tauri::Manager;

/// Show the main window — called by frontend after initialization completes.
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Logical-pixel floor for the launcher's main window. The same numbers live
/// in `tauri.conf.json`, but the conf-level minimum can't be relied on by
/// itself: on Linux compositors that don't enforce `xdg_toplevel.set_min_size`
/// for client-side-decorated windows (we are CSD by `decorations: false`), the
/// user can drag a window edge below the hint. Centralizing the constants
/// here lets the setup-time migration and the runtime resize-event clamp
/// share a single source of truth.
const MIN_WIDTH: f64 = 1100.0;
const MIN_HEIGHT: f64 = 720.0;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,discord_presence=off"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .init();

    // Discord RPC watcher: polls setting every 5s, connects/disconnects instantly
    services::discord::spawn_watcher();

    tauri::Builder::default()
        .manage(PendingUpdate::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // Migrate any legacy root-level cache directories to <data_dir>/cache/
            crate::util::paths::migrate_legacy_cache_dirs();

            // Create the companion mod's data scaffold (folders + default
            // vermeil-settings.json) up front, so the layout and a fully-populated
            // settings file always exist regardless of whether a cape is set.
            crate::services::companion_settings::ensure_scaffold();

            // Initialize download speed limit from persisted settings
            tauri::async_runtime::spawn(async {
                if let Ok(s) = crate::services::settings_service::load().await {
                    crate::services::download::set_speed_limit_mb(s.download_speed_limit_mb);
                }
            });

            // Window shadow for native frameless look
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(true);

                // Square the window corners on Windows 11. DWM otherwise rounds
                // every top-level window's corners by default; for our blocky
                // sharp-edge UI that round halo at the very edges of the frame
                // looks out of place. Asks the compositor to render the corners
                // as `DWMWCP_DONOTROUND`. No-op on Win10 / Linux. Logged but
                // never fatal — a missing rounded-corner override is cosmetic.
                #[cfg(windows)]
                {
                    use windows_sys::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        let pref: u32 = DWMWCP_DONOTROUND as u32;
                        unsafe {
                            let _ = DwmSetWindowAttribute(
                                hwnd.0 as _,
                                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                                &pref as *const _ as *const _,
                                std::mem::size_of::<u32>() as u32,
                            );
                        }
                    }
                }

                // Pin the minimum window size in logical pixels. Two reasons
                // we do this in setup() instead of relying solely on
                // `tauri.conf.json`:
                //
                //   1. Tauri 2 has a known issue (#7075) where the conf
                //      `minWidth`/`minHeight` can be flaky depending on
                //      window setup ordering. Re-applying from setup is the
                //      canonical workaround.
                //   2. We want a hard floor at the launcher's intended
                //      design size.
                //
                // Logical pixels are DPI-independent so this works the same
                // on a 4k monitor at 200% scale as it does at 100%. The
                // constants live at module scope (MIN_WIDTH / MIN_HEIGHT) so
                // the runtime resize-event clamp below uses the same floor.
                let _ = window.set_min_size(Some(tauri::Size::Logical(
                    tauri::LogicalSize {
                        width: MIN_WIDTH,
                        height: MIN_HEIGHT,
                    },
                )));

                // Open window at the user's chosen window size preset (defaulting to 1100x720).
                let (init_width, init_height) = {
                    let config_path = crate::util::paths::data_dir().join("config.json");
                    if let Ok(content) = std::fs::read_to_string(config_path) {
                        if let Ok(s) = serde_json::from_str::<crate::models::settings::LauncherSettings>(&content) {
                            crate::models::settings::LauncherSettings::parse_window_size_preset(&s.window_size_preset)
                        } else {
                            (1100.0, 720.0)
                        }
                    } else {
                        (1100.0, 720.0)
                    }
                };

                let _ = window.unmaximize();
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: init_width,
                    height: init_height,
                }));
                let _ = window.center();

                // Belt-and-braces min-size clamp for Linux compositors that
                // don't enforce `xdg_toplevel.set_min_size` on CSD windows:
                // when the WM lets the user drag below the floor, we observe
                // the undersize via WindowEvent::Resized and snap the inner
                // size back up. On compliant platforms (Windows, X11, most
                // Wayland) this branch is a no-op because the WM already
                // prevents the undersize. We no longer persist window
                // geometry — the launcher always opens at the design minimum,
                // centered (see above).
                let win_for_events = window.clone();
                window.on_window_event(move |event| {
                    use tauri::WindowEvent;
                    match event {
                        WindowEvent::Destroyed | WindowEvent::CloseRequested { .. } => {
                            crate::util::platform::update_windows_estimated_size();
                        }
                        WindowEvent::Resized(_) => {
                            if let (Ok(scale), Ok(inner)) =
                                (win_for_events.scale_factor(), win_for_events.inner_size())
                            {
                                if inner.width > 0 && inner.height > 0 {
                                    let logical = inner.to_logical::<f64>(scale);
                                    if logical.width < MIN_WIDTH || logical.height < MIN_HEIGHT {
                                        let _ = win_for_events.set_size(tauri::Size::Logical(
                                            tauri::LogicalSize {
                                                width: logical.width.max(MIN_WIDTH),
                                                height: logical.height.max(MIN_HEIGHT),
                                            },
                                        ));
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }

            // Create system tray
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            let show = MenuItemBuilder::with_id("show", "Show Vermeil").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Vermeil")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            crate::util::platform::update_windows_estimated_size();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Apply initial theme icon across window (Taskbar, caption, Task Manager HWND),
            // tray icon, and OS shortcuts using the user's persisted theme.
            let initial_theme = tauri::async_runtime::block_on(async {
                crate::services::settings_service::load()
                    .await
                    .map(|s| s.theme)
                    .unwrap_or_else(|_| "neon-aurora".to_string())
            });
            let _ = crate::services::window_icon::apply_theme_icon(app.handle(), &initial_theme);

            // Keep Windows "Installed Apps" EstimatedSize in sync with true disk footprint (no-op on Linux)
            crate::util::platform::update_windows_estimated_size();

            // Reconcile Google Cloud settings & lifetime play time in background if connected
            crate::services::google_cloud::sync_on_startup(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App
            show_window,
            // Auth
            auth::start_ms_login,
            auth::get_active_account,
            auth::get_all_accounts,
            auth::set_active_account,
            auth::set_account_skin,
            auth::remove_account,
            auth::logout,
            // Instances
            instances::list_instances,
            instances::create_instance,
            instances::get_instance,
            instances::delete_instance,
            instances::delete_instances,
            instances::update_instance_memory,
            instances::update_instance_options,
            instances::rename_instance,
            instances::change_instance_loader,
            instances::set_instance_icon,
            instances::clear_instance_icon,
            instances::clone_instance,
            instances::cancel_install,
            instances::install_modpack,
            instances::install_cf_modpack,
            instances::import_mrpack,
            instances::prepare_instance,
            instances::set_ingame_cape,
            instances::set_ingame_cape_enabled,
            instances::set_instance_companion_enabled,
            instances::get_instance_companion_builds,
            instances::reinstall_instance_companion,
            instances::clear_ingame_cape,
            instances::get_ingame_cape,
            instances::companion_supported_versions,
            instances::ping_server,
            instances::get_quick_servers,
            instances::save_quick_server,
            instances::remove_quick_server,
            // CurseForge & Share Code import
            cf_import::import_cf_zip,
            cf_import::export_share_code,
            cf_import::preview_share_code,
            cf_import::import_share_code,
            // Launch
            launch::launch_instance,
            launch::install_mod_to_instance,
            launch::install_cf_mod_to_instance,
            launch::remove_mod_from_instance,
            launch::remove_mods_from_instance,
            launch::sync_instance_mods,
            launch::remove_all_content,
            launch::check_mod_updates,
            launch::apply_mod_update,
            launch::toggle_mod_in_instance,
            launch::get_instance_logs,
            launch::get_crash_report,
            launch::stop_instance,
            launch::minimize_to_tray,
            launch::current_log_target,
            launch::read_instance_log,
            launch::close_logs_window,
            launch::get_resolved_jvm_args,
            launch::get_preset_jvm_args,
            launch::get_known_preset_args,
            launch::get_effective_memory,
            // Meta
            meta::get_game_versions,
            meta::get_fabric_loader_versions,
            meta::get_fabric_game_versions,
            meta::get_quilt_loader_versions,
            meta::get_neoforge_versions,
            meta::get_neoforge_game_versions,
            meta::get_forge_versions,
            meta::get_forge_game_versions,
            meta::get_quilt_game_versions,
            meta::get_java_news,
            meta::get_article_body,
            // Mods
            mods::search_mods,
            mods::search_modpacks,
            mods::search_curseforge,
            mods::get_mod_versions,
            mods::get_cf_mod_files,
            mods::test_curseforge_key,
            mods::test_modrinth_token,
            mods::get_project_details,
            // Settings
            settings::get_settings,
            settings::save_settings,
            settings::get_app_directory,
            settings::open_app_directory,
            settings::get_cache_size,
            settings::purge_cache,
            settings::get_shared_game_data_size,
            settings::purge_shared_game_data,
            settings::get_system_memory,
            settings::load_download_history,
            settings::save_download_history,
            settings::set_theme_icon,
            settings::set_window_preset,
            // Cloud Sync
            cloud_sync::connect_google_cloud,
            cloud_sync::disconnect_google_cloud,
            cloud_sync::sign_out_google_cloud,
            cloud_sync::is_google_cloud_connected,
            cloud_sync::backup_to_google_cloud,
            cloud_sync::restore_from_google_cloud,
            cloud_sync::get_last_cloud_backup_time,
            cloud_sync::cancel_google_cloud,
            // Java location finder
            java::detect_java_installations,
            java::validate_java_path,
            java::set_java_path,
            java::install_recommended_java,
            java::delete_java_install,
            java::prune_invalid_java_paths,
            // Skins & capes
            skins::get_skin_profile,
            skins::upload_skin,
            skins::equip_local_skin,
            skins::reset_skin,
            skins::equip_cape,
            skins::unequip_cape,
            skins::list_local_skins,
            skins::add_local_skin,
            skins::remove_local_skin,
            skins::get_account_skin,
            skins::list_custom_capes,
            skins::save_custom_cape,
            skins::remove_custom_cape,
            skins::read_custom_cape_source,
            skins::sync_crafty_skins,
            // Files
            files::list_instance_files,
            files::list_instance_worlds,
            files::open_instance_folder,
            files::get_recent_screenshots,
            files::get_instances_storage_footprint,
            files::open_file_path,
            // Auto-updater
            app_updater::check_for_updates,
            app_updater::start_update_download,
            app_updater::apply_pending_update,
            app_updater::clear_pending_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
 
