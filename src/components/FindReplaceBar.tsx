import { useEffect, useRef, useState, useCallback } from "react";
import { findAll, matchLength, replaceOne, replaceAllMatches, isValidPattern } from "../utils/findReplace";

interface FindReplaceBarProps {
    isOpen: boolean;
    initialMode?: "find" | "replace";
    content: string;
    selectionStart: number;
    onClose: () => void;
    onReplace: (newContent: string, newCursor: number) => void;
    onJumpTo: (start: number, end: number) => void;
}

interface MatchResult {
    matches: number[];
    activeIdx: number;
}

export function FindReplaceBar({
    isOpen,
    initialMode = "find",
    content,
    selectionStart,
    onClose,
    onReplace,
    onJumpTo,
}: FindReplaceBarProps) {
    const [query, setQuery] = useState("");
    const [replacement, setReplacement] = useState("");
    const [showReplace, setShowReplace] = useState(initialMode === "replace");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [regex, setRegex] = useState(false);
    const [match, setMatch] = useState<MatchResult>({ matches: [], activeIdx: -1 });
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            inputRef.current?.focus();
            inputRef.current?.select();
            setShowReplace(initialMode === "replace");
        } else {
            // Drop the matches when the bar closes, and this is load-bearing rather
            // than tidy. This component never unmounts (CodeEditor renders it
            // unconditionally, and the CodeEditor itself has no `key`, so it survives a
            // tab switch), so `match` would otherwise persist across a close, a
            // document edit, and even a change of document. On reopen, the auto-jump
            // effect below sees a leftover `activeIdx >= 0` and fires immediately,
            // before the fresh search can run: pressing Ctrl+S then Ctrl+F would scroll
            // you back to a match you dismissed ten minutes ago. Worse, if the document
            // has shrunk since (a shorter tab, or you selected all and deleted), the
            // stale offset is past the end of it and CodeMirror throws
            // "Selection points outside of document", which unwinds out of a passive
            // effect and into the error boundary. Clearing here means reopen always
            // starts from activeIdx === -1 and the first jump comes from a real search.
            setMatch({ matches: [], activeIdx: -1 });
        }
    }, [isOpen, initialMode]);

    // Recompute matches when query or content changes. Bail out by returning
    // `prev` when nothing changed — without this, every editor keystroke causes
    // setMatch to mint a fresh `{ matches: [], activeIdx: -1 }` for an empty
    // query, which re-renders this dialog (and re-fires the auto-jump effect
    // below) on every character typed in the editor.
    useEffect(() => {
        // A CLOSED find bar must not search, and must not jump the caret.
        //
        // This component is mounted unconditionally by CodeEditor and only hides
        // itself with `if (!isOpen) return null` further down, so without this guard
        // its effects keep running after Escape. The query is not cleared on close
        // either, so every keystroke re-ran findAll against the old query, and when an
        // edit shifted a match's offset the bail-out below failed, `match` changed
        // identity, and the auto-jump effect fired onJumpTo: the caret was yanked out
        // from under the user, mid-sentence, to a match they had dismissed. Worse,
        // `selectionStart` is only sampled when Ctrl+F is pressed, so which match it
        // jumped to was arbitrary.
        if (!isOpen) return;
        // Debounce a touch: recomputing on every keystroke is fine for plain
        // text but a pathological regex (e.g. catastrophic backtracking) over a
        // large document shouldn't run once per typed character.
        const id = window.setTimeout(() => {
        const m = findAll(content, query, caseSensitive, regex);
        setMatch((prev) => {
            let active = -1;
            if (m.length > 0) {
                active = m.findIndex((pos) => pos >= selectionStart);
                if (active === -1) active = 0;
                if (prev.activeIdx >= 0 && prev.activeIdx < m.length && prev.matches[prev.activeIdx] === m[prev.activeIdx]) {
                    active = prev.activeIdx;
                }
            }
            // Same activeIdx + same-length + same-positions ⇒ nothing changed.
            if (
                prev.activeIdx === active &&
                prev.matches.length === m.length &&
                prev.matches.every((pos, i) => pos === m[i])
            ) {
                return prev;
            }
            return { matches: m, activeIdx: active };
        });
        }, 100);
        return () => window.clearTimeout(id);
    }, [isOpen, content, query, caseSensitive, regex, selectionStart]);

    // Auto-jump to active match. Guarded on isOpen for the same reason as above: this
    // is the effect that actually moves the caret, so it is the one that must not run
    // for a bar the user has closed.
    useEffect(() => {
        if (!isOpen) return;
        if (match.activeIdx === -1) return;
        const start = match.matches[match.activeIdx];
        const len = matchLength(content, start, query, caseSensitive, regex);
        if (len > 0) onJumpTo(start, start + len);
        // We intentionally don't depend on onJumpTo to avoid loops
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, match.activeIdx, match.matches]);

    const next = useCallback(() => {
        setMatch((prev) => {
            if (prev.matches.length === 0) return prev;
            return { ...prev, activeIdx: (prev.activeIdx + 1) % prev.matches.length };
        });
    }, []);

    const prev = useCallback(() => {
        setMatch((prevState) => {
            if (prevState.matches.length === 0) return prevState;
            const next = prevState.activeIdx <= 0 ? prevState.matches.length - 1 : prevState.activeIdx - 1;
            return { ...prevState, activeIdx: next };
        });
    }, []);

    const replaceCurrent = useCallback(() => {
        if (match.activeIdx === -1) return;
        const res = replaceOne(content, match.matches[match.activeIdx], query, replacement, caseSensitive, regex);
        if (res) onReplace(res.content, res.cursor);
    }, [match, content, query, replacement, caseSensitive, regex, onReplace]);

    const replaceAll = useCallback(() => {
        const res = replaceAllMatches(content, match.matches, query, replacement, caseSensitive, regex);
        if (res) onReplace(res.content, res.cursor);
    }, [match, content, query, replacement, caseSensitive, regex, onReplace]);

    const handleKey = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            onClose();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
        }
    };

    if (!isOpen) return null;

    // A broken regex and a regex that simply matches nothing both yield an empty
    // result set; tell them apart so a half-typed pattern reads as "Invalid
    // pattern" (in the danger color) instead of a misleading "No results".
    const patternInvalid = !isValidPattern(query, regex);
    const totalLabel = patternInvalid
        ? "Invalid pattern"
        : match.matches.length === 0
            ? "No results"
            : `${match.activeIdx + 1} of ${match.matches.length}`;

    return (
        <div
            role="dialog"
            aria-label="Find and replace"
            className="absolute top-2 right-4 z-40 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl px-2 py-2 flex flex-col gap-2 animate-fade-in-down"
            style={{ minWidth: 360 }}
            onKeyDown={handleKey}
        >
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setShowReplace((v) => !v)}
                    aria-label={showReplace ? "Hide replace" : "Show replace"}
                    className="flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                >
                    <span className="material-symbols-outlined text-[16px]">
                        {showReplace ? "expand_less" : "expand_more"}
                    </span>
                </button>
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find"
                    className="flex-1 px-2 py-1 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    aria-label="Find text"
                />
                <span className={`text-[11px] tabular-nums whitespace-nowrap min-w-[80px] text-right ${patternInvalid ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"}`}>
                    {totalLabel}
                </span>
                <button onClick={prev} title="Previous (Shift+Enter)" aria-label="Previous match" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[16px]">keyboard_arrow_up</span>
                </button>
                <button onClick={next} title="Next (Enter)" aria-label="Next match" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
                </button>
                <button
                    onClick={() => setCaseSensitive((v) => !v)}
                    aria-pressed={caseSensitive}
                    title="Match case"
                    className={`w-6 h-6 rounded text-[12px] font-bold flex items-center justify-center ${caseSensitive ? "bg-[var(--accent)] text-[var(--accent-text)]" : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}
                >
                    Aa
                </button>
                <button
                    onClick={() => setRegex((v) => !v)}
                    aria-pressed={regex}
                    title="Regex"
                    className={`w-6 h-6 rounded text-[12px] font-mono flex items-center justify-center ${regex ? "bg-[var(--accent)] text-[var(--accent-text)]" : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}
                >
                    .*
                </button>
                <button onClick={onClose} title="Close (Esc)" aria-label="Close find" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
            </div>

            {showReplace && (
                <div className="flex items-center gap-2 pl-8">
                    <input
                        type="text"
                        value={replacement}
                        onChange={(e) => setReplacement(e.target.value)}
                        placeholder="Replace"
                        className="flex-1 px-2 py-1 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        aria-label="Replace with"
                    />
                    <button
                        onClick={replaceCurrent}
                        disabled={match.activeIdx === -1}
                        className="px-2 py-1 text-xs rounded bg-[var(--bg-input)] border border-[var(--border)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Replace
                    </button>
                    <button
                        onClick={replaceAll}
                        disabled={match.matches.length === 0}
                        className="px-2 py-1 text-xs rounded bg-[var(--bg-input)] border border-[var(--border)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Replace All
                    </button>
                </div>
            )}
        </div>
    );
}
