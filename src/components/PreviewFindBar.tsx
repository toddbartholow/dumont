import { useCallback, useEffect, useRef, useState } from "react";
import { findSpans, isValidPattern } from "../utils/findReplace";

/**
 * Find-in-preview for reader mode (FIND-01). Searches the rendered markdown
 * text nodes and highlights matches with the CSS Custom Highlight API — no DOM
 * mutation, so react-markdown's tree is untouched. On webviews without the
 * Highlight API (none of our targets, but belt-and-braces) navigation still
 * works; only the visual highlight is skipped.
 *
 * Matches that span element boundaries (e.g. "bold**text**") aren't found —
 * acceptable for a reading aid, same trade-off VS Code's webview find makes.
 */

interface PreviewFindBarProps {
    /** The rendered markdown body (App's previewRef / markdownBodyRef). */
    rootRef: React.RefObject<HTMLElement | null>;
    onClose: () => void;
    /** Bump to refocus and select the query on an already-open bar. The VALUE is
     *  meaningless; only that it changed matters. Required for the same reason as
     *  FindReplaceBar's: forgetting it fails silently. */
    focusSignal: number;
}

const MAX_MATCHES = 5000;
const HIGHLIGHT_ALL = "dumont-find";
const HIGHLIGHT_ACTIVE = "dumont-find-active";

type HighlightsRegistry = Map<string, unknown> & {
    set(name: string, highlight: unknown): void;
    delete(name: string): void;
};
const cssHighlights = (): HighlightsRegistry | null => {
    const css = (globalThis as { CSS?: { highlights?: HighlightsRegistry } }).CSS;
    return css?.highlights ?? null;
};

// Matching is the editor bar's (findReplace.ts), applied one text node at a
// time, so Match case and Regex mean the same thing in both views. The one
// difference is inherent: a regex sees a single text node, so `^` and `$`
// anchor to the ends of a run of text, not of a line.
function collectMatches(root: HTMLElement, query: string, caseSensitive: boolean, regex: boolean): Range[] {
    const ranges: Range[] = [];
    if (!query || !isValidPattern(query, regex)) return ranges;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        for (const [start, end] of findSpans((node as Text).data, query, caseSensitive, regex)) {
            const r = new Range();
            r.setStart(node, start);
            r.setEnd(node, end);
            ranges.push(r);
            if (ranges.length >= MAX_MATCHES) return ranges;
        }
    }
    return ranges;
}

function clearHighlights() {
    const reg = cssHighlights();
    if (reg) {
        reg.delete(HIGHLIGHT_ALL);
        reg.delete(HIGHLIGHT_ACTIVE);
    }
}

export function PreviewFindBar({ rootRef, onClose, focusSignal }: PreviewFindBarProps) {
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);
    const [matchCount, setMatchCount] = useState(0);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [regex, setRegex] = useState(false);
    const rangesRef = useRef<Range[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);

    // Highlights are torn down on unmount only, which is why this stays keyed on
    // [] and the focus below is a separate effect.
    useEffect(() => clearHighlights, []);

    // Focus on open, and again on every bump. Unlike the editor's bar this one
    // DOES unmount when closed, so mount covers the open case; the signal is
    // what makes a repeat Mod-f on an already-open bar refocus and select the
    // query instead of doing nothing at all.
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusSignal]);

    // Plain text is trimmed, so a stray space pasted along with a word still
    // finds it. A regex is not: a space in a pattern is part of the pattern.
    const effectiveQuery = regex ? query : query.trim();

    // Recompute matches when the query changes (debounced a touch so typing
    // in the find box doesn't walk the whole document per keystroke).
    useEffect(() => {
        const id = window.setTimeout(() => {
            const root = rootRef.current;
            const ranges = root ? collectMatches(root, effectiveQuery, caseSensitive, regex) : [];
            rangesRef.current = ranges;
            setMatchCount(ranges.length);
            setActiveIdx(0);
            const reg = cssHighlights();
            if (reg) {
                const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
                if (H && ranges.length) reg.set(HIGHLIGHT_ALL, new H(...ranges));
                else reg.delete(HIGHLIGHT_ALL);
                reg.delete(HIGHLIGHT_ACTIVE);
            }
        }, 120);
        return () => window.clearTimeout(id);
    }, [effectiveQuery, caseSensitive, regex, rootRef]);

    // Mark + scroll the active match into view.
    useEffect(() => {
        const ranges = rangesRef.current;
        const r = ranges[activeIdx];
        if (!r) return;
        const reg = cssHighlights();
        const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
        if (reg && H) reg.set(HIGHLIGHT_ACTIVE, new H(r));
        const el = r.startContainer.parentElement;
        el?.scrollIntoView({ block: "center", behavior: "auto" });
    }, [activeIdx, matchCount]);

    const next = useCallback(() => {
        setActiveIdx((i) => (rangesRef.current.length === 0 ? 0 : (i + 1) % rangesRef.current.length));
    }, []);
    const prev = useCallback(() => {
        setActiveIdx((i) => {
            const n = rangesRef.current.length;
            return n === 0 ? 0 : (i - 1 + n) % n;
        });
    }, []);

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

    // Same three states as the editor's bar: a half-typed regex reads as
    // "Invalid pattern" rather than a misleading "No results".
    const patternInvalid = !isValidPattern(effectiveQuery, regex);
    const totalLabel = patternInvalid
        ? "Invalid pattern"
        : matchCount === 0
            ? (effectiveQuery ? "No results" : "")
            : `${activeIdx + 1} of ${matchCount}`;

    return (
        <div
            role="search"
            aria-label="Find in preview"
            className="absolute top-2 right-4 z-40 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl px-2 py-2 flex items-center gap-2 animate-fade-in-down"
            style={{ minWidth: 360 }}
            onKeyDown={handleKey}
        >
            <span className="material-symbols-outlined text-[16px] text-[var(--text-secondary)]">search</span>
            <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find in document"
                aria-label="Find in document"
                className="flex-1 px-2 py-1 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <span className={`text-[11px] tabular-nums whitespace-nowrap min-w-[80px] text-right ${patternInvalid ? "text-[var(--danger-text)]" : "text-[var(--text-secondary)]"}`}>
                {totalLabel}
            </span>
            <button onClick={prev} title="Previous (Shift+Enter)" aria-label="Previous match" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px]">keyboard_arrow_up</span>
            </button>
            <button onClick={next} title="Next (Enter)" aria-label="Next match" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
            </button>
            <button
                type="button"
                onClick={() => setCaseSensitive((v) => !v)}
                aria-pressed={caseSensitive}
                title="Match case"
                aria-label="Match case"
                className={`w-6 h-6 rounded text-[12px] font-bold flex items-center justify-center ${caseSensitive ? "bg-[var(--accent)] text-[var(--accent-text)]" : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}
            >
                Aa
            </button>
            <button
                type="button"
                onClick={() => setRegex((v) => !v)}
                aria-pressed={regex}
                title="Regex"
                aria-label="Regex"
                className={`w-6 h-6 rounded text-[12px] font-mono flex items-center justify-center ${regex ? "bg-[var(--accent)] text-[var(--accent-text)]" : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}
            >
                .*
            </button>
            <button onClick={onClose} title="Close (Esc)" aria-label="Close find" className="w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
        </div>
    );
}
