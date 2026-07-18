import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { attachFocusTrap } from "../utils/focusTrap";
import { toWikiName } from "../utils/wikilinkComplete";

/** One `[[wikilink]]` pointing at the current note. Mirrors Rust's BacklinkMatch. */
interface BacklinkMatch {
    /** 1-based line number in the linking file. */
    line: number;
    text: string;
    /** The `alias` half of `[[target|alias]]`, or null. */
    alias: string | null;
}

/** All the links to the current note found in one file. Mirrors Rust's BacklinkResult. */
interface BacklinkResult {
    path: string;
    name: string;
    matches: BacklinkMatch[];
}

interface BacklinksPanelProps {
    isOpen: boolean;
    /** The open file's full path. Its folder is the only folder scanned. */
    currentFilePath: string | null;
    /** The open file's basename. The wiki name is this, minus the extension. */
    currentFileName: string | null;
    /** Bumped by App after every successful save, to re-run the scan. */
    refreshKey?: number;
    /** Open a linking file at the line the link sits on. */
    onOpenResult: (path: string, line: number) => void;
    onClose: () => void;
}

/** The folder a path lives in, or null for a bare/unsaved name. */
function getDirectory(filePath: string | null): string | null {
    if (!filePath) return null;
    const normalized = filePath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? filePath.substring(0, lastSlash) : null;
}

/**
 * Linked mentions: every `[[wikilink]]` in this folder that points at the open
 * note.
 *
 * SAME FOLDER, ONE LEVEL. That is the resolver's rule, not a shortcut: a
 * `[[Foo]]` written in `sub/Baz.md` opens `sub/Foo.md`, so it is a backlink of
 * that note and not of the `Foo.md` sitting one level up. See find_backlinks in
 * src-tauri/src/commands.rs.
 */
export function BacklinksPanel({
    isOpen,
    currentFilePath,
    currentFileName,
    refreshKey = 0,
    onOpenResult,
    onClose,
}: BacklinksPanelProps) {
    const [results, setResults] = useState<BacklinkResult[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const panelRef = useRef<HTMLElement>(null);
    // Monotonic request id: a slow early scan must not overwrite a faster later
    // one (switch tabs quickly and the stale answer would win). Same guard as
    // GlobalSearch's.
    const reqIdRef = useRef(0);

    const directory = useMemo(() => getDirectory(currentFilePath), [currentFilePath]);
    const noteName = useMemo(
        () => (currentFileName ? toWikiName(currentFileName) : ""),
        [currentFileName]
    );

    const totalMatches = results.reduce((n, r) => n + r.matches.length, 0);

    const loadBacklinks = useCallback(async () => {
        if (!directory || !noteName) {
            // Bump the id even though there is nothing to fetch. This branch is a
            // real state change (the document has no path, so it can have no
            // backlinks) and it has to SUPERSEDE any scan still in flight. Without
            // the bump, switching from a note in a large folder to an unsaved
            // Untitled buffer lets the old scan land afterwards, and the panel fills
            // with the previous document's mentions above a file they say nothing
            // about, with rows that navigate somewhere unrelated.
            ++reqIdRef.current;
            setResults([]);
            setIsLoading(false);
            setError(null);
            return;
        }
        const id = ++reqIdRef.current;
        setIsLoading(true);
        try {
            const found = await invoke<BacklinkResult[]>("find_backlinks", {
                directory,
                noteName,
            });
            if (reqIdRef.current !== id) return;
            setResults(found);
            setError(null);
        } catch (err) {
            if (reqIdRef.current !== id) return;
            console.error("Failed to find backlinks:", err);
            setResults([]);
            setError(typeof err === "string" ? err : "Could not load backlinks");
        } finally {
            if (reqIdRef.current === id) setIsLoading(false);
        }
    }, [directory, noteName]);

    // Debounced scan. Runs on open, on a file switch, and after a save of some OTHER
    // file (which is what refreshKey moves). The debounce matters because switching
    // tabs with Ctrl+Tab held down would otherwise fire one directory walk per tab.
    //
    // The loading flag is raised HERE, before the timer, not inside loadBacklinks.
    // Raising it there leaves the panel rendering its empty state for the debounce
    // window, so opening the panel on a note with a dozen backlinks flashes "No notes
    // link here yet." first. That is not a flicker, it is a false statement about the
    // user's notes, and it is the one the panel exists to answer.
    useEffect(() => {
        if (!isOpen) return;
        if (directory && noteName) setIsLoading(true);
        const handle = window.setTimeout(() => {
            void loadBacklinks();
        }, 150);
        return () => window.clearTimeout(handle);
    }, [isOpen, directory, noteName, loadBacklinks, refreshKey]);

    // Refresh when the window regains focus: another app (or another Dumont
    // window) may have added a link to this note while the panel sat open.
    useEffect(() => {
        if (!isOpen) return;
        const onFocus = () => { void loadBacklinks(); };
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [isOpen, loadBacklinks]);

    // Escape to close, plus focus management and a focus trap.
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

    return (
        <aside
            ref={panelRef}
            aria-label="Backlinks"
            tabIndex={-1}
            className={`fixed left-0 top-12 bottom-7 w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] z-50 shadow-2xl flex flex-col overflow-hidden ${
                isOpen ? "translate-x-0" : "-translate-x-full"
            }`}
        >
            {/* Header */}
            <div className="h-10 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-titlebar)]">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] no-select">
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                        link
                    </span>
                    <span>Backlinks</span>
                    {totalMatches > 0 && (
                        <span className="text-xs font-normal text-[var(--text-secondary)] tabular-nums">
                            {totalMatches}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => { void loadBacklinks(); }}
                        aria-label="Refresh backlinks"
                        title="Refresh"
                        className="btn-press flex items-center justify-center w-7 h-7 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        <span className="material-symbols-outlined text-[18px]">refresh</span>
                    </button>
                    <button
                        onClick={onClose}
                        aria-label="Close backlinks"
                        className="btn-press flex items-center justify-center w-7 h-7 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {isLoading && results.length === 0 ? (
                    <div className="flex items-center justify-center h-32 text-[var(--text-secondary)] text-sm">
                        Loading...
                    </div>
                ) : error ? (
                    <div
                        className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center text-sm"
                        role="alert"
                    >
                        <span
                            aria-hidden="true"
                            className="material-symbols-outlined text-[40px] text-[var(--text-muted)]"
                        >
                            error_outline
                        </span>
                        {/* --danger-text, not --danger: the fill token drops below 4.5:1
                            as text on paper / dracula / vs2017. */}
                        <span className="text-[var(--danger-text)]">{error}</span>
                    </div>
                ) : results.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center text-sm text-[var(--text-secondary)]">
                        <span
                            aria-hidden="true"
                            className="material-symbols-outlined text-[40px] text-[var(--text-muted)]"
                        >
                            link_off
                        </span>
                        <span>No notes link here yet.</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">
                            Write{" "}
                            <code className="font-mono">[[{noteName || "Note"}]]</code> in another
                            note in this folder.
                        </span>
                    </div>
                ) : (
                    <div className="py-2">
                        {results.map((file) => (
                            <div key={file.path} className="mb-1">
                                <div className="px-4 py-1 flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                                    <span
                                        aria-hidden="true"
                                        className="material-symbols-outlined text-[14px]"
                                    >
                                        description
                                    </span>
                                    <span className="truncate" title={file.name}>
                                        {file.name}
                                    </span>
                                </div>
                                <ul aria-label={`Links in ${file.name}`}>
                                    {file.matches.map((m, i) => (
                                        <li key={`${file.path}:${m.line}:${i}`}>
                                            <button
                                                onClick={() => onOpenResult(file.path, m.line)}
                                                title={m.text}
                                                className="btn-press w-full text-left pl-6 pr-4 py-1.5 flex items-baseline gap-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                                            >
                                                <span className="shrink-0 tabular-nums text-xs text-[var(--text-secondary)]">
                                                    {m.line}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-mono text-[13px]">
                                                        {m.text}
                                                    </span>
                                                    {m.alias && (
                                                        <span className="block truncate text-[11px] text-[var(--text-secondary)]">
                                                            as &ldquo;{m.alias}&rdquo;
                                                        </span>
                                                    )}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}
