/**
 * Bidirectional scroll-fraction sync.
 *
 * Each side (code editor textarea, preview <main>) registers a "scroller"
 * with a `setFraction(0..1)` method. When one side scrolls, we compute its
 * fraction and apply it to the other.
 *
 * To avoid feedback loops, when we set a fraction programmatically on side X
 * we mark X as "ignoring" for a short window — its native scroll handler may
 * fire from the imperative scrollTop change, but we drop that echo.
 */

export interface Scroller {
    setFraction: (fraction: number) => void;
}

export type SyncSide = "code" | "preview";

export interface ScrollSync {
    /** Side X registers its imperative scroller. */
    register: (side: SyncSide, scroller: Scroller | null) => void;
    /** Side X reports a user-driven scroll. */
    notify: (side: SyncSide, fraction: number) => void;
    /** Disable / enable syncing (used to turn off in non-split modes). */
    setEnabled: (enabled: boolean) => void;
}

export function createScrollSync(): ScrollSync {
    const scrollers: Record<SyncSide, Scroller | null> = { code: null, preview: null };
    const ignore: Record<SyncSide, boolean> = { code: false, preview: false };
    let enabled = false;
    const ignoreTimers: Record<SyncSide, number | null> = { code: null, preview: null };

    const setIgnore = (side: SyncSide) => {
        ignore[side] = true;
        if (ignoreTimers[side] !== null) {
            window.clearTimeout(ignoreTimers[side] as number);
        }
        ignoreTimers[side] = window.setTimeout(() => {
            ignore[side] = false;
            ignoreTimers[side] = null;
        }, 80);
    };

    return {
        register: (side, scroller) => {
            scrollers[side] = scroller;
        },
        notify: (side, fraction) => {
            if (!enabled) return;
            if (ignore[side]) return; // this scroll was triggered by our own programmatic sync
            const otherSide: SyncSide = side === "code" ? "preview" : "code";
            const other = scrollers[otherSide];
            if (!other) return;
            setIgnore(otherSide); // we're about to scroll the other side; suppress its echo
            other.setFraction(Math.max(0, Math.min(1, fraction)));
        },
        setEnabled: (e) => {
            enabled = e;
        },
    };
}
