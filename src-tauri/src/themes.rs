//! User themes: `<app config dir>/themes/<id>.json`.
//!
//! Rust owns the FILES and nothing else. It does not know what a theme is, what
//! a token means, or whether `--bg-primary` is a color or a sonnet. It lists
//! the directory, hands back raw TEXT, and says when something changed. That is
//! the same division settings.rs draws, for the same reason: the frontend parses
//! with `jsonc-parser` and has a linter that reports a bad theme in place, at the
//! line and column of the mistake. A serde round trip here could only replace
//! that with a worse error, or silently eat the user's comments.
//!
//! The FILENAME STEM is the theme's id. Not the `name` inside the JSON, which is
//! a human label and may be anything. That means the id is chosen by whoever can
//! write a file into the directory, so it is untrusted input: see
//! `sanitize_theme_id`.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Directory name, alongside settings.json rather than inside it: a theme is a
/// file the user swaps, mails to a friend, or drops in from a gist.
pub const THEMES_DIR: &str = "themes";

const THEME_EXTENSION: &str = "json";

/// Largest theme file we are willing to open.
///
/// A theme is a label, a base, and a flat map of CSS custom properties. The
/// built-ins are comfortably under 4 KiB, so 256 KiB is already absurd headroom.
/// The cap exists because the directory is a drop box: anyone who can put a file
/// in it can name it `evil.json` and make it 2 GB. Checked against the file's own
/// stat BEFORE the open, so that file costs us one lstat instead of two gigabytes
/// of resident memory.
const MAX_THEME_BYTES: u64 = 256 * 1024;

/// One theme file on disk. `text` is raw, unparsed and unvalidated, by contract.
#[derive(Debug, Serialize)]
pub struct ThemeFile {
    /// The filename stem, sanitized. `solarized-dark.json` -> `solarized-dark`.
    pub id: String,
    /// The file's contents verbatim, comments and all. The frontend parses it.
    pub text: String,
}

fn has_json_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(THEME_EXTENSION))
}

/// The theme id for a filename stem, or None when that stem cannot safely BE an
/// id.
///
/// This is a trust boundary, not a formality. The id crosses into the frontend,
/// which uses it as a theme key and hands it back to us; a stem that is `..`, or
/// that carries a separator, is a path fragment wearing an id's clothes. `read_dir`
/// will not itself produce a name containing `/` on any platform we ship, so the
/// check reads as paranoia right up until the day the id is round-tripped through
/// somewhere that joins it onto a path. Reject it at the door, once, here.
fn sanitize_theme_id(stem: &OsStr) -> Option<String> {
    // A non-UTF8 filename has no faithful representation as a JSON string.
    // Skip it rather than lossily transliterate it into an id that no longer
    // names the file it came from.
    let stem = stem.to_str()?;

    if stem.is_empty() || stem == "." || stem == ".." {
        return None;
    }
    // `..` anywhere, not merely alone: a theme id is a plain name, and refusing
    // the one substring that means "walk upwards" costs nothing anybody wanted.
    if stem.contains("..") {
        return None;
    }
    // Both separators on every platform. Windows accepts `/` as well as `\`, and
    // a file written on one OS is read on another.
    if stem.contains('/') || stem.contains('\\') {
        return None;
    }
    // NUL truncates C strings; the rest corrupt any log line or menu label the
    // id is later drawn into.
    if stem.chars().any(char::is_control) {
        return None;
    }

    Some(stem.to_string())
}

/// Whether a directory entry is worth OPENING, judged entirely from its lstat.
///
/// Both halves of this must be decided before the open, which is why it is one
/// predicate over `symlink_metadata` rather than two checks scattered through the
/// read:
///
///   * `is_file()` on an lstat is false for a symlink (metadata() would follow it)
///     and false for a directory, so neither can be opened as a theme.
///   * the size cap here means an oversized file is never opened AT ALL. The
///     bounded read in read_theme_file also catches it, but only by opening the
///     file first and truncating afterwards, which is a worse answer for a 2 GB
///     `evil.json` and no answer at all for the syscall it already paid for.
fn is_openable_theme(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_file() && meta.len() <= MAX_THEME_BYTES
}

/// Read one theme file, or None when it must be skipped.
///
/// Skipping is the entire point of the signature. One unreadable, oversized or
/// hostile file in the directory must not stop the OTHER themes loading, and must
/// certainly not stop the app starting: this runs on the startup path. So every
/// failure in here is a `None` and never an `Err`, and the caller keeps going.
fn read_theme_file(path: &Path) -> Option<ThemeFile> {
    if !has_json_extension(path) {
        return None;
    }
    let id = sanitize_theme_id(path.file_stem()?)?;

    // symlink_metadata, NOT metadata. metadata FOLLOWS the link, so a symlink
    // named `pretty.json` pointing at ~/.ssh/id_rsa would stat as an ordinary
    // small regular file, be read, and be handed to the frontend as a theme.
    // lstat reports the link AS a link, so is_openable_theme drops it and a
    // symlink cannot read its way out of the themes directory.
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !is_openable_theme(&meta) {
        return None;
    }

    // Bounded read even though the size was already gated above. That stat
    // describes a moment now in the past, and a file that grows between the two is
    // a race we would rather lose cheaply than try to win: `take` caps what we can
    // be made to allocate no matter what the file does afterwards. One byte past
    // the cap, so "exactly at the cap" stays distinguishable from "over it".
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    // Invalid UTF-8 lands here as an Err, and is skipped like any other bad file.
    file.take(MAX_THEME_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_THEME_BYTES {
        return None;
    }

    Some(ThemeFile { id, text })
}

/// Every readable theme in a directory. Unreadable ones are simply absent.
fn read_themes_from(dir: &Path) -> Vec<ThemeFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // No directory, or no permission to list it. Neither is an error the user
        // needs a dialog about: it means there are no user themes, and the app
        // runs on its built-ins.
        return Vec::new();
    };

    let mut themes: Vec<ThemeFile> = entries
        .flatten()
        .filter_map(|entry| read_theme_file(&entry.path()))
        .collect();

    // read_dir yields whatever order the filesystem feels like, which differs
    // between platforms and changes as files are added. Sort, or the user's theme
    // list reshuffles itself every time one of them is edited.
    themes.sort_by(|a, b| a.id.cmp(&b.id));
    themes
}

/// Path to the themes directory, creating it if it is not there.
///
/// Creation is deliberately part of the lookup rather than a separate step: the
/// path is mostly wanted so the UI can reveal the directory in Finder or Explorer,
/// and revealing a directory that does not exist yet fails in a way the user can
/// do nothing about. Making it here means the first click always lands somewhere.
fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?
        .join(THEMES_DIR);

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    Ok(dir)
}

/// Absolute path to the themes directory, for "Reveal in Finder" and for telling
/// the user where to put a theme.
#[tauri::command(async)]
pub fn get_themes_dir(app: AppHandle) -> Result<String, String> {
    Ok(themes_dir(&app)?.to_string_lossy().to_string())
}

/// Every user theme, as raw text keyed by filename stem.
///
/// Never fails. A missing directory, a directory we cannot create, a directory we
/// cannot list: all of them mean "this user has no themes", and the honest answer
/// to that is an empty list, not a modal on startup blocking a user who never
/// asked for a custom theme in the first place. The `Result` is kept because it is
/// the shape of the frontend's contract, and because a future failure here might
/// genuinely be worth reporting.
#[tauri::command(async)]
pub fn read_themes(app: AppHandle) -> Result<Vec<ThemeFile>, String> {
    let Ok(dir) = themes_dir(&app) else {
        return Ok(Vec::new());
    };
    Ok(read_themes_from(&dir))
}

/// Watch the themes directory, so a theme edited in an external editor repaints
/// the app instead of waiting for a restart.
///
/// The DIRECTORY is watched, not the individual theme files, for the reason
/// watch_settings spells out (an editor's atomic save renames a temp file over the
/// target, which replaces the inode a file watch is bound to, so a file watch goes
/// deaf after the first save) and for one more that is specific to themes: adding
/// a NEW theme is itself the event we most need to see, and no watch on an
/// existing file could ever deliver it.
///
/// Unlike settings there is no self-write grace window here, and there should not
/// be one: Rust never writes a theme file, so no event we receive is ever the echo
/// of our own write.
///
/// One known edge, shared with watch_settings: deleting the watched directory
/// itself (as opposed to files in it) ends the watch until the next launch.
/// Deleting your own config directory out from under a running app is not a case
/// worth a recursive watch on the parent.
pub fn watch_themes(app: &AppHandle) {
    // Creates the directory if absent, and returns early if it cannot be made.
    // A watcher that cannot start is not fatal: read_themes yields an empty list
    // and the app runs on its built-in themes.
    let Ok(dir) = themes_dir(app) else { return };

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

            // Editors litter the directory they are saving into: `.theme.json.swp`,
            // `theme.json~`, `4913`, atomic-save temp files. Only a path that is
            // itself a theme file is worth a reload, or every keystroke in vim
            // would repaint the app. A create, a modify, a delete and both halves
            // of a rename all carry the path, so this still sees all four.
            let touched_theme = events
                .iter()
                .any(|event| event.paths.iter().any(|path| has_json_extension(path)));
            if !touched_theme {
                continue;
            }

            let _ = app.emit("themes-changed", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scratch directory that deletes itself, so a failing assert cannot leave
    /// litter behind for the next run to trip over.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "dumont-themes-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, name: &str, contents: &str) {
            std::fs::write(self.0.join(name), contents).expect("write fixture");
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ids(themes: &[ThemeFile]) -> Vec<&str> {
        themes.iter().map(|t| t.id.as_str()).collect()
    }

    const GOOD: &str = r#"{"name":"Solarized Dark","type":"dark","tokens":{}}"#;

    #[test]
    fn theme_id_is_the_filename_stem() {
        assert_eq!(
            sanitize_theme_id(OsStr::new("solarized-dark")),
            Some("solarized-dark".to_string())
        );
        assert_eq!(
            sanitize_theme_id(OsStr::new("My Theme 2")),
            Some("My Theme 2".to_string())
        );
    }

    #[test]
    fn theme_id_rejects_traversal_separators_and_control_characters() {
        // The id crosses into the frontend and comes back. None of these may.
        for hostile in [
            "",
            ".",
            "..",
            "../evil",
            "../../etc/passwd",
            "..\\..\\windows\\system32",
            "themes/../../secret",
            "a/b",
            "a\\b",
            "..hidden",
            "trailing..",
            "nul\0byte",
            "newline\nid",
        ] {
            assert_eq!(
                sanitize_theme_id(OsStr::new(hostile)),
                None,
                "{hostile:?} must never become a theme id"
            );
        }
    }

    #[test]
    fn a_traversing_filename_never_reaches_the_frontend() {
        let dir = TempDir::new();
        dir.write("good.json", GOOD);
        // `..json` has file_stem() == "." (the name begins with a dot AND has
        // another dot in it, so the normal split applies). A stem of "." is exactly
        // what sanitize_theme_id exists to refuse.
        dir.write("..json", GOOD);

        let themes = read_themes_from(dir.path());
        assert_eq!(
            ids(&themes),
            vec!["good"],
            "only the plainly named theme may load"
        );
    }

    #[test]
    fn one_unreadable_file_does_not_stop_the_others_loading() {
        let dir = TempDir::new();
        dir.write("alpha.json", GOOD);
        // Invalid UTF-8: read_to_string fails on it. It must be skipped, not
        // poison the whole directory, or a single corrupt byte in one theme would
        // cost the user every other theme they have.
        std::fs::write(dir.path().join("corrupt.json"), [0xff, 0xfe, 0x00, 0x01])
            .expect("write fixture");
        dir.write("zeta.json", GOOD);

        let themes = read_themes_from(dir.path());
        assert_eq!(ids(&themes), vec!["alpha", "zeta"]);
    }

    #[test]
    fn oversized_files_are_skipped_and_the_cap_itself_is_not() {
        let dir = TempDir::new();
        dir.write("small.json", GOOD);
        dir.write(
            "at-the-cap.json",
            &"a".repeat(usize::try_from(MAX_THEME_BYTES).unwrap()),
        );
        dir.write(
            "over-the-cap.json",
            &"a".repeat(usize::try_from(MAX_THEME_BYTES).unwrap() + 1),
        );

        let themes = read_themes_from(dir.path());
        assert_eq!(
            ids(&themes),
            vec!["at-the-cap", "small"],
            "a file one byte over the cap must never be opened, one byte under must load"
        );
    }

    /// The size cap has to be decided from the STAT, before the open. The bounded
    /// read in read_theme_file backstops it, which is exactly why the end-to-end
    /// test above cannot prove this: with the stat gate deleted, that test still
    /// passes, because the read gets truncated instead. So assert the pre-open
    /// decision where it is actually made.
    ///
    /// The fixture is a genuine 2 GB `evil.json`, made sparse (`set_len` allocates
    /// no blocks), so the test asserts on the real thing at the cost of an inode.
    #[test]
    fn a_two_gigabyte_theme_is_rejected_from_its_stat_alone() {
        let dir = TempDir::new();
        let evil = dir.path().join("evil.json");
        let file = std::fs::File::create(&evil).expect("create fixture");
        file.set_len(2 * 1024 * 1024 * 1024).expect("sparse 2 GB");
        drop(file);

        let meta = std::fs::symlink_metadata(&evil).expect("lstat fixture");
        assert_eq!(meta.len(), 2 * 1024 * 1024 * 1024, "the fixture really is 2 GB");
        assert!(
            !is_openable_theme(&meta),
            "a 2 GB file must be refused from its stat, so it is never opened at all"
        );

        // And it does not reach the frontend either way.
        assert!(read_themes_from(dir.path()).is_empty());
    }

    #[test]
    fn the_openable_gate_accepts_an_ordinary_theme() {
        let dir = TempDir::new();
        dir.write("real.json", GOOD);

        let meta = std::fs::symlink_metadata(dir.path().join("real.json")).expect("lstat");
        assert!(
            is_openable_theme(&meta),
            "an ordinary small regular file is exactly what we do want to open"
        );
    }

    #[test]
    fn directories_and_non_json_files_are_skipped() {
        let dir = TempDir::new();
        dir.write("real.json", GOOD);
        dir.write("notes.md", "not a theme");
        dir.write("theme.json.swp", "an editor's leavings");
        // A DIRECTORY named like a theme. symlink_metadata's is_file() gate drops
        // it; without that gate, read_to_string would fail anyway, but only after
        // we had opened it.
        std::fs::create_dir(dir.path().join("nested.json")).expect("create fixture dir");

        let themes = read_themes_from(dir.path());
        assert_eq!(ids(&themes), vec!["real"]);
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_cannot_read_its_way_out_of_the_themes_directory() {
        let outside = TempDir::new();
        std::fs::write(outside.path().join("secret"), "sensitive").expect("write fixture");

        let dir = TempDir::new();
        dir.write("real.json", GOOD);
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("stolen.json"))
            .expect("create symlink");

        let themes = read_themes_from(dir.path());
        assert_eq!(
            ids(&themes),
            vec!["real"],
            "a symlink stats as a link under lstat, so it is not a regular file and is skipped"
        );
    }

    #[test]
    fn text_is_handed_over_raw_and_unvalidated() {
        let dir = TempDir::new();
        // Not valid JSON. Rust does not care: the frontend's linter reports the
        // error in place, at the line and column. Validating here would only let
        // us throw the file away with a worse message.
        dir.write("broken.json", "{ this is not json, // and has a comment");

        let themes = read_themes_from(dir.path());
        assert_eq!(ids(&themes), vec!["broken"]);
        assert_eq!(
            themes[0].text, "{ this is not json, // and has a comment",
            "the bytes must arrive byte for byte, comments included"
        );
    }

    #[test]
    fn a_missing_directory_is_an_empty_list_not_an_error() {
        let dir = TempDir::new();
        let absent = dir.path().join("does-not-exist");

        assert!(
            read_themes_from(&absent).is_empty(),
            "no themes directory means no user themes, so the app starts on its built-ins"
        );
    }
}
