import { useEffect, useId, useMemo, useRef, useState } from "react";
import { attachFocusTrap } from "../utils/focusTrap";

export interface PaletteCommand {
    id: string;
    label: string;
    /** Optional secondary description shown on the right (path, shortcut, etc). */
    hint?: string;
    /** Section label — items are grouped by this. */
    section: string;
    /** Material symbol icon name. */
    icon?: string;
    /** Extra search keywords (not visible). */
    keywords?: string;
    run: () => void;
}

interface CommandPaletteProps {
    isOpen: boolean;
    items: PaletteCommand[];
    onClose: () => void;
}

/** Indices in `haystack` that `needle` matches, mirroring fuzzyScore's logic
 *  (substring first, then subsequence). Returns null when there's no match, so
 *  callers can fall back to the plain label. */
function matchIndices(needle: string, haystack: string): number[] | null {
    if (!needle) return null;
    const n = needle.toLowerCase();
    const h = haystack.toLowerCase();
    const sub = h.indexOf(n);
    if (sub !== -1) {
        return Array.from({ length: n.length }, (_, i) => sub + i);
    }
    const out: number[] = [];
    let hi = 0;
    for (let ni = 0; ni < n.length; ni++) {
        const found = h.indexOf(n[ni], hi);
        if (found === -1) return null;
        out.push(found);
        hi = found + 1;
    }
    return out;
}

/** Render `label` with the characters matched by `query` accented, so it's
 *  obvious why a result ranked where it did. Coalesces adjacent matched/plain
 *  characters into runs to keep the node count down. */
function highlightLabel(label: string, query: string): React.ReactNode {
    const q = query.trim();
    if (!q) return label;
    const idx = matchIndices(q, label);
    if (!idx) return label;
    const matched = new Set(idx);
    const parts: React.ReactNode[] = [];
    let buf = "";
    let bufMatched = matched.has(0);
    const flush = (key: number) => {
        if (!buf) return;
        parts.push(
            bufMatched
                ? <mark key={key} className="bg-transparent text-[var(--accent)] font-semibold">{buf}</mark>
                : <span key={key}>{buf}</span>
        );
        buf = "";
    };
    for (let i = 0; i < label.length; i++) {
        const m = matched.has(i);
        if (i > 0 && m !== bufMatched) {
            flush(i);
            bufMatched = m;
        }
        buf += label[i];
    }
    flush(label.length);
    return parts;
}

/** Tiny fzf-style ranker. Returns -1 for no match, otherwise a score (lower = better). */
function fuzzyScore(needle: string, haystack: string): number {
    if (!needle) return 0;
    const n = needle.toLowerCase();
    const h = haystack.toLowerCase();
    if (h.includes(n)) return h.indexOf(n); // substring match — best
    let hi = 0;
    let score = 0;
    let lastIdx = -1;
    for (let ni = 0; ni < n.length; ni++) {
        const ch = n[ni];
        const found = h.indexOf(ch, hi);
        if (found === -1) return -1;
        if (lastIdx !== -1) score += (found - lastIdx);
        lastIdx = found;
        hi = found + 1;
    }
    return 1000 + score; // worse than substring matches
}

export function CommandPalette({ isOpen, items, onClose }: CommandPaletteProps) {
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);
    const dialogRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    // Whether the pending activeIdx change should scroll the list. Only the
    // keyboard cursor may move it — see the scroll effect below.
    const scrollActiveRef = useRef(true);
    // The list's scrollTop when the pointer went down on a row, so pointerup can
    // tell a choice from a drag-scroll.
    const pressScrollRef = useRef<number | null>(null);

    const baseId = useId();
    const listboxId = `${baseId}-listbox`;
    const optionId = (i: number) => `${baseId}-opt-${i}`;

    // Reset state on open
    useEffect(() => {
        if (isOpen) {
            setQuery("");
            setActiveIdx(0);
        }
    }, [isOpen]);

    // Focus input + trap, Escape to close
    useEffect(() => {
        if (!isOpen) return;
        // Trap first (captures the trigger for focus-restore on close), then
        // move focus into the search input. UX-01.
        const detach = attachFocusTrap(dialogRef.current);
        const input = dialogRef.current?.querySelector<HTMLInputElement>("input");
        input?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        // End the press wherever it ends. A row's pointerup clears its own stamp,
        // but a press released outside the list, or cancelled because a touch
        // became a pan, would leave it behind — and a stale stamp reads exactly
        // like a fresh one, so the next release over a row would run a command the
        // user never pressed. These fire after React's handlers, which sit on the
        // root container, so a row's pointerup still sees its stamp.
        const endPress = () => { pressScrollRef.current = null; };
        document.addEventListener("keydown", onKey);
        document.addEventListener("pointerup", endPress);
        document.addEventListener("pointercancel", endPress);
        return () => {
            detach();
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerup", endPress);
            document.removeEventListener("pointercancel", endPress);
        };
    }, [isOpen, onClose]);

    // Filtered + sorted result
    const ranked = useMemo(() => {
        if (!isOpen) return [];
        if (!query.trim()) return items;
        const scored = items
            .map((it) => {
                const candidates = [it.label, it.hint ?? "", it.keywords ?? "", it.section];
                let best = -1;
                for (const c of candidates) {
                    const s = fuzzyScore(query, c);
                    if (s !== -1 && (best === -1 || s < best)) best = s;
                }
                return { item: it, score: best };
            })
            .filter((r) => r.score !== -1)
            .sort((a, b) => a.score - b.score)
            .map((r) => r.item);
        return scored;
    }, [items, query, isOpen]);

    // Group by section preserving order
    const grouped = useMemo(() => {
        const out: Array<{ section: string; items: PaletteCommand[] }> = [];
        const seen = new Map<string, number>();
        for (const it of ranked) {
            const idx = seen.get(it.section);
            if (idx === undefined) {
                seen.set(it.section, out.length);
                out.push({ section: it.section, items: [it] });
            } else {
                out[idx].items.push(it);
            }
        }
        return out;
    }, [ranked]);

    // Keep activeIdx valid when results change. Functional update so React
    // bails out via Object.is when no clamp is needed — otherwise this effect
    // would queue a setState on every render where activeIdx is already in
    // range, triggering the same setState-in-effect pattern that caused the
    // earlier "Maximum update depth" crash.
    useEffect(() => {
        // This is where the cursor is actually forced back to the top, so this is
        // where the scroll has to be re-armed: a hover may have disarmed it, and
        // the results can shrink out from under it without a keystroke (the items
        // prop carries the document's headings, which recompute on their own).
        // Harmless when nothing clamps, since the effect below only runs if
        // activeIdx really changed.
        scrollActiveRef.current = true;
        setActiveIdx((prev) => (prev >= ranked.length ? 0 : prev));
    }, [ranked.length]);

    // Auto-scroll the active row into view — for the KEYBOARD cursor only.
    //
    // Hovering scrolled too, which is incoherent (a hovered row is under the
    // pointer, so it is visible by definition) and it dropped the click: the row
    // slid out from under the press, so pointerdown and pointerup landed on
    // different rows and the browser synthesised the click on their common
    // ancestor, where nothing is listening. WebView2 does this; WKWebView is
    // forgiving enough to have hidden it on macOS. The settings Selects had the
    // same defect.
    useEffect(() => {
        if (!scrollActiveRef.current) return;
        const list = listRef.current;
        if (!list) return;
        const active = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
        active?.scrollIntoView({ block: "nearest" });
    }, [activeIdx]);

    // The clamp above runs in an effect, so for one render after the results
    // shrink, activeIdx can still point past the end: aria-activedescendant would
    // name an option that no longer exists, and Enter would run nothing. Clamping
    // here as well closes that window.
    const cursor = ranked.length === 0 ? 0 : Math.min(activeIdx, ranked.length - 1);

    /** Close, then run: a command that opens a dialog must not be closed over. */
    const run = (cmd: PaletteCommand) => {
        onClose();
        cmd.run();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            scrollActiveRef.current = true;
            setActiveIdx((i) => (ranked.length === 0 ? 0 : (i + 1) % ranked.length));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            scrollActiveRef.current = true;
            setActiveIdx((i) => (ranked.length === 0 ? 0 : (i - 1 + ranked.length) % ranked.length));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const cmd = ranked[cursor];
            if (cmd) run(cmd);
        }
    };

    if (!isOpen) return null;

    let runningIdx = -1;

    return (
        <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                className="relative z-10 w-[640px] max-w-[92vw] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-2xl overflow-hidden animate-fade-in"
                onKeyDown={onKeyDown}
            >
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
                    <span className="material-symbols-outlined text-[var(--text-secondary)]">search</span>
                    {/* An editable combobox (WAI-ARIA APG). DOM focus never leaves
                        this input: the arrow keys move a cursor through the rows
                        below without moving focus, so aria-activedescendant is the
                        only thing that can tell a screen reader which row is
                        current. Without it, arrowing the list announced nothing at
                        all, and Enter ran a command the user was never told about. */}
                    <input
                        type="text"
                        role="combobox"
                        aria-expanded={ranked.length > 0}
                        aria-controls={listboxId}
                        aria-activedescendant={ranked.length > 0 ? optionId(cursor) : undefined}
                        aria-autocomplete="list"
                        value={query}
                        // Re-ranking resets the cursor to the first row, which has
                        // to be scrolled back to even if the last thing that moved
                        // the cursor was a hover (which may not scroll).
                        onChange={(e) => { scrollActiveRef.current = true; setQuery(e.target.value); }}
                        placeholder="Type a command, file, or heading…"
                        aria-label="Search commands"
                        className="flex-1 bg-transparent text-[var(--text-primary)] outline-none text-sm placeholder:text-[var(--text-secondary)]"
                    />
                    <kbd className="px-1.5 py-0.5 text-[11px] font-mono rounded border border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-secondary)]">Esc</kbd>
                </div>

                {/* Outside the listbox, deliberately. A listbox may own only options
                    and groups, and the empty state is neither. role=status announces
                    it when it appears, which is otherwise silent: the results simply
                    vanish out from under the query. */}
                {ranked.length === 0 && (
                    <div role="status" className="px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
                        No results
                    </div>
                )}

                {/* A listbox may own only options and groups. These <li> wrappers are
                    markup scaffolding, so they are marked presentational and drop out
                    of the accessibility tree: without that the listbox owned a pile of
                    listitems, and the rows were not its children at all. The section
                    header is aria-hidden and its text is given to the group as a name
                    instead, because once the wrapper is gone the header would be a
                    bare div sitting directly inside the listbox, which is both illegal
                    there and read out as loose text on top of the group's own name. */}
                <ul
                    ref={listRef}
                    id={listboxId}
                    className="max-h-[420px] overflow-y-auto py-1"
                    role="listbox"
                    aria-label="Results"
                    hidden={ranked.length === 0}
                    // Stamped here, on the LIST, not on each row: a press that lands
                    // on a section header (or on a row it then drags off) must still
                    // be a press this list knows about, or some earlier gesture's
                    // stamp is still sitting there and the NEXT release over a row
                    // reads it and runs that command.
                    onPointerDownCapture={(e) => {
                        pressScrollRef.current = e.button === 0 ? (listRef.current?.scrollTop ?? 0) : null;
                    }}
                >
                    {grouped.map((g) => (
                        <li role="presentation" key={g.section}>
                            <div aria-hidden="true" className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                                {g.section}
                            </div>
                            <ul role="group" aria-label={g.section}>
                                {g.items.map((cmd) => {
                                    runningIdx++;
                                    const idx = runningIdx;
                                    const active = idx === cursor;
                                    return (
                                        <li role="presentation" key={cmd.id}>
                                            <button
                                                role="option"
                                                id={optionId(idx)}
                                                aria-selected={active}
                                                // The cursor is a flat index over the ranked list and
                                                // the footer counts the same way, but the options'
                                                // accessibility parent is their section group, so set
                                                // position would otherwise be computed per section:
                                                // "1 of 2" announced against a footer saying 12.
                                                aria-posinset={idx + 1}
                                                aria-setsize={ranked.length}
                                                // Reachable by pointer and by AT, never by Tab. DOM
                                                // focus has to stay in the search box: it is what
                                                // carries aria-activedescendant, and that is the only
                                                // thing telling a screen reader which row the cursor
                                                // is on. Let Tab land on a row and the two models
                                                // come apart. The row takes focus, so the reader
                                                // tracks the BUTTON, which has no activedescendant;
                                                // the next ArrowDown then moves the cursor and the
                                                // highlight while announcing nothing at all, and
                                                // Enter runs a row the user was never told about.
                                                // (focusTrap excludes tabindex="-1", or Tab would
                                                // walk out of the dialog looking for the next stop.)
                                                tabIndex={-1}
                                                data-idx={idx}
                                                // pointerEnter, not mouseEnter. Cancelling
                                                // pointerdown suppresses the compatibility mouse
                                                // events until the press ends, so mouseEnter went
                                                // deaf mid-drag: press row 2, drag to row 6, and
                                                // row 2 stayed highlighted while row 6 was the one
                                                // that ran. Pointer events are not suppressed.
                                                onPointerEnter={() => { scrollActiveRef.current = false; setActiveIdx(idx); }}
                                                // Pointer input commits on pointerup, NOT on the
                                                // synthesised click: a click only fires when
                                                // pointerdown and pointerup land on the same
                                                // element, so any row movement between the two
                                                // silently eats the command.
                                                onPointerDown={(e) => {
                                                    // Primary button only. pointerup fires for EVERY
                                                    // button, where click fired for none but the
                                                    // primary, so without this a right-click or a
                                                    // middle-click on a row would run its command.
                                                    if (e.button !== 0) return;
                                                    // Focus stays in the search box. Not for touch:
                                                    // preventing it there kills panning.
                                                    if (e.pointerType !== "touch") e.preventDefault();
                                                }}
                                                onPointerUp={(e) => {
                                                    if (e.button !== 0) return;
                                                    // A list that scrolled under the press was being
                                                    // dragged, not chosen from. A null stamp means
                                                    // the press did not begin in this list at all.
                                                    const press = pressScrollRef.current;
                                                    pressScrollRef.current = null;
                                                    if (press !== null && press === (listRef.current?.scrollTop ?? 0)) run(cmd);
                                                }}
                                                // Assistive technology emits no pointer events: it
                                                // activates through the platform a11y API, which
                                                // dispatches a SIMULATED click, and that does not
                                                // need the row to be focusable. detail is 0 for a
                                                // synthesised click and counts up for a real one, so
                                                // this admits exactly what pointerup cannot see and
                                                // never runs the command twice.
                                                onClick={(e) => { if (e.detail === 0) run(cmd); }}
                                                className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${active ? "bg-[var(--bg-hover)]" : ""}`}
                                            >
                                                <span className={`material-symbols-outlined text-[18px] shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"}`}>
                                                    {cmd.icon ?? "chevron_right"}
                                                </span>
                                                <span className="flex-1 min-w-0 text-sm text-[var(--text-primary)] truncate">{highlightLabel(cmd.label, query)}</span>
                                                {cmd.hint && (
                                                    <span className="text-[11px] text-[var(--text-secondary)] tabular-nums truncate ml-2 shrink-0">
                                                        {cmd.hint}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    ))}
                </ul>

                <div className="px-4 py-1.5 text-[10px] text-[var(--text-secondary)] border-t border-[var(--border-subtle)] bg-[var(--bg-titlebar)] flex items-center gap-3">
                    <span><kbd className="px-1 font-mono rounded border border-[var(--border)] bg-[var(--bg-input)]">↑↓</kbd> navigate</span>
                    <span><kbd className="px-1 font-mono rounded border border-[var(--border)] bg-[var(--bg-input)]">↵</kbd> run</span>
                    <span className="ml-auto">{ranked.length} {ranked.length === 1 ? "result" : "results"}</span>
                </div>
            </div>
        </div>
    );
}
