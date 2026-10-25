import { useEffect, useRef } from "react";

interface ConflictBarProps {
    fileName: string;
    /** Replace the buffer with what is on disk, discarding the unsaved edits. */
    onReload: () => void;
    /** Write the buffer over what is on disk. */
    onKeepMine: () => void;
    /** Bumped to move keyboard focus to the bar (Ctrl+S on a conflicted document). */
    focusSignal: number;
}

/**
 * Shown above the editor while the open file has changed on disk AND the buffer has edits
 * of its own. Autosave is parked for the document until one of these two is chosen: neither
 * version is obviously the one to keep, so the app does not pick for the user. EXT-03.
 */
export function ConflictBar({ fileName, onReload, onKeepMine, focusSignal }: ConflictBarProps) {
    const firstRef = useRef<HTMLButtonElement>(null);
    // Only a CHANGE moves focus. The counter outlives the bar, and a bar that appears on its
    // own (a refused autosave) must not pull the caret out of the editor mid-sentence.
    const seenSignal = useRef(focusSignal);
    useEffect(() => {
        if (focusSignal === seenSignal.current) return;
        seenSignal.current = focusSignal;
        firstRef.current?.focus();
    }, [focusSignal]);

    return (
        <div
            role="alert"
            className="flex items-center gap-2 px-3 h-9 shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--focus-ring)] text-xs no-select"
        >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]"></span>
            <span className="text-[var(--text-primary)] font-medium truncate">"{fileName}" changed on disk.</span>
            <span className="text-[var(--text-secondary)] hidden sm:inline">Autosave is paused until you choose:</span>
            <div className="ml-auto flex items-center gap-1.5">
                <button
                    ref={firstRef}
                    onClick={onReload}
                    className="px-2.5 py-1 rounded-[var(--radius-sm)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                    Reload from disk
                </button>
                <button
                    onClick={onKeepMine}
                    className="px-2.5 py-1 rounded-[var(--radius-sm)] font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90 transition-colors"
                >
                    Keep my version
                </button>
            </div>
        </div>
    );
}
