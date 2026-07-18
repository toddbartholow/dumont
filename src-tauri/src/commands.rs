use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Response;
use thiserror::Error;

/// Makes every `save_file` temp path unique, even for the same document in the same
/// process. See `save_file`; without it, two saves of one document race each other
/// through a single temp file and publish a splice of both over the user's document.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Hard ceiling on text-file content. 50 MB easily covers any sane markdown
/// document while keeping a single careless `read_file` from holding hundreds
/// of MB of UTF-8 in webview memory. Above this we fail fast with a clear
/// error so the user sees a toast instead of a frozen editor.
const MAX_TEXT_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Hard ceiling on a pasted image. Markdown editors get pasted screenshots
/// regularly; 25 MB is generous (a 4K PNG screenshot is ~5–10 MB) but blocks a
/// runaway clipboard payload from filling the user's disk.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Whitelist of allowed image extensions for `save_image`. Anything else is
/// refused — prevents a malicious caller from writing an arbitrary `.exe` /
/// `.dll` / `.lnk` into the user's documents folder under the cover of an
/// image-paste flow.
const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

/// Error type for file operation commands
#[derive(Debug, Error)]
pub enum CommandError {
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Failed to read file: {0}")]
    ReadError(String),
    #[error("Failed to write file: {0}")]
    WriteError(String),
    #[error("File too large: {0}")]
    TooLarge(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// File metadata returned when opening a file
#[derive(Debug, Serialize, Deserialize)]
pub struct FileData {
    pub path: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    pub line_count: usize,
    /// Last-modified time, ms since the Unix epoch. Lets the frontend detect
    /// external edits (file changed on disk while open) on window focus.
    pub modified: u64,
}

/// Line-ending convention of a file.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Eol {
    Lf,
    Crlf,
}

/// Detect a file's dominant line ending by reading just its first chunk and
/// inspecting the first newline. `\r\n` → Crlf, a bare `\n` → Lf, and a file with
/// no newline at all (or that can't be read) falls back to Lf. Cheap: we never
/// read more than the first 64 KB regardless of file size. EOL-01.
async fn detect_file_eol(path: &str) -> Eol {
    use tokio::io::AsyncReadExt;
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Eol::Lf,
    };
    let mut buf = vec![0u8; 64 * 1024];
    let n = match file.read(&mut buf).await {
        Ok(n) => n,
        Err(_) => return Eol::Lf,
    };
    for i in 0..n {
        if buf[i] == b'\n' {
            return if i > 0 && buf[i - 1] == b'\r' {
                Eol::Crlf
            } else {
                Eol::Lf
            };
        }
    }
    Eol::Lf
}

/// Re-apply a file's line ending to editor content (which CodeMirror always
/// normalizes to `\n`). We first collapse any stray `\r\n`/`\r` to `\n` so a
/// CRLF target can't produce `\r\r\n`. EOL-01.
fn apply_eol(content: &str, eol: Eol) -> String {
    if eol == Eol::Lf && !content.contains('\r') {
        return content.to_string();
    }
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    match eol {
        Eol::Lf => normalized,
        Eol::Crlf => normalized.replace('\n', "\r\n"),
    }
}

/// Last-modified time in ms since the Unix epoch (0 when unavailable).
fn mtime_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Is this a markdown file, as far as every part of the app is concerned?
///
/// ONE definition, deliberately, because there were four and they had drifted. The
/// file explorer, cross-file search, the backlink scan and the OS file-open handler
/// each spelled out `ext == "md" || ext == "markdown"` for themselves, and every one
/// of them was case-SENSITIVE while `themes.rs` next door used
/// `eq_ignore_ascii_case`. That is the tell that it was drift rather than intent.
///
/// The case matters in practice. macOS and Windows both match file associations
/// case-insensitively, so the OS really does hand `README.MD` to Dumont, and
/// `is_markdown` then said no: double-clicking it raised the window and did nothing.
/// The same file was missing from the explorer, from search, and from backlinks. It
/// could still be opened through File > Open, because `read_file` checks no
/// extension at all, so the app would happily open a file it refused to list.
///
/// Deliberately NOT including `.txt`: it is openable (the File > Open dialog and the
/// drag-drop handler both accept it) but it is not markdown, and the discovery
/// surfaces here are markdown-vault features. `search_finds_matches_recursively...`
/// pins that exclusion on purpose.
pub fn is_markdown_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// Read a markdown file from disk
#[tauri::command]
pub async fn read_file(path: String) -> Result<FileData, CommandError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(CommandError::FileNotFound(path));
    }

    // Stat first so we can refuse oversized files before pulling them into
    // memory. Without this, opening a multi-GB log accidentally renamed `.md`
    // would freeze the UI thread for tens of seconds.
    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::TooLarge(format!(
            "File is {} MB; maximum is {} MB",
            metadata.len() / (1024 * 1024),
            MAX_TEXT_FILE_BYTES / (1024 * 1024),
        )));
    }

    let raw = tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;

    // Hand the frontend LF-only content. CodeMirror normalizes every line
    // break to `\n` anyway, so serving CRLF verbatim made the editor's first
    // doc-sync "change" the text and mark a freshly opened file dirty. The
    // on-disk convention is not lost: `save_file` re-detects it from the file
    // itself and writes CRLF back. EOL-01.
    let content = apply_eol(&raw, Eol::Lf);

    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    let line_count = content.lines().count();

    Ok(FileData {
        path,
        name,
        content,
        size: metadata.len(),
        line_count,
        modified: mtime_ms(&metadata),
    })
}

/// Save content to a file. Returns the new last-modified time (ms since epoch)
/// so the frontend can track external changes without a second stat call.
///
/// The write is ATOMIC: content goes to a temp file in the same directory,
/// which is then renamed over the target. A crash or power loss mid-write can
/// no longer truncate the user's document — the worst case is a leftover
/// `.dumont-tmp` file. (std/tokio rename replaces the target on Windows
/// via MoveFileEx + MOVEFILE_REPLACE_EXISTING, and is atomic on POSIX.)
#[tauri::command]
pub async fn save_file(path: String, content: String) -> Result<u64, CommandError> {
    // Mirror the read-side limit. Refusing to write a >50 MB markdown file
    // protects the user from accidentally truncating something pasted from
    // another tool, and matches what `read_file` would refuse to load back.
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::TooLarge(format!(
            "Document is {} MB; maximum is {} MB",
            content.len() / (1024 * 1024),
            MAX_TEXT_FILE_BYTES / (1024 * 1024),
        )));
    }

    // Preserve the on-disk file's line ending. The editor hands us `\n`-only
    // content; if the existing file uses CRLF we write CRLF back, so opening and
    // saving a Windows file doesn't rewrite every line and produce a noisy diff.
    // A brand-new file (save-as / new note) has no existing EOL, so we keep the
    // editor's LF. EOL-01.
    let file_exists = PathBuf::from(&path).exists();
    let content = if file_exists {
        apply_eol(&content, detect_file_eol(&path).await)
    } else {
        content
    };

    // Same directory as the target so the rename never crosses a filesystem
    // boundary (cross-device renames aren't atomic and can fail outright).
    //
    // The trailing counter is what makes this temp path unique PER CALL, and it is
    // load-bearing. `save_file` is async, so Tauri dispatches two of them
    // concurrently, and two saves of the SAME document are not exotic: autosave arms
    // its timer on the last keystroke and Ctrl+S does not change `content`, so the
    // timer is never cleared and both saves end up in flight. Two quick Ctrl+S presses
    // do it too. Keyed on the path and the pid alone, both writers would open the same
    // temp file; `File::create` truncates, so one would truncate the other mid-write,
    // they would interleave at their own offsets, and the first to rename would publish
    // a SPLICE OF BOTH over the user's document while the other reported a save error
    // for a file it had just helped destroy. Pinned by
    // `two_concurrent_saves_of_one_document_do_not_corrupt_it`.
    let tmp = format!(
        "{}.{}.{}.dumont-tmp",
        path,
        std::process::id(),
        SAVE_SEQ.fetch_add(1, Ordering::Relaxed)
    );

    // Write, then fsync BEFORE the rename. Without the sync, a crash right after
    // the rename can leave the (renamed) file present but empty/partial on disk,
    // because the directory entry can reach disk before the data does. An editor
    // whose whole job is not losing words should pay this cost. SAVE-02.
    {
        use tokio::io::AsyncWriteExt;
        let mut f = match tokio::fs::File::create(&tmp).await {
            Ok(f) => f,
            Err(e) => return Err(CommandError::WriteError(e.to_string())),
        };
        if let Err(e) = f.write_all(content.as_bytes()).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(CommandError::WriteError(e.to_string()));
        }
        if let Err(e) = f.sync_all().await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(CommandError::WriteError(e.to_string()));
        }
    }

    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        // Don't leave the temp file behind on failure.
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(CommandError::WriteError(e.to_string()));
    }

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;
    Ok(mtime_ms(&metadata))
}

/// Get just the file info without content (for status bar)
#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileInfo, CommandError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(CommandError::FileNotFound(path));
    }

    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;

    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    Ok(FileInfo {
        path,
        name,
        size: metadata.len(),
        modified: mtime_ms(&metadata),
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Last-modified time, ms since the Unix epoch.
    pub modified: u64,
}

/// File entry for directory listing
#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List all markdown files in a directory
#[tauri::command]
pub async fn list_directory_files(directory: String) -> Result<Vec<FileEntry>, CommandError> {
    let dir_path = PathBuf::from(&directory);

    if !dir_path.exists() {
        return Err(CommandError::FileNotFound(directory));
    }

    if !dir_path.is_dir() {
        return Err(CommandError::ReadError(
            "Path is not a directory".to_string(),
        ));
    }

    let mut entries = Vec::new();

    let mut read_dir = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?
    {
        let path = entry.path();

        let entry_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        // Skip hidden files and directories (starting with a dot)
        if entry_name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            // Add directories
            entries.push(FileEntry {
                name: entry_name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
            });
        } else if path.is_file() {
            // Only include markdown files, case-insensitively. See is_markdown_path.
            {
                if is_markdown_path(&path) {
                    entries.push(FileEntry {
                        name: entry_name,
                        path: path.to_string_lossy().to_string(),
                        is_dir: false,
                    });
                }
            }
        }
    }

    // Sort: Directories first, then alphabetically case-insensitive
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// A single matching line within a file.
#[derive(Debug, Serialize)]
pub struct SearchMatch {
    /// 1-based line number.
    pub line: u32,
    /// The trimmed (and possibly truncated) line text.
    pub text: String,
}

/// All matches for one file.
#[derive(Debug, Serialize)]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
}

// Bounds so a search over a huge or pathological folder stays responsive and
// can't balloon webview memory. Hit caps degrade gracefully (partial results).
const SEARCH_MAX_FILES: usize = 5000; // markdown files scanned
const SEARCH_MAX_RESULTS: usize = 300; // files returned with at least one match
const SEARCH_MAX_MATCHES_PER_FILE: usize = 50;
const SEARCH_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // skip very large files
const SEARCH_SNIPPET_CHARS: usize = 240; // truncate long matching lines

/// Search the text of every markdown file under `directory` (recursively) for
/// `query`. Case-insensitive unless `case_sensitive`. Returns per-file matches
/// with 1-based line numbers so the UI can jump straight to a hit. Skips hidden
/// directories plus `node_modules` / `target`, and is bounded by the caps above.
#[tauri::command]
pub async fn search_files(
    directory: String,
    query: String,
    case_sensitive: bool,
) -> Result<Vec<FileSearchResult>, CommandError> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&directory);
    if !root.is_dir() {
        return Err(CommandError::FileNotFound(directory));
    }

    // The walk is blocking I/O; keep it off the async runtime's worker threads.
    tokio::task::spawn_blocking(move || Ok(search_markdown_tree(root, &q, case_sensitive)))
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?
}

/// Synchronous, bounded recursive search used by `search_files`. Pulled out so
/// it can be unit-tested without a Tauri/async harness. `query` is assumed
/// non-empty and already trimmed.
fn search_markdown_tree(root: PathBuf, query: &str, case_sensitive: bool) -> Vec<FileSearchResult> {
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let mut results: Vec<FileSearchResult> = Vec::new();
    let mut files_scanned = 0usize;
    let mut stack = vec![root];

    while let Some(dir) = stack.pop() {
        if results.len() >= SEARCH_MAX_RESULTS || files_scanned >= SEARCH_MAX_FILES {
            break;
        }
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // unreadable dir — skip, don't fail the whole search
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') || name == "node_modules" || name == "target" {
                        continue;
                    }
                }
                stack.push(path);
                continue;
            }
            if !is_markdown_path(&path) {
                continue;
            }
            files_scanned += 1;
            if files_scanned > SEARCH_MAX_FILES {
                break;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > SEARCH_MAX_FILE_BYTES {
                    continue;
                }
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue, // binary / non-UTF8 — skip
            };
            let mut matches = Vec::new();
            for (i, line) in content.lines().enumerate() {
                let haystack = if case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                if haystack.contains(&needle) {
                    let trimmed = line.trim();
                    // Char-boundary-safe truncation (byte slicing could panic on
                    // multibyte UTF-8).
                    let text = if trimmed.chars().count() > SEARCH_SNIPPET_CHARS {
                        let mut s: String = trimmed.chars().take(SEARCH_SNIPPET_CHARS).collect();
                        s.push('…');
                        s
                    } else {
                        trimmed.to_string()
                    };
                    matches.push(SearchMatch {
                        line: (i + 1) as u32,
                        text,
                    });
                    if matches.len() >= SEARCH_MAX_MATCHES_PER_FILE {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                results.push(FileSearchResult {
                    path: path.to_string_lossy().to_string(),
                    name,
                    matches,
                });
                if results.len() >= SEARCH_MAX_RESULTS {
                    break;
                }
            }
        }
    }

    results.sort_by_key(|r| r.name.to_lowercase());
    results
}

/// One `[[wikilink]]` pointing at the current note.
#[derive(Debug, Serialize)]
pub struct BacklinkMatch {
    /// 1-based line number.
    pub line: u32,
    /// The trimmed (and possibly truncated) line the link sits on.
    pub text: String,
    /// The `alias` half of `[[target|alias]]`, when the link has one.
    pub alias: Option<String>,
}

/// All the links to the current note found in one file.
#[derive(Debug, Serialize)]
pub struct BacklinkResult {
    pub path: String,
    pub name: String,
    pub matches: Vec<BacklinkMatch>,
}

// Bounds, in the spirit of the SEARCH_* caps above. Separate constants because a
// backlink scan is one flat directory rather than a tree, so the file ceiling can
// be much lower: 5000 markdown files in a SINGLE folder is not a note vault, it is
// a pathological case, and we would rather return partial results than stall.
const BACKLINK_MAX_FILES: usize = 2000; // markdown files scanned in the folder
const BACKLINK_MAX_RESULTS: usize = 300; // files returned with at least one link
const BACKLINK_MAX_MATCHES_PER_FILE: usize = 50;
const BACKLINK_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // skip very large files
const BACKLINK_SNIPPET_CHARS: usize = 240; // truncate long matching lines

/// Find every `[[wikilink]]` in `directory` that points at `note_name` (the
/// current note's basename with its extension stripped).
///
/// SAME FOLDER, ONE LEVEL, NO RECURSION, and that is correctness rather than a
/// shortcut: the wikilink resolver rejects any target with a path separator and
/// resolves `[[Foo]]` against the LINKING file's own directory. A `[[Foo]]` in
/// `sub/Baz.md` therefore opens `sub/Foo.md`, never the `Foo.md` one level up,
/// so listing it as a backlink of `Foo.md` would be a lie.
#[tauri::command]
pub async fn find_backlinks(
    directory: String,
    note_name: String,
) -> Result<Vec<BacklinkResult>, CommandError> {
    let note = note_name.trim().to_string();
    if note.is_empty() {
        return Ok(Vec::new());
    }
    let dir = PathBuf::from(&directory);
    if !dir.is_dir() {
        return Err(CommandError::FileNotFound(directory));
    }

    // Blocking I/O; keep it off the async runtime's worker threads.
    tokio::task::spawn_blocking(move || Ok(scan_backlinks(dir, &note)))
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?
}

/// Synchronous, bounded, single-level scan used by `find_backlinks`. Pulled out
/// so it can be unit-tested without a Tauri/async harness. `note_name` is assumed
/// non-empty and already trimmed.
fn scan_backlinks(dir: PathBuf, note_name: &str) -> Vec<BacklinkResult> {
    // Case-INSENSITIVE, deliberately. macOS (APFS) and Windows both resolve
    // `[[foo]]` to `Foo.md`, and the frontend resolver probes the filesystem with
    // `get_file_info`, so on those platforms the link really does open this note.
    // Matching case-sensitively would under-report on the two platforms most
    // users are on.
    let target = note_name.to_lowercase();
    let mut results: Vec<BacklinkResult> = Vec::new();
    let mut files_scanned = 0usize;

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return results, // unreadable folder: no backlinks, not an error
    };

    for entry in read_dir.flatten() {
        if results.len() >= BACKLINK_MAX_RESULTS || files_scanned >= BACKLINK_MAX_FILES {
            break;
        }
        let path = entry.path();
        // `path.is_file()` FOLLOWS symlinks; `entry.file_type()` does not, and would
        // drop a symlinked note. `list_directory_files` follows them, so the file
        // shows in the explorer, opens, and its wikilinks resolve; a scan that
        // skipped it would leave that note's mentions missing from the panel with no
        // hint why. Directories are excluded by the same call: this scan is one
        // level and never recurses (see the doc comment above).
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // Same entry filter as `list_directory_files`: no dotfiles, markdown only.
        if file_name.starts_with('.') {
            continue;
        }
        if !is_markdown_path(&path) {
            continue;
        }
        // A note does not backlink to itself.
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if stem == target {
            continue;
        }

        files_scanned += 1;
        if let Ok(meta) = entry.metadata() {
            if meta.len() > BACKLINK_MAX_FILE_BYTES {
                continue;
            }
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // binary / non-UTF8: skip
        };

        let mut matches: Vec<BacklinkMatch> = Vec::new();
        'lines: for (i, line) in content.lines().enumerate() {
            for (link_target, alias) in wikilinks_in_line(line) {
                if !links_to(link_target, &target) {
                    continue;
                }
                let trimmed = line.trim();
                // Char-boundary-safe truncation (byte slicing could panic on
                // multibyte UTF-8).
                let text = if trimmed.chars().count() > BACKLINK_SNIPPET_CHARS {
                    let mut s: String = trimmed.chars().take(BACKLINK_SNIPPET_CHARS).collect();
                    s.push('…');
                    s
                } else {
                    trimmed.to_string()
                };
                let alias = alias
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty());
                matches.push(BacklinkMatch {
                    line: (i + 1) as u32,
                    text,
                    alias,
                });
                if matches.len() >= BACKLINK_MAX_MATCHES_PER_FILE {
                    break 'lines;
                }
            }
        }

        if !matches.is_empty() {
            results.push(BacklinkResult {
                path: path.to_string_lossy().to_string(),
                name: file_name.to_string(),
                matches,
            });
        }
    }

    results.sort_by_key(|r| r.name.to_lowercase());
    results
}

/// Does this wikilink target point at `target_lower` (already lowercased)?
///
/// Rejects anything the frontend resolver would refuse to follow (a path
/// separator or a `..` segment): if the link would never open the note, it is not
/// a backlink to it. Comparison is on the trimmed, lowercased target, so
/// `[[ Foo ]]` and `[[foo]]` both count and `[[Foobar]]` does not.
fn links_to(link_target: &str, target_lower: &str) -> bool {
    let cleaned = link_target.trim();
    if cleaned.is_empty()
        || cleaned.contains('/')
        || cleaned.contains('\\')
        || cleaned.contains("..")
    {
        return false;
    }
    cleaned.to_lowercase() == target_lower
}

/// Extract every `[[target]]` / `[[target|alias]]` on one line, in order.
/// Returns the raw (untrimmed) target and alias slices. A `[` or `]` inside the
/// body disqualifies it, so a stray `[[[Foo]]` does not yield a `[Foo` target.
fn wikilinks_in_line(line: &str) -> Vec<(&str, Option<&str>)> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let end = match after.find("]]") {
            Some(e) => e,
            None => break, // unterminated: nothing further on this line can close
        };
        let inner = &after[..end];
        if inner.contains('[') || inner.contains(']') {
            // Disqualified, so rescan from just past THIS `[[` rather than from
            // past the `]]` we happened to pair it with: that closer may well
            // belong to a real link further along the line. `Type [[ to link, as
            // in [[Foo]].` pairs the stray opener with the genuine link's closer,
            // and skipping to after it would swallow `[[Foo]]` whole. `after` is
            // always two bytes shorter than `rest`, so the loop still advances.
            rest = after;
            continue;
        }
        rest = &after[end + 2..];
        match inner.split_once('|') {
            Some((t, a)) => out.push((t, Some(a))),
            None => out.push((inner, None)),
        }
    }
    out
}

/// Strip any path components from a filename so it can't traverse outside the
/// images directory. Rejects empty / dot-only names and names with separators,
/// drive letters, or NUL bytes. Also enforces an extension whitelist so the
/// "image paste" command can't be used to drop a `.exe` / `.dll` / `.lnk`
/// into the user's documents folder under cover of a markdown image flow.
/// Returns just the basename when valid.
fn sanitize_image_name(name: &str) -> Result<String, CommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(CommandError::WriteError(
            "Invalid image filename".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(CommandError::WriteError(
            "Invalid image filename".to_string(),
        ));
    }
    // Reject both path separators explicitly, on every platform. On Unix a
    // backslash is a legal filename character, so the Path::file_name() check
    // below would let a Windows-style "..\foo.png" traversal payload through;
    // rejecting separators up front keeps the behavior identical cross-platform.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(CommandError::WriteError(
            "Invalid image filename".to_string(),
        ));
    }
    // Reject any path-like input — only a bare basename is allowed.
    let basename = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| CommandError::WriteError("Invalid image filename".to_string()))?;
    if basename != trimmed {
        return Err(CommandError::WriteError(
            "Invalid image filename".to_string(),
        ));
    }
    // Enforce extension whitelist (case-insensitive). A name with no extension,
    // or one whose extension isn't a known image type, is rejected — this is
    // a defense-in-depth check on top of the basename validation above.
    let ext = std::path::Path::new(basename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext {
        Some(e) if ALLOWED_IMAGE_EXTS.contains(&e.as_str()) => Ok(basename.to_string()),
        _ => Err(CommandError::WriteError(
            "Image filename must end in .png/.jpg/.jpeg/.gif/.webp/.bmp/.svg".to_string(),
        )),
    }
}

/// Save image data to a file in the images subdirectory
/// Returns the relative path to use in markdown
#[tauri::command]
pub async fn save_image(
    md_file_path: String,
    image_data: Vec<u8>,
    image_name: String,
) -> Result<String, CommandError> {
    if image_data.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::TooLarge(format!(
            "Image is {} MB; maximum is {} MB",
            image_data.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024),
        )));
    }
    let safe_name = sanitize_image_name(&image_name)?;
    let md_path = PathBuf::from(&md_file_path);

    // Get the directory containing the markdown file
    let parent_dir = md_path
        .parent()
        .ok_or_else(|| CommandError::WriteError("Cannot determine parent directory".to_string()))?;

    // Create images subdirectory
    let images_dir = parent_dir.join("images");
    if !images_dir.exists() {
        tokio::fs::create_dir_all(&images_dir).await.map_err(|e| {
            CommandError::WriteError(format!("Failed to create images directory: {}", e))
        })?;
    }

    // Full path for the image (basename only, no traversal possible).
    let image_path = images_dir.join(&safe_name);

    // Write the image data
    tokio::fs::write(&image_path, &image_data)
        .await
        .map_err(|e| CommandError::WriteError(format!("Failed to write image: {}", e)))?;

    // Return relative path for markdown (./images/filename.png)
    Ok(format!("./images/{}", safe_name))
}

/// Reject a relative image path that tries to escape the document folder or name
/// an absolute location. Mirrors the front-end `isUnsafeRelativePath` guard so the
/// boundary is enforced in Rust too — the front-end is not a trust boundary.
fn validate_rel_path(rel: &str) -> Result<(), CommandError> {
    if rel.is_empty() || rel.contains('\0') {
        return Err(CommandError::ReadError("Invalid image path".to_string()));
    }
    // Reject Windows drive-letter prefixes (e.g. "C:/...") explicitly — on a
    // non-Windows host they don't parse as an absolute Prefix component, so the
    // checks below would miss them.
    let b = rel.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Err(CommandError::ReadError(
            "Image path must be relative".to_string(),
        ));
    }
    let p = std::path::Path::new(rel);
    if p.is_absolute() {
        return Err(CommandError::ReadError(
            "Image path must be relative".to_string(),
        ));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(CommandError::ReadError(
                    "Image path escapes the document folder".to_string(),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Read an image that lives under `base_dir` (the open markdown file's directory)
/// and return its raw bytes. Replaces the front-end's `plugin-fs` readFile so we
/// no longer need a broad `fs:allow-read **` capability (SECURITY-02). Validates
/// the relative path, enforces the image size cap, and canonicalizes both base
/// and target to guarantee the resolved file is still inside `base_dir` — which
/// also blocks symlinked escapes (SECURITY-05). Bytes are returned via
/// `tauri::ipc::Response` so large images skip JSON-array serialization.
#[tauri::command]
pub async fn read_image_file(base_dir: String, rel_path: String) -> Result<Response, CommandError> {
    validate_rel_path(&rel_path)?;
    let base = PathBuf::from(&base_dir);
    let full = base.join(&rel_path);

    let metadata = tokio::fs::metadata(&full)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err(CommandError::TooLarge(format!(
            "Image is {} MB; maximum is {} MB",
            metadata.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024),
        )));
    }

    // canonicalize() resolves symlinks; the containment check then guarantees the
    // real file is inside the document folder.
    let canon_base = tokio::fs::canonicalize(&base)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;
    let canon_full = tokio::fs::canonicalize(&full)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;
    if !canon_full.starts_with(&canon_base) {
        return Err(CommandError::ReadError(
            "Image path escapes the document folder".to_string(),
        ));
    }

    let data = tokio::fs::read(&canon_full)
        .await
        .map_err(|e| CommandError::ReadError(e.to_string()))?;
    Ok(Response::new(data))
}

// ===== AI API key: OS keychain (SECURITY-01) =====
//
// The key lives ONLY in the platform credential store, never in plaintext and
// never in the webview. The endpoint and the model are ordinary settings and
// live in settings.json; only the KEY routes through here. Keychain-only by
// design: there is no localStorage, file, or plaintext fallback, so if there is
// no keychain there is simply no stored key (a local endpoint like Ollama needs
// none anyway).
//
// The value never crosses IPC into the webview. `ai::ai_request` reads it here,
// in Rust, and sets the `Authorization` header itself; nothing hands the key back
// to JS. An earlier `get_ai_key` command returned it over IPC, so any webview XSS
// could read it with `invoke('get_ai_key')`, and that command is now gone.
// `ai_key_present` lets the Settings UI show that a key is saved without ever
// receiving the value.
//
// The service name is the app's own, so nothing else reads or overwrites the key.
const AI_KEY_SERVICE: &str = "dumont";
const AI_KEY_ACCOUNT: &str = "ai-api-key";

/// Read the stored AI key from the OS keychain, for Rust-side use only.
///
/// `Ok(None)` means "no key": either no keychain entry at all
/// (`keyring::Error::NoEntry`) or an entry holding an empty string. `Ok(Some(k))`
/// is a real key. `Err(..)` is a genuine keychain failure and nothing else.
///
/// This is deliberately NOT a Tauri command: the key must never travel to the
/// webview. `ai::ai_request` calls it (off-thread, see below) and sets the
/// `Authorization` header itself.
pub fn read_ai_key() -> Result<Option<String>, String> {
    read_key_entry(AI_KEY_SERVICE, AI_KEY_ACCOUNT)
}

/// The keychain read, parameterized by service and account. `read_ai_key` calls
/// it with the app's real consts; the tests call it with a throwaway service so a
/// round-trip never touches the user's saved key.
fn read_key_entry(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(key_from_password(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// A stored password is only a key when it is non-empty; an empty value reads as
/// "no key", exactly like a missing entry, so `ai_key_present` is false and no
/// Authorization header is sent. This is the security-relevant rule and the one
/// most likely to regress, so it is a pure function the tests cover without a
/// keychain (keyring::Error is non-exhaustive and cannot be constructed in a test,
/// so the NoEntry and failure arms stay in the round-trip test).
fn key_from_password(password: String) -> Option<String> {
    if password.is_empty() {
        None
    } else {
        Some(password)
    }
}

// The keychain commands are `#[tauri::command(async)]`, and here the `(async)` is not
// about milliseconds, it is about the app freezing indefinitely.
//
// A non-async `#[tauri::command]` runs INLINE on the IPC/main thread, and the keychain
// call is not merely slow, it is UNBOUNDED: on macOS the keychain ACL is tied to the
// code signature, and these builds are unsigned, so the OS puts up "dumont wants to use
// your confidential information" and `SecKeychainFindGenericPassword` blocks until the
// user answers it. On Linux the Secret Service may need to unlock gnome-keyring first.
// The Settings UI calls `ai_key_present` on mount, and `ai_request` reads the key on
// every send, so running either inline would park the main thread behind that modal.
// On the threadpool (or, for `ai_request`, via `spawn_blocking`), the prompt is just a
// prompt.

/// Does a non-empty AI key exist in the keychain? Returns only the boolean, never
/// the value, so the Settings UI can show "a key is saved" without the key ever
/// entering the webview.
#[tauri::command(async)]
pub fn ai_key_present() -> Result<bool, String> {
    Ok(read_ai_key()?.is_some())
}

#[tauri::command(async)]
pub fn set_ai_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(AI_KEY_SERVICE, AI_KEY_ACCOUNT).map_err(|e| e.to_string())?;
    if key.is_empty() {
        // Empty key == "clear it". A missing entry is already the desired state.
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(&key).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_eol, find_backlinks, is_markdown_path, key_from_password, read_file, read_key_entry, sanitize_image_name,
        save_file, scan_backlinks, search_markdown_tree, validate_rel_path, wikilinks_in_line,
        BacklinkResult, CommandError, Eol,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn search_finds_matches_recursively_and_case_insensitively() {
        let dir = std::env::temp_dir().join(format!("dumont-search-{}", std::process::id()));
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.md"), "Hello World\nsecond line").unwrap();
        std::fs::write(sub.join("b.md"), "nothing here\nanother WORLD ref").unwrap();
        std::fs::write(dir.join("c.txt"), "world but not markdown").unwrap();

        let results = search_markdown_tree(dir.clone(), "world", false);

        // Two markdown files match; the .txt is ignored.
        assert_eq!(results.len(), 2);
        let a = results.iter().find(|r| r.name == "a.md").unwrap();
        assert_eq!(a.matches.len(), 1);
        assert_eq!(a.matches[0].line, 1);
        assert_eq!(a.matches[0].text, "Hello World");
        let b = results.iter().find(|r| r.name == "b.md").unwrap();
        assert_eq!(b.matches[0].line, 2);

        // Case-sensitive search misses the lowercase/uppercase variants.
        let cs = search_markdown_tree(dir.clone(), "world", true);
        assert!(cs.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_skips_hidden_and_ignored_dirs() {
        let dir =
            std::env::temp_dir().join(format!("dumont-search-skip-{}", std::process::id()));
        let hidden = dir.join(".git");
        let modules = dir.join("node_modules");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::create_dir_all(&modules).unwrap();
        std::fs::write(dir.join("keep.md"), "needle").unwrap();
        std::fs::write(hidden.join("x.md"), "needle").unwrap();
        std::fs::write(modules.join("y.md"), "needle").unwrap();

        let results = search_markdown_tree(dir.clone(), "needle", false);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "keep.md");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_file_writes_atomically_and_returns_mtime() {
        // Plain current-thread runtime: tokio's "fs" feature doesn't include
        // the macros feature, so no #[tokio::test] here.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("dumont-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("doc.md").to_string_lossy().to_string();

            let mtime = save_file(path.clone(), "hello".into()).await.unwrap();
            assert!(mtime > 0);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");

            // Overwrite must replace the existing file (rename-over semantics).
            let mtime2 = save_file(path.clone(), "world".into()).await.unwrap();
            assert!(mtime2 >= mtime);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "world");

            // No temp file left behind.
            let leftovers: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains("dumont-tmp"))
                .collect();
            assert!(leftovers.is_empty());

            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn apply_eol_converts_and_normalizes() {
        // LF stays LF.
        assert_eq!(apply_eol("a\nb\nc", Eol::Lf), "a\nb\nc");
        // LF content → CRLF on save.
        assert_eq!(apply_eol("a\nb\nc", Eol::Crlf), "a\r\nb\r\nc");
        // Never doubles up if some \r slipped in.
        assert_eq!(apply_eol("a\r\nb", Eol::Crlf), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb", Eol::Lf), "a\nb");
    }

    #[test]
    fn read_file_normalizes_crlf_to_lf() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let dir =
                std::env::temp_dir().join(format!("dumont-read-eol-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("crlf.md").to_string_lossy().to_string();

            // A CRLF file must come back LF-only, matching what CodeMirror
            // will hold — otherwise a freshly opened file reads as dirty.
            std::fs::write(&path, "one\r\ntwo\r\n").unwrap();
            let fd = read_file(path).await.unwrap();
            assert_eq!(fd.content, "one\ntwo\n");

            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn save_file_preserves_crlf_line_endings() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("dumont-eol-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("crlf.md").to_string_lossy().to_string();

            // Seed a CRLF file, then "edit" it with LF-only content (as the editor
            // would hand us) and confirm the CRLF convention survives the save.
            std::fs::write(&path, "one\r\ntwo\r\n").unwrap();
            save_file(path.clone(), "one\ntwo\nthree".into())
                .await
                .unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "one\r\ntwo\r\nthree"
            );

            // A brand-new file keeps the editor's LF.
            let lf_path = dir.join("new.md").to_string_lossy().to_string();
            save_file(lf_path.clone(), "a\nb".into()).await.unwrap();
            assert_eq!(std::fs::read_to_string(&lf_path).unwrap(), "a\nb");

            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn rel_path_accepts_safe_relatives() {
        assert!(validate_rel_path("images/foo.png").is_ok());
        assert!(validate_rel_path("foo.png").is_ok());
        assert!(validate_rel_path("a/b/c.webp").is_ok());
    }

    #[test]
    fn rel_path_rejects_escapes_and_absolutes() {
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../foo.png").is_err());
        assert!(validate_rel_path("images/../../secret").is_err());
        assert!(validate_rel_path("/etc/passwd").is_err());
        assert!(validate_rel_path("\0").is_err());
        // Windows absolute / drive-prefixed paths.
        assert!(validate_rel_path("C:/Windows/system.ini").is_err());
    }

    #[test]
    fn accepts_basename() {
        assert_eq!(sanitize_image_name("foo.png").unwrap(), "foo.png");
        assert_eq!(
            sanitize_image_name("image-1234-abc.jpg").unwrap(),
            "image-1234-abc.jpg"
        );
    }

    #[test]
    fn rejects_traversal() {
        assert!(sanitize_image_name("../foo.png").is_err());
        assert!(sanitize_image_name("..\\foo.png").is_err());
        assert!(sanitize_image_name("foo/bar.png").is_err());
        assert!(sanitize_image_name("foo\\bar.png").is_err());
        assert!(sanitize_image_name("..").is_err());
        assert!(sanitize_image_name(".").is_err());
        assert!(sanitize_image_name("").is_err());
        assert!(sanitize_image_name("\0").is_err());
    }

    #[test]
    fn rejects_non_image_extensions() {
        assert!(sanitize_image_name("malware.exe").is_err());
        assert!(sanitize_image_name("script.lnk").is_err());
        assert!(sanitize_image_name("payload.dll").is_err());
        assert!(sanitize_image_name("noext").is_err());
        assert!(sanitize_image_name("trailing.").is_err());
        // Extension matching is case-insensitive — uppercase OK.
        assert!(sanitize_image_name("photo.PNG").is_ok());
        assert!(sanitize_image_name("photo.JpG").is_ok());
    }

    #[test]
    fn accepts_all_whitelisted_extensions() {
        for ext in &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] {
            let name = format!("img.{}", ext);
            assert!(sanitize_image_name(&name).is_ok(), "rejected {}", name);
        }
    }

    // === Backlinks ===

    /// Two saves of the SAME document, in flight at once, must not corrupt it.
    ///
    /// This is not a contrived race. Autosave arms a 1500 ms timer on the last
    /// keystroke, and pressing Ctrl+S does not change `content`, so the timer is not
    /// cleared: the manual save and the autosave both end up in flight, against one
    /// path. Two rapid Ctrl+S presses do it just as well. `save_file` is `async`, so
    /// Tauri really does dispatch them concurrently.
    ///
    /// The temp file's name must therefore be unique PER CALL. Derive it from the
    /// path and the pid alone and both writers open the same temp file; `File::create`
    /// truncates, so the second truncates the first mid-write, they interleave at
    /// their own offsets, and whichever renames first publishes the splice over the
    /// user's document. The other then fails its rename with ENOENT and raises a
    /// "Failed to save file" toast for a save that in fact destroyed the file.
    #[test]
    fn two_concurrent_saves_of_one_document_do_not_corrupt_it() {
        let dir = TempDir::new();
        let path = dir.path().join("note.md");
        let path_str = path.to_string_lossy().to_string();

        // Two plausible versions of the same document, of different lengths so a
        // splice of the two cannot accidentally equal either one.
        let a = "# Note\n\n".to_string() + &"alpha ".repeat(4000);
        let b = "# Note\n\n".to_string() + &"beta ".repeat(3000);

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();

        for round in 0..40 {
            std::fs::write(&path, "# Note\n").expect("seed");

            let (p1, p2) = (path_str.clone(), path_str.clone());
            let (c1, c2) = (a.clone(), b.clone());
            let (r1, r2) = rt.block_on(async move {
                tokio::join!(
                    tokio::spawn(async move { save_file(p1, c1).await }),
                    tokio::spawn(async move { save_file(p2, c2).await }),
                )
            });
            let (r1, r2) = (r1.unwrap(), r2.unwrap());

            let on_disk = std::fs::read_to_string(&path).expect("read back");
            assert!(
                on_disk == a || on_disk == b,
                "round {round}: the document is a splice of both saves and matches neither. \
                 {} bytes on disk, versions are {} and {}.",
                on_disk.len(),
                a.len(),
                b.len()
            );

            // A save that reported Ok must have actually been a whole document, and a
            // save that reported Err must not have been the one that landed. Neither
            // writer may report success over bytes it did not write.
            if r1.is_ok() && r2.is_err() {
                assert_eq!(on_disk, a, "round {round}: save A said Ok, but B's bytes are on disk");
            }
            if r2.is_ok() && r1.is_err() {
                assert_eq!(on_disk, b, "round {round}: save B said Ok, but A's bytes are on disk");
            }

            // And no temp file may be left behind.
            let leftovers: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.contains("dumont-tmp"))
                .collect();
            assert!(leftovers.is_empty(), "round {round}: temp files left behind: {leftovers:?}");
        }
    }

    /// A scratch directory that deletes itself, so a failing assert cannot leave
    /// litter behind for the next run to trip over. (Same shape as themes.rs's;
    /// there is no `tempfile` dev-dependency and this does not warrant adding one.)
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "dumont-backlinks-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self) -> std::path::PathBuf {
            self.0.clone()
        }

        fn write(&self, name: &str, contents: &str) {
            let target = self.0.join(name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create fixture dir");
            }
            std::fs::write(target, contents).expect("write fixture");
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every match in the scan, flattened to (file name, line, alias).
    fn flatten(results: &[BacklinkResult]) -> Vec<(&str, u32, Option<&str>)> {
        results
            .iter()
            .flat_map(|r| {
                r.matches
                    .iter()
                    .map(move |m| (r.name.as_str(), m.line, m.alias.as_deref()))
            })
            .collect()
    }

    #[test]
    fn backlinks_find_plain_aliased_and_case_insensitive_links() {
        let dir = TempDir::new();
        dir.write("plain.md", "intro\nsee [[Foo]] for more");
        dir.write("aliased.md", "see [[Foo|see this]] instead");
        dir.write("lower.md", "a [[foo]] link");

        let results = scan_backlinks(dir.path(), "Foo");

        // Sorted by lowercased filename.
        let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["aliased.md", "lower.md", "plain.md"]);

        let flat = flatten(&results);
        assert_eq!(
            flat,
            vec![
                ("aliased.md", 1, Some("see this")),
                ("lower.md", 1, None),
                ("plain.md", 2, None),
            ]
        );

        // The snippet is the whole (trimmed) line the link sits on.
        let plain = results.iter().find(|r| r.name == "plain.md").unwrap();
        assert_eq!(plain.matches[0].text, "see [[Foo]] for more");
    }

    #[test]
    fn backlinks_reject_substring_and_pathy_targets() {
        let dir = TempDir::new();
        // A longer name that merely CONTAINS the target is a different note.
        dir.write("substring.md", "[[Foobar]] and [[a Foo b]] and [[Fo]]");
        // The resolver refuses any target with a separator or a `..`, so a link it
        // would never follow is not a backlink.
        dir.write("pathy.md", "[[sub/Foo]] [[sub\\Foo]] [[../Foo]]");
        dir.write("real.md", "[[Foo]]");

        let results = scan_backlinks(dir.path(), "Foo");

        let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);
    }

    /// `NOTES.MD` is a markdown file. macOS and Windows match file associations
    /// case-insensitively, so the OS hands such a file to Dumont when you double-click
    /// it, and every gate in the app used to say no: it did not open from Finder, and
    /// it was absent from the explorer, from search and from backlinks. It DID open
    /// through File > Open, because read_file checks no extension at all, so the app
    /// would open a file it refused to list.
    #[test]
    fn markdown_is_recognized_whatever_case_the_extension_is_written_in() {
        use std::path::Path;

        for name in ["a.md", "a.MD", "a.Md", "a.markdown", "a.MARKDOWN", "a.MarkDown"] {
            assert!(is_markdown_path(Path::new(name)), "{name} is markdown");
        }
        for name in ["a.txt", "a.rs", "a.mdx", "a", "a.md.bak"] {
            assert!(!is_markdown_path(Path::new(name)), "{name} is not markdown");
        }
    }

    /// The scan uses the shared definition, so an uppercase note is a real backlink.
    #[test]
    fn backlinks_see_an_uppercase_extension() {
        let dir = TempDir::new();
        dir.write("SHOUTING.MD", "A link to [[Foo]] from a file named in caps.");

        let results = scan_backlinks(dir.path(), "Foo");

        assert_eq!(flatten(&results), vec![("SHOUTING.MD", 1, None)]);
    }

    #[test]
    fn backlinks_exclude_self_and_do_not_descend() {
        let dir = TempDir::new();
        // The note itself, linking to itself: not a backlink. Matched on the file
        // STEM, case-insensitively, so `foo.md` is also the note when it is `Foo`.
        dir.write("Foo.md", "I am [[Foo]], see also [[Foo|me]]");
        // A subdirectory. Its `[[Foo]]` resolves to `sub/Foo.md`, not to this one.
        dir.write("sub/nested.md", "[[Foo]]");
        // A dotfile and a dot-directory are both skipped.
        dir.write(".hidden.md", "[[Foo]]");
        dir.write(".git/config.md", "[[Foo]]");
        // Not markdown.
        dir.write("notes.txt", "[[Foo]]");
        dir.write("sibling.markdown", "[[Foo]]");

        let results = scan_backlinks(dir.path(), "Foo");

        let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["sibling.markdown"]);
    }

    #[test]
    fn backlinks_report_every_link_on_a_line() {
        let dir = TempDir::new();
        dir.write("many.md", "[[Foo]] then [[Foo|second]] then [[Bar]]");

        let results = scan_backlinks(dir.path(), "Foo");

        assert_eq!(results.len(), 1);
        assert_eq!(
            flatten(&results),
            vec![("many.md", 1, None), ("many.md", 1, Some("second"))]
        );
    }

    /// A stray `[[` earlier on the line must not swallow the real link after it.
    /// The scanner pairs the stray opener with the genuine link's `]]`, and the
    /// candidate it forms is disqualified for containing a `[`. If it then resumed
    /// past that `]]` it would step over `[[Foo]]` entirely, and a note documenting
    /// the linking syntax is exactly the sort of note that also uses it.
    #[test]
    fn backlinks_survive_a_stray_opener_earlier_on_the_line() {
        let dir = TempDir::new();
        dir.write("syntax.md", "Type [[ to start a link, for example [[Foo]].");

        let results = scan_backlinks(dir.path(), "Foo");

        assert_eq!(flatten(&results), vec![("syntax.md", 1, None)]);
    }

    /// `list_directory_files` follows symlinks, so a symlinked note is listed, opens,
    /// and its wikilinks resolve. The backlink scan has to follow them too, or that
    /// note's mentions go missing with no hint why.
    #[cfg(unix)]
    #[test]
    fn backlinks_follow_symlinked_notes() {
        let dir = TempDir::new();
        let outside = TempDir::new();
        outside.write("Shared.md", "A link to [[Foo]] from outside the folder.");
        std::os::unix::fs::symlink(outside.path().join("Shared.md"), dir.path().join("Shared.md"))
            .expect("symlink");

        let results = scan_backlinks(dir.path(), "Foo");

        assert_eq!(flatten(&results), vec![("Shared.md", 1, None)]);
    }

    #[test]
    fn backlinks_command_validates_directory_and_empty_name() {
        // Plain current-thread runtime: tokio's "fs" feature doesn't include the
        // macros feature, so no #[tokio::test] here.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let dir = TempDir::new();
            dir.write("a.md", "[[Foo]]");
            let dir_str = dir.path().to_string_lossy().to_string();

            // An empty note name is not an error, it just has no backlinks.
            assert!(find_backlinks(dir_str.clone(), "  ".into())
                .await
                .unwrap()
                .is_empty());

            let hits = find_backlinks(dir_str, "Foo".into()).await.unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].name, "a.md");

            // A directory that isn't one.
            let missing = dir.path().join("nope").to_string_lossy().to_string();
            assert!(matches!(
                find_backlinks(missing, "Foo".into()).await,
                Err(CommandError::FileNotFound(_))
            ));
        });
    }

    #[test]
    fn wikilink_scanner_handles_edge_cases() {
        assert!(wikilinks_in_line("no links here").is_empty());
        assert_eq!(wikilinks_in_line("[[A]]"), vec![("A", None)]);
        assert_eq!(wikilinks_in_line("[[A|b]]"), vec![("A", Some("b"))]);
        // Unterminated: nothing on the line can close it.
        assert!(wikilinks_in_line("[[A").is_empty());
        // Brackets inside the body disqualify it.
        assert!(wikilinks_in_line("[[[A]]").is_empty());
        // Two on one line, second one aliased.
        assert_eq!(
            wikilinks_in_line("x [[A]] y [[B|c]] z"),
            vec![("A", None), ("B", Some("c"))]
        );
    }

    // ===== AI key keychain =====

    // Round-tripping a key through the OS credential store, so #[ignore]d: CI runs
    // headless (Linux with no Secret Service, macOS with no unlocked login
    // keychain), where every keyring call errors and would fail the suite. Run it
    // locally with `cargo test -- --ignored`. It uses a THROWAWAY service and
    // account, never the app's real "dumont"/"ai-api-key" entry, so a manual run
    // cannot clobber a developer's saved key.
    const TEST_KEY_SERVICE: &str = "dumont-test-suite";
    const TEST_KEY_ACCOUNT: &str = "ai-api-key-roundtrip";

    /// A stored key reads back as `Some` (present); an empty value and a missing
    /// entry both read back as `Ok(None)` (absent), never as an error. This is the
    /// exact mapping `read_ai_key`/`ai_key_present` rely on.
    #[test]
    #[ignore = "touches the OS keychain; run with --ignored"]
    fn present_tracks_a_stored_key_and_clears_with_it() {
        let entry = keyring::Entry::new(TEST_KEY_SERVICE, TEST_KEY_ACCOUNT).unwrap();

        // Set a key: it reads back and is present.
        entry.set_password("sk-secret").unwrap();
        assert_eq!(
            read_key_entry(TEST_KEY_SERVICE, TEST_KEY_ACCOUNT),
            Ok(Some("sk-secret".to_string())),
        );

        // An empty stored value counts as no key.
        entry.set_password("").unwrap();
        assert_eq!(read_key_entry(TEST_KEY_SERVICE, TEST_KEY_ACCOUNT), Ok(None));

        // Clearing the entry also reads back as no key (NoEntry -> None).
        entry.delete_credential().unwrap();
        assert_eq!(read_key_entry(TEST_KEY_SERVICE, TEST_KEY_ACCOUNT), Ok(None));
    }

    /// The empty-value rule, in CI. A stored password only counts as a key when it
    /// is non-empty, so a blank entry never sends an Authorization header and never
    /// reports as present. Pure, so it needs no keychain; the NoEntry and failure
    /// arms are exercised by the round-trip test above (which is #[ignore]d for CI).
    #[test]
    fn empty_password_is_not_a_key() {
        assert_eq!(
            key_from_password("sk-secret".to_string()),
            Some("sk-secret".to_string()),
        );
        assert_eq!(key_from_password(String::new()), None);
    }
}
