//! Local version history: a snapshot of the document every time it is saved.
//!
//! A safety net, not a version control system. It exists to answer one question,
//! "what did this file say ten minutes ago", without asking the user to have set
//! anything up beforehand. Restoring is the frontend's job and is deliberately
//! NOT a command here: a snapshot is offered as a proposed change in the editor's
//! diff view, which the user accepts chunk by chunk and then saves. Nothing in
//! this module ever writes to the user's document.
//!
//! ## Coalescing is the whole feature
//!
//! Autosave fires 1.5 s after the user stops typing. Snapshot every save naively
//! and ten minutes of writing burns through the entire retention cap, leaving a
//! ring buffer that covers the last ninety seconds: a history feature that
//! destroys history, silently, and precisely for the users who write the most.
//!
//! So a save whose newest snapshot is YOUNGER than `min_interval_secs` records
//! nothing at all. The window is anchored to the snapshot that opened it, which
//! is what bounds the rate: an hour of continuous typing at a 60 s interval
//! yields about sixty snapshots, not two thousand.
//!
//! SKIPPING the save is not the same as folding its content into the head
//! snapshot, and the difference is the difference between a safety net and a
//! trap. Take the case this feature exists for: the user deletes three paragraphs
//! and saves. Fold that content into the head and the newest snapshot is now the
//! DAMAGED one, thirty seconds after the good copy was taken, and the good copy
//! is gone. Skip it and the newest snapshot still predates the deletion, which is
//! exactly the version the user is reaching for. A snapshot's content is always
//! the document as it stood at that snapshot's timestamp, never later.
//!
//! Advancing the head's timestamp on each save (an obvious-looking "keep it
//! current" tweak) is worse still: with autosave running, the next save always
//! lands inside the freshly-slid window, so the app coalesces forever and a
//! three-hour session ends with exactly ONE snapshot.
//!
//! The cost of skipping is that work done in the last `min_interval_secs` is not
//! in the history. It is not lost: autosave has already written it to the actual
//! file. History's job is to preserve OLD states, and the file on disk is the
//! authority on the new one.
//!
//! ## Where it lives
//!
//! `app_data_dir`, NOT `app_config_dir`. settings.json and themes/ are config,
//! hand-editable and small; snapshots are generated data that grows without
//! bound. On Linux that distinction is the difference between `~/.config` and
//! `~/.local/share`, and a growing store does not belong in the former.
//!
//! ```text
//! <app_data_dir>/history/<32-hex-of-sha256(abs path)>/
//!     meta.json     {"path": "<the real absolute path>", "snapshots": [{id, timestamp, bytes}, …]}
//!     <id>.md       the snapshot text
//! ```
//!
//! The hash keeps the directory name flat and legal on every filesystem; the real
//! path is stored inside meta.json so the store stays debuggable and prunable by
//! hand. `snapshots` is ordered OLDEST FIRST on disk (append and prune are both
//! ends of a queue); the command hands the frontend the reverse, newest first,
//! because that is the only order a history list is ever read in.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Serializes every MUTATION of the store, so the one-time startup sweep cannot
/// interleave with a `snapshot_file` or `clear_history` the frontend fires seconds
/// into the session.
///
/// The store's safety rests entirely on atomic file operations (temp + rename),
/// and those assume a SINGLE writer per directory: `snapshot_in` commits the index
/// before deleting evicted content, `write_atomic` names its temp by pid, and
/// `load_meta` trusts a parseable index. The sweep is a second writer running on
/// its own thread, so without this lock it can race a save and leave the index
/// promising a snapshot whose file it just helped delete, delete a live write's
/// temp file out from under it, or collide on the shared `meta.json.<pid>.tmp`.
///
/// It guards `()` because it orders access, it does not protect in-memory data:
/// the invariant it defends lives on disk. Reads (`list_snapshots`, `read_snapshot`)
/// deliberately do NOT take it, because an atomic rename lets a reader see either
/// the whole old file or the whole new one, never a torn write.
#[derive(Clone, Default)]
pub struct StoreLock(Arc<Mutex<()>>);

impl StoreLock {
    /// Recovers from poisoning rather than propagating it: the guarded value is
    /// `()`, so a panic under the lock leaves nothing inconsistent, and a history
    /// snapshot is not worth taking the whole app down over.
    pub fn guard(&self) -> MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Refuse to snapshot a document bigger than this.
///
/// A history is only worth keeping if it is cheap. 50 snapshots of a 5 MB file is
/// already 250 MB; past that the store costs more than the document is worth, and
/// a file that large is not the prose this app is for. Saving still works, it just
/// goes unrecorded. `save_file` independently caps writes at 50 MB.
pub const HISTORY_MAX_SNAPSHOT_BYTES: usize = 5 * 1024 * 1024;

const HISTORY_DIR: &str = "history";
const META_FILE: &str = "meta.json";

/// One snapshot, as the frontend sees it. `timestamp` is ms since the epoch, and
/// it is also the id (see `unique_id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub id: String,
    pub timestamp: u64,
    pub bytes: u64,
}

/// The on-disk index for one document.
#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryMeta {
    /// The real absolute path. Nothing reads it back (the directory is addressed
    /// by hash), but without it the store is a pile of unidentifiable hashes.
    path: String,
    /// Oldest first.
    snapshots: Vec<SnapshotMeta>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The directory name for a document: sha256 of its absolute path, hex, truncated.
///
/// Truncation is safe here because a collision is not a security boundary, it is
/// two documents sharing a history. 128 bits of hex makes that impossible in
/// practice, and a shorter name keeps the store readable.
fn key_for(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex = format!("{digest:x}");
    hex[..32].to_string()
}

fn doc_dir(root: &Path, path: &str) -> PathBuf {
    root.join(HISTORY_DIR).join(key_for(path))
}

/// An id we are willing to turn into a filename.
///
/// Ids are minted here (a decimal timestamp, optionally `-N` suffixed), but they
/// come BACK from the frontend in `read_snapshot`, and a path is exactly the kind
/// of thing that should not be assembled from a string another process handed us.
/// Digits and dashes only: no separators, no `..`, no extension games.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Write a file atomically: sibling temp, fsync, rename. Mirrors `write_settings`.
///
/// The fsync is not belt-and-braces. Without it the rename can reach the journal
/// before the data blocks do, so a crash straight afterwards leaves a snapshot
/// that exists, is named correctly, and is EMPTY. Losing the user's text to the
/// feature whose entire purpose is not losing the user's text would be a
/// particularly bad joke. The temp file is a sibling so the rename never crosses a
/// filesystem, and it carries the pid so two instances cannot collide on it.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let target = dir.join(name);
    let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));

    let write_and_sync = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()
    };
    if let Err(e) = write_and_sync() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not write {}: {e}", temp.display()));
    }

    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not replace {}: {e}", target.display()));
    }

    Ok(())
}

fn write_meta(dir: &Path, meta: &HistoryMeta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|e| format!("could not encode history index: {e}"))?;
    write_atomic(dir, META_FILE, text.as_bytes())
}

/// Rebuild the index by reading the snapshot files themselves.
///
/// The index is derivable, which is a happy consequence of the id BEING the
/// timestamp, so a meta.json that is missing or corrupt costs nothing: it is
/// reconstructed from the directory rather than declared a total loss. The
/// alternative (start from an empty index) would orphan every snapshot the user
/// has, and then quietly delete them as pruning caught up. On a store this
/// cheap to rebuild, throwing the user's history away over one bad byte in an
/// index file is not a trade worth making.
fn rebuild_from_dir(dir: &Path, path: &str) -> HistoryMeta {
    let mut snapshots: Vec<SnapshotMeta> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file = entry.path();
            if file.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_valid_id(stem) {
                continue;
            }
            // "1700000000000" and "1700000000000-1" both start with the timestamp.
            let timestamp = stem
                .split('-')
                .next()
                .and_then(|digits| digits.parse::<u64>().ok())
                .unwrap_or(0);
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            snapshots.push(SnapshotMeta { id: stem.to_string(), timestamp, bytes });
        }
    }

    snapshots.sort_by(|a, b| a.timestamp.cmp(&b.timestamp).then_with(|| a.id.cmp(&b.id)));
    HistoryMeta { path: path.to_string(), snapshots }
}

/// The index for a document. Never fails: a missing directory is an empty history,
/// and an unreadable index is rebuilt from the snapshots on disk.
fn load_meta(dir: &Path, path: &str) -> HistoryMeta {
    match std::fs::read_to_string(dir.join(META_FILE)) {
        Ok(text) => match serde_json::from_str::<HistoryMeta>(&text) {
            Ok(mut meta) => {
                // The path can go stale (the user renamed the file and we hashed the
                // new name into a new directory), but within one directory it is ours
                // to keep current.
                meta.path = path.to_string();
                meta
            }
            Err(_) => rebuild_from_dir(dir, path),
        },
        Err(_) => rebuild_from_dir(dir, path),
    }
}

/// A snapshot id not already taken. Normally just the timestamp.
///
/// The counter suffix is for `min_interval_secs == 0`, which the settings schema
/// permits and which means "record every single save". Two saves inside the same
/// millisecond then want the same id, and the second would silently overwrite the
/// first.
fn unique_id(dir: &Path, ms: u64) -> String {
    let mut id = ms.to_string();
    let mut n = 1u32;
    while dir.join(format!("{id}.md")).exists() {
        id = format!("{ms}-{n}");
        n += 1;
    }
    id
}

/// Record a save. Returns the new snapshot, or `None` when nothing was appended:
/// the content was unchanged, the file was too big, or the save coalesced into the
/// snapshot already at the head of the list.
///
/// Pure in the sense that matters: it takes the store root and the clock, so the
/// coalescing and the pruning can be tested without an `AppHandle` or a real save.
pub fn snapshot_in(
    root: &Path,
    path: &str,
    content: &str,
    max_snapshots: usize,
    min_interval_secs: u64,
    now: u64,
) -> Result<Option<SnapshotMeta>, String> {
    if content.len() > HISTORY_MAX_SNAPSHOT_BYTES {
        return Ok(None);
    }

    let dir = doc_dir(root, path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let mut meta = load_meta(&dir, path);

    if let Some(newest) = meta.snapshots.last().cloned() {
        // Inside the interval: record NOTHING. See the module docs; this is the
        // rule the whole feature turns on. Checked before the content read below,
        // so the hot path (autosave, firing every 1.5 s while the user types)
        // opens no snapshot file and performs no fsync.
        //
        // The `newest.timestamp <= now` guard is what stops a head stamped in the
        // FUTURE from disabling history forever. A saturating subtraction would
        // call such a head zero milliseconds old, which is inside every non-zero
        // interval, so every subsequent save would coalesce away and the user
        // would never be told. Clocks do run ahead: a dead CMOS battery, a resumed
        // VM snapshot, a dual-boot RTC disagreement. Treating a future head as
        // outside the window lets the next save append and re-anchor the interval.
        if newest.timestamp <= now
            && now - newest.timestamp < min_interval_secs.saturating_mul(1000)
        {
            return Ok(None);
        }

        // Byte-identical to the newest snapshot: there is nothing to record.
        // Autosave alone cannot reach this (it checks the buffer against disk
        // first), but Ctrl+S on an unchanged document can, and so can saving the
        // same content back after rejecting every chunk of a restore.
        if let Ok(previous) = std::fs::read_to_string(dir.join(format!("{}.md", newest.id))) {
            if previous == content {
                return Ok(None);
            }
        }
    }

    let id = unique_id(&dir, now);
    // Content first, then the index. The reverse order can leave the index
    // promising a snapshot that does not exist; this order can at worst leak one
    // unreferenced .md, which costs disk and nothing else.
    write_atomic(&dir, &format!("{id}.md"), content.as_bytes())?;

    let created = SnapshotMeta { id, timestamp: now, bytes: content.len() as u64 };
    meta.snapshots.push(created.clone());

    // Drop the oldest entries until we are back under the cap. A `.max(1)` because
    // the cap arrives from the frontend and a zero would otherwise prune the
    // snapshot we just took, returning `Some` for a file that no longer exists.
    let cap = max_snapshots.max(1);
    let mut evicted = Vec::new();
    while meta.snapshots.len() > cap {
        evicted.push(meta.snapshots.remove(0));
    }

    // COMMIT THE INDEX BEFORE RECLAIMING THE CONTENT, never the other way round.
    // Deleting an evicted `.md` first would destroy content that the index still
    // on disk continues to promise, and `write_meta` is exactly the step that can
    // fail: a full disk (the user about to need this feature most), or a scanner
    // holding meta.json open on Windows. The old index survives such a failure, so
    // it would still list a snapshot whose text we had already erased, and the
    // frontend swallows the error, so nobody would be told. Committing first means
    // the worst case is a leaked file rather than a lost version.
    write_meta(&dir, &meta)?;
    for dropped in evicted {
        let _ = std::fs::remove_file(dir.join(format!("{}.md", dropped.id)));
    }

    Ok(Some(created))
}

/// Every snapshot for a document, NEWEST FIRST.
pub fn list_in(root: &Path, path: &str) -> Vec<SnapshotMeta> {
    let dir = doc_dir(root, path);
    let mut snapshots = load_meta(&dir, path).snapshots;
    snapshots.reverse();
    snapshots
}

pub fn read_in(root: &Path, path: &str, id: &str) -> Result<String, String> {
    if !is_valid_id(id) {
        return Err(format!("not a snapshot id: {id}"));
    }
    let file = doc_dir(root, path).join(format!("{id}.md"));
    std::fs::read_to_string(&file).map_err(|e| format!("could not read {}: {e}", file.display()))
}

pub fn clear_in(root: &Path, path: &str) -> Result<(), String> {
    let dir = doc_dir(root, path);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        // Never had a history, or it is already gone. Either way the caller's wish
        // has been granted.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not clear {}: {e}", dir.display())),
    }
}

/// One-time housekeeping for the whole store, run once at startup.
///
/// Three leaks accumulate here over a store's lifetime, and none of them is
/// reachable from the per-document commands: every one of those addresses a
/// single directory by hash and never enumerates the root, so nothing else ever
/// looks at the store as a whole.
///
///   * A renamed or deleted note strands its directory forever. The key is
///     `sha256(absolute path)`, so the first save after a rename hashes the NEW
///     name into a new directory and the old one is never opened again: up to
///     `historyLimit` snapshots of up to 5 MB, with nothing to reclaim them.
///   * A crash between writing `<id>.md` and committing meta.json orphans that
///     file. `load_meta` only rebuilds the index when meta.json is missing or
///     unparseable, and after such a crash it parses fine, so the orphan is
///     listed nowhere and pruning never reaches it.
///   * A hard kill mid-write leaves an `<id>.md.<pid>.tmp` sibling that
///     `rebuild_from_dir` cannot even see, because it filters on the `.md`
///     extension.
///
/// Fails soft throughout: a directory that cannot be read is skipped, not fatal.
/// Housekeeping must never keep the app from booting, and the caller runs it off
/// the main thread for the same reason.
///
/// The `lock` is taken PER DIRECTORY, not once for the whole sweep, so a save on
/// one document never waits for the sweep to finish every other document: it waits
/// only for the one directory it shares, and only if the two land at the same
/// instant. See `StoreLock` for why the serialization is needed at all.
pub fn sweep_history_in(root: &Path, lock: &StoreLock) {
    let Ok(entries) = std::fs::read_dir(root.join(HISTORY_DIR)) else {
        // No store yet, or the root is unreadable. Nothing to reclaim.
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.is_dir() {
            let _guard = lock.guard();
            sweep_one_dir(&dir);
        }
    }
}

/// Housekeep a single document's history directory. See `sweep_history_in`.
fn sweep_one_dir(dir: &Path) {
    // Always safe, and independent of everything below: delete the temp file an
    // interrupted atomic write left behind. `rebuild_from_dir` never sees these,
    // so they would otherwise sit in the store forever.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("tmp") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // Everything else needs to know which document this directory belongs to,
    // which only meta.json records. If it is missing or corrupt we cannot know,
    // so we leave the directory alone: the next time the document is opened,
    // `load_meta` rebuilds the index from the `.md` files and adopts any orphan
    // then. Deleting on a guess is the one thing this sweep must never do.
    let Some(meta) = std::fs::read_to_string(dir.join(META_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<HistoryMeta>(&text).ok())
    else {
        return;
    };

    // Retire the whole directory when the note it records is gone for good.
    if should_retire(&meta.path) {
        let _ = std::fs::remove_dir_all(dir);
        return;
    }

    // Adopt any snapshot on disk that the index does not list (a crash-orphaned
    // `.md`), and drop any entry whose `.md` has vanished. `rebuild_from_dir`
    // derives the index straight from the snapshot files, so it already IS the
    // reconciled truth; we only rewrite meta.json when it actually disagrees, so
    // a healthy store is not rewritten (and its mtimes not churned) on every boot.
    //
    // Adoption can leave the index one over `historyLimit` (the sweep does not know
    // the frontend-owned cap, so it cannot prune). That is self-correcting: the next
    // save re-applies the cap and evicts the oldest. Better a brief 51/50 than a
    // snapshot leaked forever.
    let rebuilt = rebuild_from_dir(dir, &meta.path);
    let mut recorded: Vec<&str> = meta.snapshots.iter().map(|s| s.id.as_str()).collect();
    let mut on_disk: Vec<&str> = rebuilt.snapshots.iter().map(|s| s.id.as_str()).collect();
    recorded.sort_unstable();
    on_disk.sort_unstable();
    if recorded != on_disk {
        let _ = write_meta(dir, &rebuilt);
    }
}

/// True when the note a history directory belongs to is gone for good, so its
/// snapshots can be reclaimed.
///
/// "Gone for good" is deliberately conservative, because getting it wrong deletes
/// the user's version history and nothing tells them. Two traps make a naive
/// `exists()` check unsafe, and both err toward deletion, which is the wrong way:
///
///   * `Path::exists()` reports `false` for ANY stat error, not just "not found".
///     A note on a flaky network mount that throws a transient EIO/EACCES at boot
///     would look deleted. So we retire only on a CONFIRMED not-found, and keep on
///     any error or uncertainty.
///   * `exists()` and `try_exists()` both FOLLOW symlinks, so a note that is a
///     local symlink to a file on an unmounted volume would look deleted while the
///     link itself is right there. `symlink_metadata` does not follow, so the link
///     still reads as present and its history is kept.
///
/// Only after the file is confirmed gone do we retire, and even then only if its
/// parent directory is confirmed present: a real delete leaves the folder behind,
/// but an unmounted volume takes the whole path with it, so its history waits for
/// the volume to come back.
fn should_retire(path: &str) -> bool {
    let p = Path::new(path);
    match p.symlink_metadata() {
        Ok(_) => return false, // The path still names a file or a symlink: keep.
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return false, // Errored: don't guess.
        Err(_) => {} // Confirmed not-found: a candidate for retirement.
    }
    // The file is confirmed gone. Retire only if its containing directory is
    // confirmed still here; otherwise the whole volume is most likely unmounted.
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            matches!(parent.try_exists(), Ok(true))
        }
        _ => false,
    }
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))
}

// Every command below is `#[tauri::command(async)]`, and the `(async)` is not
// decoration. A plain `#[tauri::command]` on a NON-async fn is dispatched by
// tauri-macros straight onto the IPC/main thread, and these functions do blocking
// file I/O with `sync_all()` in it, which is a full durability barrier: tens to
// hundreds of milliseconds on a busy, network-mounted or failing disk. That is the
// window frozen, on the typing hot path, because autosave fires 1.5 s after every
// pause. `(async)` moves a sync fn onto the blocking threadpool instead, which is
// what `find_backlinks` achieves the long way round with `spawn_blocking`.

/// Record a save.
///
/// The two limits are PARAMETERS, not something this module looks up. The frontend
/// owns settings.json: it parses it, coerces it and knows what the user's values
/// mean. Rust reading settings.json to find `files.historyLimit` would be a second
/// implementation of the schema, and the two would drift.
#[tauri::command(async)]
pub fn snapshot_file(
    app: AppHandle,
    path: String,
    content: String,
    max_snapshots: usize,
    min_interval_secs: u64,
) -> Result<Option<SnapshotMeta>, String> {
    let root = data_root(&app)?;
    // Serialize against the startup sweep, which writes the same directories on its
    // own thread. Held for the whole read-write-prune so the sweep cannot reconcile
    // a half-applied prune. Contended only in the first seconds after launch.
    let lock = app.state::<StoreLock>();
    let _guard = lock.guard();
    snapshot_in(&root, &path, &content, max_snapshots, min_interval_secs, now_ms())
}

#[tauri::command(async)]
pub fn list_snapshots(app: AppHandle, path: String) -> Result<Vec<SnapshotMeta>, String> {
    let root = data_root(&app)?;
    Ok(list_in(&root, &path))
}

#[tauri::command(async)]
pub fn read_snapshot(app: AppHandle, path: String, id: String) -> Result<String, String> {
    let root = data_root(&app)?;
    read_in(&root, &path, &id)
}

#[tauri::command(async)]
pub fn clear_history(app: AppHandle, path: String) -> Result<(), String> {
    let root = data_root(&app)?;
    // Same store lock as `snapshot_file`: a clear that races the sweep retiring or
    // reconciling the same directory must not interleave with it.
    let lock = app.state::<StoreLock>();
    let _guard = lock.guard();
    clear_in(&root, &path)
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
                "dumont-history-test-{}-{}",
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
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const DOC: &str = "/home/ada/notes/engine.md";
    /// One minute, in the units the command takes.
    const INTERVAL: u64 = 60;
    const T0: u64 = 1_700_000_000_000;

    fn snap(root: &Path, content: &str, now: u64) -> Option<SnapshotMeta> {
        snapshot_in(root, DOC, content, 50, INTERVAL, now).expect("snapshot")
    }

    fn ids(root: &Path) -> Vec<String> {
        list_in(root, DOC).into_iter().map(|s| s.id).collect()
    }

    #[test]
    fn the_first_save_creates_the_directory_the_index_and_the_snapshot() {
        let tmp = TempDir::new();
        let root = tmp.path();

        let created = snap(root, "# Engine\n", T0).expect("first save is always a snapshot");
        assert_eq!(created.timestamp, T0);
        assert_eq!(created.bytes, 9);

        let dir = doc_dir(root, DOC);
        assert!(dir.join(META_FILE).is_file(), "the index is written");
        assert!(dir.join(format!("{}.md", created.id)).is_file(), "so is the content");
        assert_eq!(read_in(root, DOC, &created.id).unwrap(), "# Engine\n");

        // The real path is recorded, or the store is a pile of unidentifiable hashes.
        let meta: HistoryMeta =
            serde_json::from_str(&std::fs::read_to_string(dir.join(META_FILE)).unwrap()).unwrap();
        assert_eq!(meta.path, DOC);
    }

    #[test]
    fn identical_content_records_nothing() {
        let tmp = TempDir::new();
        let root = tmp.path();

        snap(root, "same", T0).expect("first");
        // Far outside the interval, so only the content check can suppress this.
        assert_eq!(snap(root, "same", T0 + 10 * 60 * 1000), None);
        assert_eq!(list_in(root, DOC).len(), 1, "no second snapshot of identical text");
    }

    /// THE test. Autosave with a 1.5 s debounce against a 60 s interval: without
    /// coalescing this is a snapshot every couple of seconds, and the retention cap
    /// eats the user's actual history within minutes.
    #[test]
    fn a_save_inside_the_interval_is_skipped_and_does_not_touch_the_head() {
        let tmp = TempDir::new();
        let root = tmp.path();

        let first = snap(root, "v1", T0).expect("first");

        // Twenty autosaves over the next 40 seconds.
        for i in 1..=20u64 {
            assert_eq!(
                snap(root, &format!("v1 plus {i}"), T0 + i * 2_000),
                None,
                "a save inside the interval records nothing"
            );
        }

        let all = list_in(root, DOC);
        assert_eq!(all.len(), 1, "forty seconds of typing is one snapshot, not twenty-one");
        assert_eq!(all[0].id, first.id, "and it is the one taken at T0");
        assert_eq!(all[0].timestamp, T0, "whose timestamp anchors the interval");
        assert_eq!(
            read_in(root, DOC, &first.id).unwrap(),
            "v1",
            "still holding the content it was taken with, NOT the latest"
        );
        assert_eq!(all[0].bytes, 2, "with the size to match");
    }

    /// The point of skipping rather than folding the new content into the head: the
    /// version the user is reaching for is the one from BEFORE they broke the
    /// document, and a save made thirty seconds later must not overwrite it.
    #[test]
    fn a_destructive_save_inside_the_interval_cannot_clobber_the_good_snapshot() {
        let tmp = TempDir::new();
        let root = tmp.path();

        let good = snap(root, "para one\npara two\npara three", T0).expect("the good version");

        // The user deletes three paragraphs and autosave fires, well inside the window.
        assert_eq!(snap(root, "", T0 + 30_000), None);

        assert_eq!(
            read_in(root, DOC, &good.id).unwrap(),
            "para one\npara two\npara three",
            "the good copy survives the destructive save that followed it"
        );
    }

    /// The other half of the rule, and the reason a skipped save must not touch the
    /// head's timestamp: if a save could slide the window forward, the window would
    /// slide on every autosave and this second snapshot would never be born.
    #[test]
    fn a_save_outside_the_interval_appends() {
        let tmp = TempDir::new();
        let root = tmp.path();

        snap(root, "v1", T0).expect("first");
        assert_eq!(snap(root, "v1 edited", T0 + 30_000), None, "inside the interval");
        let second = snap(root, "v2", T0 + 61_000).expect("past the interval, so a new snapshot");

        let all = list_in(root, DOC);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, second.id, "newest first");
        assert_eq!(all[1].timestamp, T0);
        // The window is anchored on the NEW head now.
        assert_eq!(snap(root, "v2 edited", T0 + 90_000), None);
        assert_eq!(list_in(root, DOC).len(), 2);
    }

    #[test]
    fn an_interval_of_zero_records_every_save_and_never_collides_on_an_id() {
        let tmp = TempDir::new();
        let root = tmp.path();

        // Same millisecond, three different saves. The id is the timestamp, so
        // without the counter suffix the third would overwrite the first two.
        for i in 0..3 {
            snapshot_in(root, DOC, &format!("v{i}"), 50, 0, T0)
                .expect("snapshot")
                .expect("interval 0 appends every save");
        }

        let all = list_in(root, DOC);
        assert_eq!(all.len(), 3, "three saves, three snapshots");
        let mut unique: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 3, "and three distinct ids");
        assert_eq!(read_in(root, DOC, &all[0].id).unwrap(), "v2", "newest first");
    }

    /// A head stamped in the FUTURE must not switch history off for good. Clocks do
    /// run ahead (a dead CMOS battery, a resumed VM image, a dual-boot RTC
    /// disagreement), and a saturating subtraction would report such a head as zero
    /// milliseconds old, which is inside every non-zero interval. Every later save
    /// would then coalesce away, silently, with no way for the user to notice.
    #[test]
    fn a_head_stamped_in_the_future_does_not_disable_history_forever() {
        let tmp = TempDir::new();
        let root = tmp.path();

        // The clock is a day fast; a snapshot is taken. Then NTP corrects it.
        let skewed = T0 + 24 * 60 * 60 * 1000;
        snapshot_in(root, DOC, "written while the clock was wrong", 50, INTERVAL, skewed)
            .expect("snapshot")
            .expect("the first save always records");

        let recorded = snapshot_in(root, DOC, "written after the clock was fixed", 50, INTERVAL, T0)
            .expect("snapshot");

        assert!(
            recorded.is_some(),
            "a save under the corrected clock must still record, or history is dead for this file"
        );
        assert_eq!(list_in(root, DOC).len(), 2);
    }

    #[test]
    fn pruning_drops_the_oldest_and_deletes_its_content() {
        let tmp = TempDir::new();
        let root = tmp.path();

        // Cap of 3, each save a full interval apart so every one appends.
        let mut minted = Vec::new();
        for i in 0..5u64 {
            let s = snapshot_in(root, DOC, &format!("v{i}"), 3, INTERVAL, T0 + i * 61_000)
                .expect("snapshot")
                .expect("outside the interval");
            minted.push(s);
        }

        let kept = ids(root);
        assert_eq!(kept.len(), 3, "the cap holds");
        assert_eq!(kept, vec![minted[4].id.clone(), minted[3].id.clone(), minted[2].id.clone()]);

        let dir = doc_dir(root, DOC);
        for dropped in &minted[..2] {
            assert!(
                !dir.join(format!("{}.md", dropped.id)).exists(),
                "a pruned snapshot takes its .md with it; orphans would grow the store forever"
            );
        }
        assert!(dir.join(format!("{}.md", minted[4].id)).is_file());
    }

    /// The index must never promise a snapshot whose text has already been erased.
    /// Pruning deletes content, and the `write_meta` that retires those entries is
    /// the step that can fail (a full disk, a scanner holding the file open). If the
    /// content went first and the commit then failed, the surviving index would
    /// still list a version that could no longer be read back, and the frontend
    /// swallows the error, so nobody would be told. Every id the index offers must
    /// resolve to a file.
    #[test]
    fn every_listed_snapshot_can_actually_be_read_back_after_pruning() {
        let tmp = TempDir::new();
        let root = tmp.path();

        for i in 0..8u64 {
            snapshot_in(root, DOC, &format!("v{i}"), 3, INTERVAL, T0 + i * 61_000)
                .expect("snapshot")
                .expect("outside the interval");
        }

        let listed = list_in(root, DOC);
        assert_eq!(listed.len(), 3);
        for s in &listed {
            assert!(
                read_in(root, DOC, &s.id).is_ok(),
                "the index offers {}, so its content must exist",
                s.id
            );
        }
    }

    #[test]
    fn an_oversized_document_is_skipped_entirely() {
        let tmp = TempDir::new();
        let root = tmp.path();

        let huge = "x".repeat(HISTORY_MAX_SNAPSHOT_BYTES + 1);
        assert_eq!(snap(root, &huge, T0), None);
        assert!(list_in(root, DOC).is_empty());
        assert!(!doc_dir(root, DOC).exists(), "and it does not even create the directory");
    }

    #[test]
    fn a_missing_history_reads_as_empty_rather_than_an_error() {
        let tmp = TempDir::new();
        let root = tmp.path();

        assert!(list_in(root, "/nowhere/absent.md").is_empty());
        assert!(read_in(root, "/nowhere/absent.md", "1700000000000").is_err());
        assert!(clear_in(root, "/nowhere/absent.md").is_ok(), "clearing nothing is not a failure");
    }

    #[test]
    fn a_corrupt_index_is_rebuilt_from_the_snapshots_rather_than_discarding_them() {
        let tmp = TempDir::new();
        let root = tmp.path();

        let first = snap(root, "v1", T0).expect("first");
        let second = snap(root, "v2", T0 + 61_000).expect("second");

        let dir = doc_dir(root, DOC);
        std::fs::write(dir.join(META_FILE), "{ this is not json").expect("corrupt the index");

        // No panic, and the user's snapshots are still there.
        let all = list_in(root, DOC);
        assert_eq!(all.len(), 2, "rebuilt from the .md files, which are the real data");
        assert_eq!(all[0].id, second.id, "still newest first");
        assert_eq!(all[1].id, first.id);
        assert_eq!(all[0].bytes, 2, "sizes come back off the filesystem");
        assert_eq!(read_in(root, DOC, &first.id).unwrap(), "v1");

        // And the next save repairs the index instead of stacking on a broken one.
        let third = snap(root, "v3", T0 + 122_000).expect("third");
        assert_eq!(ids(root), vec![third.id, second.id, first.id]);
    }

    #[test]
    fn clearing_removes_every_snapshot_for_that_document_and_no_other() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let other = "/home/ada/notes/other.md";

        snap(root, "v1", T0).expect("first");
        snapshot_in(root, other, "elsewhere", 50, INTERVAL, T0).expect("snapshot").expect("first");

        clear_in(root, DOC).expect("clear");

        assert!(list_in(root, DOC).is_empty());
        assert!(!doc_dir(root, DOC).exists());
        assert_eq!(list_in(root, other).len(), 1, "another document's history is untouched");
    }

    #[test]
    fn a_snapshot_id_can_never_reach_outside_its_own_directory() {
        let tmp = TempDir::new();
        let root = tmp.path();
        snap(root, "v1", T0).expect("first");

        // The id comes back from the frontend, so it is not to be trusted into a path.
        for hostile in ["../../../etc/passwd", "..", "a/b", "meta.json", "1700.md", ""] {
            assert!(!is_valid_id(hostile), "{hostile} is not a snapshot id");
            assert!(read_in(root, DOC, hostile).is_err());
        }
    }

    #[test]
    fn two_documents_never_share_a_history() {
        let tmp = TempDir::new();
        let root = tmp.path();

        assert_ne!(key_for("/a/notes.md"), key_for("/b/notes.md"));
        assert_eq!(key_for(DOC).len(), 32);
        assert!(key_for(DOC).bytes().all(|b| b.is_ascii_hexdigit()));

        snap(root, "left", T0).expect("first");
        snapshot_in(root, "/b/notes.md", "right", 50, INTERVAL, T0).expect("snapshot").expect("first");

        assert_eq!(read_in(root, DOC, &list_in(root, DOC)[0].id).unwrap(), "left");
        assert_eq!(
            read_in(root, "/b/notes.md", &list_in(root, "/b/notes.md")[0].id).unwrap(),
            "right"
        );
    }

    /// Create a real note on disk under `root`, with one snapshot, and return its
    /// absolute path as a string. The document existing is what stops the sweep
    /// from retiring its history, so the other sweep behaviors can be tested.
    fn live_doc(root: &Path, rel: &str, content: &str) -> String {
        let file = root.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, content).unwrap();
        let path = file.to_string_lossy().to_string();
        snapshot_in(root, &path, content, 50, INTERVAL, T0)
            .expect("snapshot")
            .expect("first save records");
        path
    }

    #[test]
    fn the_sweep_deletes_a_stray_temp_file_and_keeps_the_snapshot() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/live.md", "v1");
        let dir = doc_dir(root, &doc);

        // A hard kill mid-write leaves this behind; rebuild_from_dir cannot see it.
        let stray = dir.join(format!("{}.1234.tmp", T0));
        std::fs::write(&stray, "half a snapshot").unwrap();

        sweep_history_in(root, &StoreLock::default());

        assert!(!stray.exists(), "the interrupted-write temp file is reclaimed");
        assert_eq!(list_in(root, &doc).len(), 1, "the real snapshot is untouched");
    }

    #[test]
    fn the_sweep_adopts_a_snapshot_a_crash_left_uncommitted() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/live.md", "v1");
        let dir = doc_dir(root, &doc);

        // Simulate a crash between writing <id>.md and committing meta.json: the
        // content is on disk, but the index still lists only the first snapshot.
        let orphan = (T0 + 61_000).to_string();
        std::fs::write(dir.join(format!("{orphan}.md")), "v2 never committed").unwrap();
        assert!(
            !list_in(root, &doc).iter().any(|s| s.id == orphan),
            "precondition: the index does not list the orphan yet"
        );

        sweep_history_in(root, &StoreLock::default());

        let listed = list_in(root, &doc);
        assert!(listed.iter().any(|s| s.id == orphan), "the orphan is folded into the index");
        assert_eq!(read_in(root, &doc, &orphan).unwrap(), "v2 never committed");
    }

    #[test]
    fn the_sweep_retires_the_history_of_a_deleted_note() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/gone.md", "v1");
        assert!(doc_dir(root, &doc).exists());

        // The user deletes the note; its folder stays.
        std::fs::remove_file(&doc).unwrap();
        sweep_history_in(root, &StoreLock::default());

        assert!(
            !doc_dir(root, &doc).exists(),
            "history of a genuinely deleted note is reclaimed"
        );
    }

    #[test]
    fn the_sweep_keeps_the_history_of_a_note_that_still_exists() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/live.md", "v1");

        sweep_history_in(root, &StoreLock::default());

        assert!(doc_dir(root, &doc).exists(), "a live note keeps its history");
        assert_eq!(read_in(root, &doc, &list_in(root, &doc)[0].id).unwrap(), "v1");
    }

    /// The removable-media guard: a document whose whole volume is unmounted looks
    /// exactly like a deleted file (absent), but its history must NOT be reclaimed,
    /// or unplugging a drive would quietly wipe the version history of everything on
    /// it. The tell is that the PARENT directory is gone too, not just the file.
    #[test]
    fn the_sweep_keeps_history_when_the_volume_is_unmounted() {
        let tmp = TempDir::new();
        let root = tmp.path();

        // Neither the file nor its parent directory exists: the drive is unplugged.
        let doc = format!("{}/unmounted-volume/notes/away.md", root.display());
        snapshot_in(root, &doc, "written on a drive that is now unplugged", 50, INTERVAL, T0)
            .expect("snapshot")
            .expect("first save records");

        sweep_history_in(root, &StoreLock::default());

        assert!(
            doc_dir(root, &doc).exists(),
            "an unreachable volume's history is preserved, not reclaimed"
        );
    }

    #[test]
    fn the_sweep_leaves_a_directory_with_no_meta_alone() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/live.md", "v1");
        let dir = doc_dir(root, &doc);

        // A corrupt/absent index means we cannot know the document path, so the
        // sweep must not judge or delete it. load_meta will rebuild on next open.
        std::fs::remove_file(dir.join(META_FILE)).unwrap();

        sweep_history_in(root, &StoreLock::default());

        assert!(dir.exists(), "a directory without a usable index is left untouched");
        // And its snapshots are still readable once the index is rebuilt on access.
        assert_eq!(list_in(root, &doc).len(), 1);
    }

    #[test]
    fn the_sweep_does_not_rewrite_a_healthy_index() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let doc = live_doc(root, "notes/live.md", "v1");
        let meta_file = doc_dir(root, &doc).join(META_FILE);
        let before = std::fs::read_to_string(&meta_file).unwrap();

        sweep_history_in(root, &StoreLock::default());

        let after = std::fs::read_to_string(&meta_file).unwrap();
        assert_eq!(before, after, "a store with nothing to fix is not rewritten");
    }

    #[test]
    fn the_sweep_survives_an_empty_or_absent_store() {
        let tmp = TempDir::new();
        let root = tmp.path();
        // No history directory at all: must not panic.
        sweep_history_in(root, &StoreLock::default());
        assert!(!root.join(HISTORY_DIR).exists());
    }

    #[test]
    fn should_retire_only_a_confirmed_delete_whose_folder_survives() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let dir = root.join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        let doc = dir.join("note.md");

        // Present file: keep.
        std::fs::write(&doc, "x").unwrap();
        assert!(!should_retire(&doc.to_string_lossy()));

        // Deleted file, folder survives: retire.
        std::fs::remove_file(&doc).unwrap();
        assert!(should_retire(&doc.to_string_lossy()));

        // Whole parent gone (the unmounted-volume tell): keep.
        let ghost = format!("{}/unmounted-volume/notes/away.md", root.display());
        assert!(!should_retire(&ghost));

        // Degenerate paths never retire.
        assert!(!should_retire(""));
        assert!(!should_retire("/"));
    }

    /// The removable-media guard, at the file level: a note that is itself a symlink
    /// to a file on an unmounted volume looks absent to `exists()` (the target is
    /// unreachable) but the link is right there. `symlink_metadata` sees the link, so
    /// its history must be kept, not wiped.
    #[cfg(unix)]
    #[test]
    fn should_not_retire_a_dangling_symlinked_note() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let target = root.join("on-external-drive.md");
        std::fs::write(&target, "x").unwrap();
        let link = root.join("note.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        // The drive is unplugged: the target vanishes, the link remains dangling.
        std::fs::remove_file(&target).unwrap();
        assert!(!link.exists(), "the link's target is unreachable");
        assert!(
            !should_retire(&link.to_string_lossy()),
            "a dangling symlink still names something, so its history is kept"
        );
    }
}
