// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

mod ai;
mod commands;
mod history;
mod menu;
mod pdf;
mod settings;
mod themes;

use commands::{read_file, save_file, get_file_info, list_directory_files, search_files, find_backlinks, save_image, read_image_file, ai_key_present, set_ai_key};
use tauri::{Manager, Emitter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The file the OS asked us to open, and whether the frontend is up yet.
///
/// Two delivery routes have to converge here, because the platforms disagree:
///   * Windows / Linux pass the path in argv — either to this process, or to a
///     second launch that the single-instance plugin forwards to us.
///   * macOS passes it in NEITHER. Finder sends an Apple Event, which Tauri
///     surfaces as `RunEvent::Opened`, and it does so whether or not the app is
///     already running (it never spawns a second process for a document open).
///
/// `ready` decides which way the paths travel. Before the webview has booted,
/// there is no listener, so we park them in `paths` for the frontend to pull.
/// Afterwards the pull already happened, so we push an event per file instead.
///
/// `paths` is a QUEUE, not a single slot, because Finder or Explorer can hand us
/// several documents in one launch: select three `.md` files and press Enter from
/// cold, and each arrives as its own delivery before the frontend's first pull. A
/// single `Option` slot kept only the last and dropped the rest.
#[derive(Default)]
struct LaunchFile {
    paths: Mutex<Vec<String>>,
    ready: AtomicBool,
}

fn is_markdown(path: &str) -> bool {
    // One definition, shared with the explorer, search and the backlink scan. This
    // used to be its own case-SENSITIVE `ends_with(".md")`, which is why double-
    // clicking `NOTES.MD` in Finder raised the window and then did nothing: macOS and
    // Windows match file associations case-insensitively, so the OS handed us the file
    // and we said it was not markdown.
    commands::is_markdown_path(std::path::Path::new(path))
}

/// Every markdown path among the process arguments (skipping argv[0]), in order.
///
/// All of them, not just the first: opening several files at once is one launch
/// carrying several paths, and taking only the first is how the rest were lost.
fn md_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| is_markdown(a))
        .cloned()
        .collect()
}

/// Hand freshly opened paths to the frontend, or hold them until the frontend
/// exists. Used by both the single-instance (argv) and macOS (Apple Event) routes.
fn deliver_launch_files(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    let state = app.state::<LaunchFile>();
    if state.ready.load(Ordering::SeqCst) {
        // The webview has already pulled once; it is listening now. One event per
        // file, so the frontend opens each as its own tab.
        for path in paths {
            let _ = app.emit("file-open-from-cli", path);
        }
    } else {
        // Too early for a listener: queue them for the frontend's boot-time pull.
        state.paths.lock().unwrap().extend(paths);
    }
}

/// PULL model for the OS-opened file. The old design pushed an event after a
/// fixed 500 ms sleep, which raced the webview: on slow cold starts the event
/// fired before the JS listener existed and was silently lost, so the
/// last-session restore won and the app showed the previous file instead of
/// the one the user double-clicked. Now the frontend asks for the path when
/// it is actually ready, before deciding whether to restore the last session.
/// Draining the queue (rather than cloning it) so a webview reload doesn't
/// re-open the same files.
///
/// Calling this also marks the frontend live, so any later OS open is pushed
/// as an event rather than parked for a pull that will never come.
#[tauri::command]
fn get_cli_files(state: tauri::State<LaunchFile>) -> Vec<String> {
    state.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *state.paths.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_files = md_args(&std::env::args().collect::<Vec<_>>());

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Must be the first plugin so it wins the instance lock race.
        // A second launch (double-clicking another .md while Dumont runs)
        // forwards its argv here and exits; we surface the window and hand
        // the path to the existing frontend listener. This is the Windows /
        // Linux route — macOS never gets here for a document open (see the
        // RunEvent::Opened handler at the bottom).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = md_args(&argv);
            if !paths.is_empty() {
                deliver_launch_files(app, paths);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    // Remember the window's size, position and maximized state between launches.
    // Without this every launch reset the window to the 1000x700 in
    // tauri.conf.json and re-centered it, so a resized window had to be resized
    // again every single time.
    //
    // It has to be registered HERE, on the builder, not inside setup(): setup()
    // runs after the main window already exists, so the plugin never sees it get
    // created, never hooks it, and writes an empty state file.
    //
    // The flags are listed explicitly rather than taking the default of "all",
    // because two of them would break this app:
    //   * DECORATIONS — the window is `decorations: false` and draws its own
    //     titlebar. Restoring native decorations would give it two.
    //   * VISIBLE — the window is created hidden on purpose, and the webview's
    //     white pre-paint surface only stays off screen because the frontend
    //     reveals it once it has painted (#98). Restoring visibility from the
    //     saved state would put that flash straight back.
    #[cfg(desktop)]
    {
        use tauri_plugin_window_state::StateFlags;
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        );
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Updater (GitHub latest.json) + process (relaunch after install)
            // are desktop-only plugins, hence registered here behind cfg
            // instead of in the unconditional plugin chain above.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            // UI-automation bridge for the Tauri MCP server. Debug builds
            // only; bound to localhost so nothing on the network can drive
            // the app.
            // Watch settings.json so an external edit applies without a restart.
            settings::watch_settings(app.handle());
            // Same for the themes directory: a theme edited in another editor, or
            // a new one dropped in, repaints the app rather than waiting for a
            // relaunch. Both watchers fail soft; neither can stop the app booting.
            themes::watch_themes(app.handle());

            // One-time housekeeping for the version-history store: reclaim
            // snapshots stranded by a renamed or deleted note, adopt any snapshot
            // a crash left uncommitted, and delete the temp file an interrupted
            // write leaves behind. Nothing else ever enumerates the store's root,
            // so without this it only grows. Off the main thread and fail-soft: it
            // must never delay or block boot.
            if let Ok(data_root) = app.path().app_data_dir() {
                // The sweep is a second writer to the store; it takes the same
                // StoreLock the history commands do, so it cannot interleave with a
                // save the frontend fires seconds into the session.
                let store_lock = app.state::<history::StoreLock>().inner().clone();
                std::thread::spawn(move || history::sweep_history_in(&data_root, &store_lock));
            }

            // The native menu bar. macOS only: this window has no decorations, so on
            // Windows and Linux there is no frame to hang a menu on, and registering
            // its accelerators there would let a shortcut fire twice with no visible
            // menu to explain it. See src/menu.rs.
            #[cfg(target_os = "macos")]
            menu::install(app.handle());

            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_mcp_bridge::Builder::new()
                        .bind_address("127.0.0.1")
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(LaunchFile {
            paths: Mutex::new(cli_files),
            ready: AtomicBool::new(false),
        })
        .manage(history::StoreLock::default())
        .manage(ai::AiCancel::default())
        .manage(settings::SettingsState::default())
        .manage(menu::MenuState::default())
        .on_menu_event(|app, event| {
            // Every action lives in the frontend, next to the keyboard shortcut that
            // already does the same thing. The menu only says which one.
            menu::on_menu_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            save_file,
            get_file_info,
            list_directory_files,
            search_files,
            find_backlinks,
            save_image,
            read_image_file,
            ai_key_present,
            set_ai_key,
            get_cli_files,
            menu::set_recent_files,
            settings::read_settings,
            settings::write_settings,
            settings::get_settings_path,
            themes::read_themes,
            themes::get_themes_dir,
            history::snapshot_file,
            history::list_snapshots,
            history::read_snapshot,
            history::clear_history,
            pdf::export_pdf,
            ai::ai_request,
            ai::ai_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS hands a double-clicked document to the ALREADY-RUNNING app as
            // an Apple Event, not as argv and not as a second process — so neither
            // the argv scan nor the single-instance plugin ever sees it. Without
            // this arm, double-clicking a .md in Finder raised the window and did
            // nothing else, while drag-drop and File > Open worked fine.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                // Every markdown document in the event, not just the first:
                // selecting several files in Finder and pressing Enter delivers
                // them all here at once, and taking only the first is how the rest
                // were dropped.
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().to_string())
                    .filter(|path| is_markdown(path))
                    .collect();
                deliver_launch_files(_app, paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::md_args;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn md_args_skips_argv0_and_finds_markdown() {
        assert_eq!(md_args(&v(&["dumont.exe", "C:\\notes\\a.md"])), v(&["C:\\notes\\a.md"]));
        assert_eq!(md_args(&v(&["dumont.exe", "C:\\notes\\b.markdown"])), v(&["C:\\notes\\b.markdown"]));
    }

    #[test]
    fn md_args_ignores_non_markdown_and_flags() {
        assert!(md_args(&v(&["dumont.exe"])).is_empty());
        assert!(md_args(&v(&["dumont.exe", "--flag", "notes.txt"])).is_empty());
        // argv[0] itself never matches, even if the exe path looked like markdown.
        assert!(md_args(&v(&["weird.md"])).is_empty());
    }

    #[test]
    fn md_args_takes_every_markdown_among_args_in_order() {
        assert_eq!(
            md_args(&v(&["dumont.exe", "--verbose", "x.md", "notes.txt", "y.md"])),
            v(&["x.md", "y.md"])
        );
    }
}
