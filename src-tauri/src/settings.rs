//! The settings file: `settings.json` in the OS config directory.
//!
//! Rust owns the FILE and nothing else. It does not know what a setting is, what
//! the valid keys are, or what any of them mean. It reads text, writes text
//! atomically, and tells the frontend when the file changed underneath it.
//!
//! That division is deliberate. The frontend edits the file with `jsonc-parser`
//! (the same library VS Code uses), which applies MINIMAL text edits: toggling a
//! checkbox rewrites one line and leaves your comments, your key order, and your
//! formatting exactly where they were. If Rust parsed the file into a struct and
//! serialised it back, every comment in it would be silently deleted the first
//! time the user clicked anything. Text in, text out.
//!
//! Settings live here. STATE does not: the open tabs, the recent files, the last
//! scroll position and the window geometry are not preferences, and writing them
//! here would rewrite the user's settings file every time they opened a document.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use tauri::{AppHandle, Emitter, Manager};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Default)]
pub struct SettingsState {
    /// The exact text we last wrote. Compared against what is on disk to tell our
    /// own echo apart from someone else's edit.
    last_written: Mutex<Option<String>>,
}

impl SettingsState {
    fn remember_our_write(&self, text: &str) {
        *self.last_written.lock().unwrap() = Some(text.to_string());
    }

    /// True when what is on disk is exactly what we last wrote, so there is nothing
    /// to tell the frontend: it already has this text, it is the one that sent it.
    ///
    /// This used to be a 600 ms window after our own write, which is a guess about
    /// timing rather than a fact about content, and it was wrong in both directions.
    /// A slow disk could deliver our echo late, past the window, and the app would
    /// reload while the user was typing. Worse, a user who saved settings.json from
    /// another editor 100 ms after the app wrote it landed inside the window and in
    /// the SAME debounced batch: their edit was dropped as our echo, the app never
    /// reloaded, and the next toggle wrote our stale text back over their change.
    ///
    /// Comparing content cannot make either mistake. If the bytes differ from what
    /// we wrote, someone else wrote them, however long ago that was.
    ///
    /// The memory is cleared on a MISMATCH, never on a match, and which of those two
    /// it is decides whether this function is correct.
    ///
    /// Peeking and never clearing was wrong: it quietly turned the question from "is
    /// this the echo of our last write?" into "is this any text this app has EVER
    /// written?". Write v1; the user edits the file by hand to v2; the user hits undo
    /// and saves, so the file is byte-identical to v1 again. That undo is a real
    /// external edit, and it matched the still-remembered v1, so it was swallowed: the
    /// app went on believing v2 and wrote v2 back over the file at the next click.
    ///
    /// TAKING the memory on a match is also wrong, and it is the more tempting mistake,
    /// because "an echo happens once" sounds obviously true. It is not. One settings
    /// write produces one debounced batch, but TWO writes inside the 250 ms window
    /// produce two batches, and by the time either is delivered both renames have
    /// landed, so both batches read the SAME final bytes. Taking the memory on the
    /// first would report the second as an external edit. Two toggles clicked in quick
    /// succession is not exotic; SettingsProvider's write queue exists precisely
    /// because it is the normal case. And the reload it would provoke is not free:
    /// `reload()` is the one write path not chained onto that queue, so a `set()`
    /// racing it can resync memory to the pre-edit text and then write that back.
    ///
    /// Clearing on a mismatch gets both. A burst of our own writes echoes as many times
    /// as it likes and every echo matches the one text we last wrote, so none of them
    /// reloads. The moment the bytes differ, someone else owns the file: we say so, and
    /// we forget what we wrote, so a later undo back to our text is correctly seen as
    /// theirs rather than as ours.
    fn is_echo_of_our_own_write(&self, on_disk: &str) -> bool {
        let mut last = self.last_written.lock().unwrap();
        if last.as_deref() == Some(on_disk) {
            // Still the text we put there. A burst can echo it more than once.
            true
        } else {
            // Someone else wrote this file. Forget ours, or their next undo back to it
            // would look like our echo and be swallowed.
            *last = None;
            false
        }
    }
}

fn settings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_dir(app)?.join(SETTINGS_FILE))
}

// Every command below is `#[tauri::command(async)]`, and the `(async)` is load-bearing.
// A plain `#[tauri::command]` on a NON-async fn is dispatched by tauri-macros straight
// onto the IPC/main thread, and these do blocking file I/O. `write_settings` in
// particular ends in an fsync, which is a full durability barrier: tens to hundreds of
// milliseconds on a busy, network-mounted or failing disk, with the window frozen for
// every one of them, on a path the user reaches by clicking a checkbox. `(async)` puts
// a sync fn on the blocking threadpool instead. history.rs says the same thing at
// greater length; this module is where the rule was missed.

/// Absolute path to settings.json, for "Reveal in Finder" and for showing the
/// user where their settings actually are.
#[tauri::command(async)]
pub fn get_settings_path(app: AppHandle) -> Result<String, String> {
    Ok(settings_file(&app)?.to_string_lossy().to_string())
}

/// The raw text of settings.json, or None when the file does not exist yet.
///
/// Returns TEXT, not a parsed object: the caller needs the comments and the
/// formatting, and a round trip through serde would throw both away.
#[tauri::command(async)]
pub fn read_settings(app: AppHandle) -> Result<Option<String>, String> {
    let path = settings_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Write settings.json atomically.
///
/// Write a sibling temp file, FSYNC IT, then rename it over the target. A rename
/// within a directory is atomic on every platform we ship, so a crash leaves the
/// OLD settings intact rather than a half-written file. The naive approach
/// (truncate, then write) has a window in which the user's settings are an empty
/// file, and that window is exactly when a crash is most likely.
///
/// The fsync is not optional and it is not belt-and-braces. Without it the rename
/// can reach the journal before the DATA blocks do, so a crash or a power loss
/// straight afterwards leaves settings.json present, renamed, and empty: precisely
/// the outcome the atomic write exists to prevent. save_file in commands.rs has
/// always done this, and says so; this function claimed the guarantee in its own
/// doc comment while skipping the step that provides it.
///
/// The temp file carries the process id so that two Dumont instances writing at
/// once cannot land on the same scratch path. Tauri happens to dispatch this
/// command synchronously today, which would make a fixed name safe, but that is a
/// property of the framework's dispatch policy and not something this function
/// should depend on to avoid corrupting a file.
#[tauri::command(async)]
pub fn write_settings(app: AppHandle, text: String) -> Result<(), String> {
    use std::io::Write;

    let dir = settings_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let target = dir.join(SETTINGS_FILE);
    let temp = dir.join(format!("{SETTINGS_FILE}.{}.tmp", std::process::id()));

    let write_and_sync = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&temp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    };
    if let Err(e) = write_and_sync() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not write {}: {e}", temp.display()));
    }

    // Remember the text BEFORE the rename: the watcher can fire while we are still
    // inside it, and it decides by comparing the file's content against this.
    app.state::<SettingsState>().remember_our_write(&text);

    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not replace {}: {e}", target.display()));
    }

    Ok(())
}

/// Watch settings.json and tell the frontend when someone else changes it, so an
/// edit made in another editor takes effect without a restart.
///
/// The directory is watched rather than the file: editors do not modify files in
/// place, they write a temp file and rename it over the target (the same trick
/// write_settings uses), which destroys the inode a file watch is bound to. Watch
/// the file and the first external save is the last event you ever receive.
pub fn watch_settings(app: &AppHandle) {
    let Ok(dir) = settings_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut debouncer) = new_debouncer(Duration::from_millis(250), None, tx) else {
            return;
        };
        if debouncer.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        for events in rx {
            let Ok(events) = events else { continue };
            let touched_settings = events.iter().any(|e| {
                e.paths
                    .iter()
                    .any(|p| p.file_name().is_some_and(|n| n == SETTINGS_FILE))
            });
            if !touched_settings {
                continue;
            }
            // Our own write echoing back. Reloading here would fight the user's
            // typing in the settings editor. Decided by reading the file and
            // comparing it with what we wrote: a clock cannot tell the difference
            // between our echo and a real edit that lands in the same batch.
            //
            // A file we cannot read is reported rather than swallowed. The frontend
            // is the half that can explain the problem to the user.
            let on_disk = std::fs::read_to_string(dir.join(SETTINGS_FILE));
            if let Ok(text) = &on_disk {
                if app.state::<SettingsState>().is_echo_of_our_own_write(text) {
                    continue;
                }
            }
            let _ = app.emit("settings-file-changed", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: &str = "{\n  \"editor.minimap\": true\n}\n";

    #[test]
    fn an_event_before_we_have_written_anything_is_external() {
        let state = SettingsState::default();
        assert!(
            !state.is_echo_of_our_own_write(OURS),
            "we have written nothing, so whatever is on disk came from somewhere else"
        );
    }

    #[test]
    fn the_echo_of_our_own_write_is_suppressed() {
        let state = SettingsState::default();
        state.remember_our_write(OURS);
        assert!(
            state.is_echo_of_our_own_write(OURS),
            "the file holds exactly what we put there, so there is nothing to reload"
        );
    }

    /// An echo is consumed, not remembered forever.
    ///
    /// The memory answers "is this the echo of our LAST write?", and a write echoes
    /// exactly once. Leaving it set turned the question into "is this any text this
    /// app has ever written?", which swallows a real edit that happens to restore an
    /// earlier state. The user's undo is precisely that edit.
    ///
    /// Walk it: we write v1 and suppress its echo. The user edits the file by hand to
    /// v2; we see v2, emit, and the frontend now holds v2. The user hits `u` in their
    /// editor and saves, so the file is byte-identical to v1 again. That is a real
    /// external edit and it MUST be reported. Under the old peek it matched the
    /// still-remembered v1 and was dropped, the app went on believing v2, and the next
    /// settings click wrote v2 straight back over the file.
    #[test]
    fn an_external_edit_that_restores_what_we_once_wrote_is_still_an_external_edit() {
        let state = SettingsState::default();

        // 1. We write v1 and see its echo.
        state.remember_our_write(OURS);
        assert!(state.is_echo_of_our_own_write(OURS), "our own echo, suppressed");

        // 2. The user edits the file by hand. Different bytes, so we report it.
        let theirs = "{\n  \"editor.minimap\": true,\n  \"appearance.theme\": \"paper\"\n}\n";
        assert!(!state.is_echo_of_our_own_write(theirs), "their edit, reported");

        // 3. The user undoes it. The file is byte-identical to v1, but WE did not
        //    write it this time: they did. It is an external edit like any other.
        assert!(
            !state.is_echo_of_our_own_write(OURS),
            "their undo restored bytes we once wrote, but we did not write them now; \
             swallowing this loses the undo and the next click reverts it"
        );
    }

    /// A burst of our own writes must not reload the app.
    ///
    /// One write is one debounced batch, but two writes inside the 250 ms window are
    /// TWO batches, and both are delivered after both renames have landed, so both read
    /// the same final bytes. An implementation that spends the memory on the first
    /// match reports the second as an external edit and reloads. Two settings toggles
    /// in quick succession is the ordinary case, not an exotic one, which is why
    /// SettingsProvider has a write queue at all.
    ///
    /// This is the test that rules out "take the memory on a match", which is the
    /// tempting fix for the undo bug above and trades it for this one.
    #[test]
    fn a_burst_of_our_own_writes_echoes_more_than_once_and_reloads_none_of_them() {
        let state = SettingsState::default();

        // Six toggles inside the debounce window. The last one wins on disk.
        for i in 0..6 {
            state.remember_our_write(&format!("{{\n  \"n\": {i}\n}}\n"));
        }
        let on_disk = "{\n  \"n\": 5\n}\n";

        // Every batch the debouncer delivers reads those same final bytes, and every
        // one of them is our own echo.
        for attempt in 1..=5 {
            assert!(
                state.is_echo_of_our_own_write(on_disk),
                "batch {attempt} carries the bytes we wrote; reloading here is spurious"
            );
        }
    }

    /// The bug the time window could not avoid.
    ///
    /// The app writes, and 100 ms later the user saves settings.json from another
    /// editor. Both land inside one debounced batch, well within any grace period.
    /// A clock says "that is our echo" and drops the event: the app never reloads,
    /// and the next toggle writes our stale text back over the user's edit. Content
    /// cannot make that mistake, however close together the two writes are.
    #[test]
    fn an_external_edit_landing_inside_the_old_grace_window_is_not_swallowed() {
        let state = SettingsState::default();
        state.remember_our_write(OURS);

        let theirs = "{\n  \"editor.minimap\": true,\n  \"appearance.theme\": \"paper\"\n}\n";
        assert!(
            !state.is_echo_of_our_own_write(theirs),
            "the bytes differ from what we wrote, so someone else wrote them"
        );
    }

    /// The other direction: a slow disk delivering our echo late.
    ///
    /// The old window expired after 600 ms, so an echo that arrived later was
    /// treated as an external edit and the app reloaded itself mid-typing. Content
    /// has no expiry.
    #[test]
    fn our_own_echo_is_still_recognized_however_late_it_arrives() {
        let state = SettingsState::default();
        state.remember_our_write(OURS);
        std::thread::sleep(Duration::from_millis(10));
        assert!(
            state.is_echo_of_our_own_write(OURS),
            "identical content is our echo whether it arrives in 1 ms or 10 seconds"
        );
    }
}
