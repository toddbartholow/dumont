// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

//! The native menu bar.
//!
//! The app had no menu at all, so macOS supplied the default one: an app menu and
//! a File menu whose only entry was Close Window. Every action the app can perform
//! was reachable only by keyboard shortcut or by a button, which is fine until you
//! are the person who does not know the shortcut and is looking in the menu for
//! Open.
//!
//! The menu does not IMPLEMENT anything. Each item emits its id to the frontend,
//! which routes it to the same handler the keyboard shortcut already calls. There
//! is one place that knows how to open a file, and it is not here.
//!
//! macOS only, and deliberately. The window is created with `decorations: false`
//! (the app draws its own title bar), and on Windows and Linux a menu belongs to
//! the window frame that is no longer there: it would not be shown, while its
//! accelerators would still be registered, so a shortcut could fire twice with no
//! menu anywhere to explain why. On macOS the menu bar belongs to the screen, not
//! to the window, so it shows up regardless.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Gated with the menu itself. There IS no menu off macOS (see install() below), so
// nothing but build_menu ever names these, and ungated they are unused imports on
// Windows and Linux: warnings, which CI promotes to errors with -D warnings. The
// three imports above stay ungated because install(), on_menu_event() and
// set_recent_files() are compiled everywhere and use them.
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::Wry;

/// One entry in Open Recent. Mirrors the frontend's RecentFile.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RecentItem {
    pub path: String,
    pub name: String,
}

/// The recents, so the menu can be rebuilt when they change.
///
/// The list itself lives in the frontend (it is session state, not settings), so
/// Rust is told about it rather than owning it.
#[derive(Default)]
pub struct MenuState {
    recents: Mutex<Vec<RecentItem>>,
}

/// How many recent files the menu shows. The palette shows all 25; a menu that
/// long is a scrolling list, not a menu.
#[cfg(target_os = "macos")]
const MENU_RECENTS: usize = 10;

/// The id a recent-file item carries. The path is appended, so the frontend knows
/// which file to open without a second round trip.
#[cfg(target_os = "macos")]
const RECENT_PREFIX: &str = "file.recent:";

#[cfg(target_os = "macos")]
pub fn build_menu(app: &AppHandle, recents: &[RecentItem]) -> tauri::Result<Menu<Wry>> {
    // The application menu. macOS puts About, Settings and Quit here, and users
    // look for them here, so Settings is NOT in the File menu.
    let app_menu = SubmenuBuilder::new(app, "Dumont")
        .about(Some(AboutMetadata {
            name: Some("Dumont".into()),
            ..Default::default()
        }))
        .separator()
        .item(
            &MenuItemBuilder::with_id("app.settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        // Hide keeps Cmd+H, which is the macOS convention and which users will hit
        // whether or not we offer it. The editor's replace ALSO wanted Mod-h, and a
        // menu key equivalent is matched before the key reaches the webview, so one
        // of them had to give. Replace moved to Option+Cmd+F, which is where VS Code
        // and every other mac editor put it. Ctrl+H still works on Windows and Linux,
        // where there is no menu to intercept it.
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let mut recent_menu = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        // A disabled placeholder rather than an empty submenu, which on macOS looks
        // like the menu failed to load.
        recent_menu = recent_menu.item(
            &MenuItemBuilder::with_id("file.recent.none", "No recent files")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for item in recents.iter().take(MENU_RECENTS) {
            recent_menu = recent_menu.item(
                &MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{}", item.path), &item.name)
                    .build(app)?,
            );
        }
        recent_menu = recent_menu.separator().item(
            &MenuItemBuilder::with_id("file.recent.clear", "Clear Menu").build(app)?,
        );
    }

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("file.new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&recent_menu.build()?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.saveAs", "Save As…")
                .accelerator("Shift+CmdOrCtrl+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.closeTab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .build()?;

    // Predefined, so the webview's own undo/redo/cut/copy/paste keep working: these
    // are handled by the OS text system, not by us, and rebinding them by hand is
    // how an editor ends up with a Paste that does not paste.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // NO Find item here, and it is not an oversight. A menu accelerator is matched
    // before the key ever reaches the webview, and the editor binds Mod-f (find),
    // Mod-b (bold), Mod-i (italic), Mod-h (replace) and Mod-k (link). Putting any of
    // those in a menu would take them away from the editor, silently, and the menu
    // would be the last place anyone looked. Find stays where it is: Ctrl+F in the
    // reader, and the editor's own keymap in the editor.

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view.toggleMode", "Toggle Reader / Editor")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.split", "Split View")
                .accelerator("CmdOrCtrl+\\")
                .build(app)?,
        )
        .separator()
        .item(
            // No accelerator: Cmd+B is the editor's bold. The app's own Ctrl+B still
            // works, through the keyboard handler, on every platform.
            &MenuItemBuilder::with_id("view.explorer", "File Explorer").build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.toc", "Table of Contents")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .item(
            // Shift is what keeps this one safe: Cmd+B is the editor's bold, and a
            // menu accelerator would take it. Cmd+Shift+B is bound to nothing.
            &MenuItemBuilder::with_id("view.backlinks", "Backlinks")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.history", "Version History")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(app)?,
        )
        .separator()
        .item(
            // No accelerator: Cmd+K is the editor's insert-link. Ctrl+K still opens it.
            &MenuItemBuilder::with_id("view.palette", "Command Palette…").build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;

    // No Close Window item. The predefined one carries Cmd+W, which File > Close Tab
    // already has, and AppKit gives the key to whichever menu comes first (File). The
    // result was a Window > Close Window showing a shortcut that could never reach
    // it: a menu item lying about its own key. Closing the window is the title bar's
    // job, and Cmd+W closes a tab, as it does in every editor with tabs.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help.shortcuts", "Keyboard Shortcuts").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

/// Install the menu. A failure here is not worth refusing to start over: the app
/// is fully usable from its own UI and its keyboard shortcuts.
///
/// THE CFG IS THE WHOLE POINT, and it belongs HERE rather than on the caller.
///
/// It used to sit only on the call in lib.rs's setup, which looked like enough and
/// was not: set_recent_files is registered on every platform, the frontend calls it
/// on mount and after every file open, and it calls install() directly. So the
/// second time a Windows user launched the app, with a recents list to send, the
/// menu installed itself: accelerators registered on a `decorations: false` window
/// with no menu bar to show them, firing alongside the webview's own handlers.
/// That is precisely the double-fire-with-no-visible-menu this module argues
/// against at the top, arrived at by walking around its own gate. A no-op on the
/// other platforms means no caller has to remember.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    let recents = app
        .state::<MenuState>()
        .recents
        .lock()
        .map(|r| r.clone())
        .unwrap_or_default();

    match build_menu(app, &recents) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                eprintln!("could not install the menu: {e}");
            }
        }
        Err(e) => eprintln!("could not build the menu: {e}"),
    }
}

/// Tell the frontend which item was chosen. It owns every action; see the note at
/// the top of this file.
pub fn on_menu_event(app: &AppHandle, id: &str) {
    let _ = app.emit("menu", id);
}

/// The frontend's recent-file list, so Open Recent can show it.
///
/// Rebuilds the menu, which is cheap and is the only way to change a submenu's
/// contents: menu items are immutable once built.
#[tauri::command]
pub fn set_recent_files(app: AppHandle, files: Vec<RecentItem>) -> Result<(), String> {
    {
        let state = app.state::<MenuState>();
        let mut recents = state.recents.lock().map_err(|e| e.to_string())?;
        // Nothing to redraw if the list has not actually changed. The frontend calls
        // this on every file open, and rebuilding the whole menu bar each time would
        // make the menu flicker shut if it happened to be open.
        if *recents == files {
            return Ok(());
        }
        *recents = files;
    }
    install(&app);
    Ok(())
}

impl PartialEq for RecentItem {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.name == other.name
    }
}
