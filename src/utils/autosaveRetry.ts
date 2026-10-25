/**
 * What an autosave does after a failed write: when to try again, and when to tell the user.
 * Shared by the active tab's autosave (useAutosave) and the background tabs' (App).
 *
 * Neither used to retry. Both re-run only when the text changes, so a write that failed once
 * (a full disk, a network share that dropped for a moment) stayed failed until the user typed
 * again, and in a background tab nobody types. The background path did not even say so: it
 * swallowed every error, and the tab sat dirty with no message. SAVE-03.
 */

/** Don't surface a failure for the same document more than once per this window. */
export const AUTOSAVE_ERROR_THROTTLE_MS = 30_000;

/** First retry after this long, doubling each time, up to the cap. */
const RETRY_BASE_MS = 2_000;
/** The backoff stops growing here, and keeps retrying at this interval. A dirty document is
 *  never abandoned: the dirty dot stays, and closing still asks, until a write lands. */
export const AUTOSAVE_RETRY_MAX_MS = 60_000;

export interface AutosaveFailure {
    /** Consecutive failed writes. */
    attempts: number;
    /** When the next retry is due (ms since epoch). */
    retryAt: number;
    /** When the last failure was shown to the user, or 0. */
    toastedAt: number;
}

/** Delay before retry number `attempts` (1 = after the first failure). */
export function autosaveRetryDelay(attempts: number): number {
    return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), AUTOSAVE_RETRY_MAX_MS);
}

/** Fold one more failed write into the record, and say whether to tell the user. */
export function recordAutosaveFailure(
    prev: AutosaveFailure | undefined,
    now: number
): { failure: AutosaveFailure; notify: boolean } {
    const attempts = (prev?.attempts ?? 0) + 1;
    const notify = !prev || now - prev.toastedAt >= AUTOSAVE_ERROR_THROTTLE_MS;
    return {
        failure: { attempts, retryAt: now + autosaveRetryDelay(attempts), toastedAt: notify || !prev ? now : prev.toastedAt },
        notify,
    };
}
