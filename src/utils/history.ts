/**
 * Local version history: the frontend half.
 *
 * Rust owns the store (src-tauri/src/history.rs) and knows nothing about
 * settings; this module owns the settings and knows nothing about the disk. The
 * two limits that make coalescing work travel from here to there as arguments on
 * every call, because settings.json is parsed, coerced and understood in exactly
 * one place and it is not Rust.
 */
import { invoke } from "@tauri-apps/api/core";

/** One snapshot. `timestamp` is ms since the epoch, and is also the id. */
export interface SnapshotMeta {
    id: string;
    timestamp: number;
    bytes: number;
}

/** Fired after a save has been recorded, so an open History panel can refresh. */
export const HISTORY_CHANGED_EVENT = "dumont:history-changed";

export interface HistoryConfig {
    enabled: boolean;
    /** Snapshots kept per file (files.historyLimit). */
    limit: number;
    /** Seconds; a save inside this window of the newest snapshot is not recorded
     *  at all (files.historyInterval). */
    intervalSecs: number;
}

/**
 * The live history settings, mirrored outside React.
 *
 * `saveDocument(path, content)` is called from seven places, one of which is a
 * hook and none of which should have to thread three preference values through to
 * reach it. So App pushes the settings here whenever they change and the save path
 * reads them, the same registry pattern `schema.ts` uses for the known theme ids.
 *
 * It starts DISABLED, and would have to even if `files.history` defaulted to true:
 * "nobody has told us the settings yet" and "the user wants history" are different
 * states, and only one of them may write to the user's disk. App configures it on
 * mount, long before any save can happen.
 */
let config: HistoryConfig = { enabled: false, limit: 50, intervalSecs: 60 };

export function setHistoryConfig(next: HistoryConfig): void {
    config = next;
}

/**
 * Record a save, if history is on. Never throws.
 *
 * A snapshot is a nicety; the save is the thing the user asked for. If the store
 * is unwritable (a full disk, a locked data directory, a sandbox that never gave
 * us one) the right outcome is that saving keeps working and history quietly does
 * not, NOT a toast on every keystroke telling the user about a directory they have
 * never heard of.
 *
 * The returned promise is here to be IGNORED by almost every caller: that is what
 * makes the snapshot fire-and-forget, and it already resolves rather than rejects on
 * failure. It is returned only so the one caller that is about to destroy the window
 * can wait for the write to land before the process goes away. See `saveDocument`.
 */
export function recordSnapshot(path: string, content: string): Promise<void> {
    const { enabled, limit, intervalSecs } = config;
    if (!enabled) return Promise.resolve();

    return invoke<SnapshotMeta | null>("snapshot_file", {
        path,
        content,
        maxSnapshots: limit,
        minIntervalSecs: intervalSecs,
    })
        .then((created) => {
            // null means the store did not change: the save fell inside the interval,
            // or its content was identical, or the file was too big. Announcing those
            // would make an open panel re-read the disk on every autosave, every 1.5 s
            // of typing, only to render the same list back.
            if (!created) return;
            window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: { path } }));
        })
        .catch(() => {
            /* history is best-effort; a save must never fail because of it */
        });
}

export function listSnapshots(path: string): Promise<SnapshotMeta[]> {
    return invoke<SnapshotMeta[]>("list_snapshots", { path });
}

export function readSnapshot(path: string, id: string): Promise<string> {
    return invoke<string>("read_snapshot", { path, id });
}

export function clearHistory(path: string): Promise<void> {
    return invoke<void>("clear_history", { path });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const clock = (d: Date): string =>
    `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;

/** Whole calendar days between two instants, by local midnight (not by 24h blocks:
 *  23:59 and 00:01 are a day apart to a human and two minutes apart to a clock). */
function daysApart(then: Date, now: Date): number {
    const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((b - a) / 86_400_000);
}

/**
 * How a snapshot's age reads in the list: relative while that is the useful frame,
 * absolute once it stops being ("3 hours ago" is helpful, "50 hours ago" is not).
 *
 * `now` is injectable so the tests are not at the mercy of the wall clock.
 */
export function formatSnapshotTime(timestamp: number, now: number = Date.now()): string {
    const then = new Date(timestamp);
    const secs = Math.max(0, Math.floor((now - timestamp) / 1000));

    if (secs < 10) return "just now";
    if (secs < 60) return `${secs} seconds ago`;

    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;

    const days = daysApart(then, new Date(now));
    if (days === 0) {
        const hours = Math.floor(mins / 60);
        return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
    }
    if (days === 1) return `yesterday ${clock(then)}`;

    const sameYear = then.getFullYear() === new Date(now).getFullYear();
    const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
    return sameYear
        ? `${date} ${clock(then)}`
        : `${date} ${then.getFullYear()} ${clock(then)}`;
}

/**
 * A snapshot's age as an ALWAYS-ABSOLUTE clock time, for the review banner.
 *
 * The list can afford to be relative because it re-renders on a one-minute tick.
 * The banner cannot: it is set once, when the snapshot is opened as a proposed
 * change, and then sits there for as long as the user takes to work through the
 * diff. A relative label would freeze at the moment of the click and slowly rot,
 * until the banner says "2 minutes ago" while the row it came from, ticking away
 * two inches to its left, says "17 minutes ago". A clock time is also the more
 * useful thing to state there: the banner's job is to name WHICH version is on
 * offer, not to keep announcing how old it is.
 */
export function formatSnapshotClock(timestamp: number, now: number = Date.now()): string {
    const then = new Date(timestamp);
    const days = daysApart(then, new Date(now));

    if (days === 0) return `today at ${clock(then)}`;
    if (days === 1) return `yesterday at ${clock(then)}`;

    const sameYear = then.getFullYear() === new Date(now).getFullYear();
    const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
    return sameYear
        ? `${date} at ${clock(then)}`
        : `${date} ${then.getFullYear()} at ${clock(then)}`;
}

/** The exact moment, for the row's tooltip. */
export function formatSnapshotTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
