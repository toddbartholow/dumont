import { useCallback, useEffect, useRef, useState } from "react";
import { attachFocusTrap } from "../utils/focusTrap";
import {
    HISTORY_CHANGED_EVENT,
    clearHistory,
    formatBytes,
    formatSnapshotClock,
    formatSnapshotTime,
    formatSnapshotTimestamp,
    listSnapshots,
    readSnapshot,
    type SnapshotMeta,
} from "../utils/history";

interface HistoryPanelProps {
    isOpen: boolean;
    /** The active document. Null for an unsaved Untitled buffer, which has no
     *  history because it has no path to keep one under. */
    filePath: string | null;
    /** files.history. Off is a real, explained state, not an empty list. */
    enabled: boolean;
    /** Turn files.history on from the panel's disabled state. */
    onEnable: () => void;
    /** Show a snapshot as a proposed change, diffed against the live document, with
     *  a label naming which version it is (the review banner is shared with the AI
     *  flow, so it has to be told). */
    onPreview: (text: string, label: string) => void;
    onError: (message: string) => void;
    onClose: () => void;
}

export function HistoryPanel({
    isOpen,
    filePath,
    enabled,
    onEnable,
    onPreview,
    onError,
    onClose,
}: HistoryPanelProps) {
    const panelRef = useRef<HTMLElement>(null);
    const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [confirmingClear, setConfirmingClear] = useState(false);

    // The clock the list is rendered against. Held in state and ticked once a
    // minute so "2 minutes ago" does not sit there saying "just now" for an hour:
    // the rows are relative times, and a relative time that never re-renders is a
    // lie with a timestamp on it.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!isOpen) return;
        setNow(Date.now());
        const id = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(id);
    }, [isOpen]);

    // Monotonic request id. `list_snapshots` is dispatched on a threadpool, so two
    // in-flight listings CAN land out of order: Ctrl+Tab from a file with a big
    // store to one with a small one and the slow first answer arrives last. What
    // makes that worse than a wrong-looking list is the actions attached to it.
    // Clicking a row would call readSnapshot(currentFile, <other file's id>), and
    // "Clear history for this file" would wipe the history of the document now open
    // while the user is looking at a different document's snapshots.
    const reqIdRef = useRef(0);

    const refresh = useCallback(async () => {
        if (!filePath || !enabled) {
            ++reqIdRef.current;
            setSnapshots([]);
            setLoading(false);
            return;
        }
        const id = ++reqIdRef.current;
        setLoading(true);
        try {
            const found = await listSnapshots(filePath);
            if (reqIdRef.current !== id) return;
            setSnapshots(found);
        } catch {
            // An unreadable store is not worth a toast on a panel the user just
            // opened; the empty state says there is nothing here, which is true.
            if (reqIdRef.current !== id) return;
            setSnapshots([]);
        } finally {
            if (reqIdRef.current === id) setLoading(false);
        }
    }, [filePath, enabled]);

    // Reload on open, on a document switch, and whenever a save actually records a
    // snapshot. Saves that fall inside the interval record nothing and are silent,
    // so this does not fire on every autosave.
    useEffect(() => {
        if (!isOpen) return;
        void refresh();
        const onChanged = (e: Event) => {
            const path = (e as CustomEvent<{ path: string }>).detail?.path;
            if (!path || path === filePath) void refresh();
        };
        window.addEventListener(HISTORY_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(HISTORY_CHANGED_EVENT, onChanged);
    }, [isOpen, filePath, refresh]);

    // A different document has a different history; nothing about the last one's
    // selection or its half-answered confirm prompt should survive the switch.
    useEffect(() => {
        setSelectedId(null);
        setConfirmingClear(false);
    }, [filePath]);

    // Escape closes, focus lands in the panel, Tab stays inside it. Same contract as
    // the outline and the file explorer.
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        panelRef.current?.focus();
        const detachTrap = attachFocusTrap(panelRef.current);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            detachTrap();
        };
    }, [isOpen, onClose]);

    const handleSelect = useCallback(
        async (snapshot: SnapshotMeta) => {
            if (!filePath) return;
            try {
                const text = await readSnapshot(filePath, snapshot.id);
                setSelectedId(snapshot.id);
                // Name the version in the review banner. The banner is shared with
                // Agent mode, where it reads "AI suggested changes", and leaving that
                // in place would credit an AI with the user's own older draft.
                //
                // An absolute clock time, NOT the relative one the rows use. The
                // banner is written once and then sits there for however long the diff
                // takes to work through, so a relative label would rot in place and
                // end up contradicting the very row it came from, which is still
                // ticking a couple of inches away.
                onPreview(text, `Snapshot from ${formatSnapshotClock(snapshot.timestamp)}`);
            } catch {
                onError("Could not read that snapshot");
            }
        },
        [filePath, onPreview, onError],
    );

    const handleClear = useCallback(async () => {
        if (!filePath) return;
        try {
            await clearHistory(filePath);
            setSnapshots([]);
            setSelectedId(null);
        } catch {
            onError("Could not clear the history for this file");
        } finally {
            setConfirmingClear(false);
        }
    }, [filePath, onError]);

    return (
        <aside
            ref={panelRef}
            aria-label="Version history"
            tabIndex={-1}
            // Closed, the panel is only translated off screen. Without these it would
            // stay in the accessibility tree and the tab order: a landmark and a Close
            // button that a screen reader can reach and nobody can see.
            aria-hidden={!isOpen}
            inert={!isOpen}
            className={`fixed left-0 top-12 bottom-7 w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] z-50 shadow-2xl flex flex-col overflow-hidden transition-transform duration-200 ease-out ${isOpen ? "translate-x-0" : "-translate-x-full"
                }`}
        >
            <div className="h-10 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-titlebar)]">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] no-select">
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">history</span>
                    <span>History</span>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close version history"
                    className="btn-press flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                </button>
            </div>

            {!enabled ? (
                // Off is not the same as empty, and must not look like it. An empty
                // list here would read as "this file has no history", which would be a
                // lie of omission: it has none because nothing is recording it.
                <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">history_toggle_off</span>
                    <span className="text-sm text-[var(--text-secondary)]">Version history is off.</span>
                    <span className="text-[11px] text-[var(--text-secondary)]">
                        Turn it on to snapshot each file as you save it. Nothing before now is recorded.
                    </span>
                    <button
                        onClick={onEnable}
                        className="btn-press mt-1 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90 transition-opacity"
                    >
                        Turn on history
                    </button>
                </div>
            ) : !filePath ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">history</span>
                    <span className="text-sm text-[var(--text-secondary)]">Nothing to track yet.</span>
                    <span className="text-[11px] text-[var(--text-secondary)]">Save this file and its history starts here.</span>
                </div>
            ) : (
                <>
                    <div className="flex-1 min-h-0 overflow-y-auto">
                        {snapshots.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-8 px-6 gap-2 text-center">
                                <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">history</span>
                                <span className="text-sm text-[var(--text-secondary)]">
                                    {loading ? "Reading history…" : "No snapshots yet."}
                                </span>
                                {!loading && (
                                    <span className="text-[11px] text-[var(--text-secondary)]">
                                        A version is kept each time you save this file.
                                    </span>
                                )}
                            </div>
                        ) : (
                            <ul className="py-2">
                                {snapshots.map((snapshot, index) => {
                                    const isSelected = snapshot.id === selectedId;
                                    return (
                                        <li key={snapshot.id}>
                                            <button
                                                onClick={() => void handleSelect(snapshot)}
                                                title={formatSnapshotTimestamp(snapshot.timestamp)}
                                                aria-current={isSelected ? "true" : undefined}
                                                className={`btn-press w-full px-4 py-2 text-left flex items-center justify-between gap-2 transition-colors ${isSelected
                                                    ? "bg-[var(--bg-hover)] text-[var(--text-primary)] border-l-2 border-[var(--focus-ring)] -ml-px"
                                                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                                    }`}
                                            >
                                                <span className="flex flex-col min-w-0">
                                                    <span className="text-sm truncate">
                                                        {formatSnapshotTime(snapshot.timestamp, now)}
                                                    </span>
                                                    {index === 0 && (
                                                        <span className="text-[11px] text-[var(--text-secondary)]">Latest</span>
                                                    )}
                                                </span>
                                                <span className="text-[11px] text-[var(--text-secondary)] shrink-0 tabular-nums">
                                                    {formatBytes(snapshot.bytes)}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>

                    <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
                        <p className="mb-2 text-[11px] text-[var(--text-secondary)] leading-snug">
                            A snapshot opens as a proposed change: accept the parts you want, then save.
                        </p>
                        {confirmingClear ? (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => void handleClear()}
                                    // --danger is a FILL token (3:1). Text needs --danger-text,
                                    // which clears 4.5:1 on paper, dracula and vs2017 where
                                    // --danger does not.
                                    className="btn-press flex-1 px-2 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border border-[var(--danger)] text-[var(--danger-text)] hover:bg-[var(--bg-hover)] transition-colors"
                                >
                                    Clear history
                                </button>
                                <button
                                    onClick={() => setConfirmingClear(false)}
                                    className="btn-press flex-1 px-2 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => setConfirmingClear(true)}
                                disabled={snapshots.length === 0}
                                className="btn-press w-full px-2 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                            >
                                Clear history for this file
                            </button>
                        )}
                    </div>
                </>
            )}
        </aside>
    );
}
