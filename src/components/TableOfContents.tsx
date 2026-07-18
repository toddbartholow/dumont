import { useMemo, useEffect, useRef, useState } from "react";
import { attachFocusTrap } from "../utils/focusTrap";

interface TocItem {
    id: string;
    text: string;
    level: number;
    line: number;
}

interface TableOfContentsProps {
    isOpen: boolean;
    content: string;
    onClose: () => void;
    /** Current cursor line in code mode, or top-of-viewport line in preview. */
    activeLine?: number;
}

export function TableOfContents({
    isOpen,
    content,
    onClose,
    activeLine = 1,
}: TableOfContentsProps) {
    const panelRef = useRef<HTMLElement>(null);
    const [filter, setFilter] = useState("");

    const headings = useMemo((): TocItem[] => {
        // Skip the parse entirely when the panel isn't open. Saves walking
        // every line for headings on every keystroke for users who don't
        // currently have the outline visible.
        if (!isOpen || !content) return [];
        const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = normalized.split("\n");
        const items: TocItem[] = [];

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            const match = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                const level = match[1].length;
                const text = match[2].trim();
                const id = `heading-${index}-${text
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")}`;
                items.push({ id, text, level, line: index + 1 });
            }
        });
        return items;
    }, [content, isOpen]);

    // Active heading: the last one whose source line is at-or-above the active line
    const activeHeadingIdx = useMemo(() => {
        let idx = -1;
        for (let i = 0; i < headings.length; i++) {
            if (headings[i].line <= activeLine) idx = i;
            else break;
        }
        return idx;
    }, [headings, activeLine]);

    // Filtered list (filter by text only — keeps stable indexes)
    const visible = useMemo(() => {
        if (!filter.trim()) return headings.map((h, i) => ({ h, i }));
        const q = filter.toLowerCase();
        return headings.map((h, i) => ({ h, i })).filter(({ h }) => h.text.toLowerCase().includes(q));
    }, [headings, filter]);

    // Keep the active row in view when activeHeadingIdx changes — unless a press is
    // in progress in here, in which case moving the list would move the row out
    // from under it. A click only fires where pointerdown and pointerup agree, so
    // the press would be dropped (WebView2 is strict about this; WKWebView hides
    // it), and the user's second click would do nothing.
    //
    // Not hypothetical: clicking a heading dispatches goto-line, and the preview
    // answers it with a SMOOTH scroll. activeLine tracks the top of the viewport,
    // so it changes all the way through that animation, and this effect drags the
    // outline along with it. Click one heading and then quickly click another and
    // the second row is moving as you press it.
    const pressInPanelRef = useRef(false);
    useEffect(() => {
        if (!isOpen) return;
        const endPress = () => { pressInPanelRef.current = false; };
        document.addEventListener("pointerup", endPress);
        document.addEventListener("pointercancel", endPress);
        return () => {
            document.removeEventListener("pointerup", endPress);
            document.removeEventListener("pointercancel", endPress);
        };
    }, [isOpen]);

    useEffect(() => {
        if (activeHeadingIdx === -1 || pressInPanelRef.current) return;
        const el = panelRef.current?.querySelector<HTMLElement>(`[data-toc-idx="${activeHeadingIdx}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [activeHeadingIdx]);

    // Escape key to close and focus management
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

    // Jump by SOURCE LINE, not heading text (NAV-01). The editor and the
    // preview both listen for this event and scroll themselves, so the click
    // works in code, preview, and split mode — and lands on the right heading
    // even when two sections share the same title (the old text-matching
    // approach always hit the first occurrence, and only in preview mode).
    const handleHeadingClick = (line: number) => {
        window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line } }));
    };

    const getIndent = (level: number): string => {
        const indents = ["", "pl-4", "pl-8", "pl-12", "pl-16", "pl-20"];
        return indents[level - 1] || "";
    };

    const getIcon = (level: number): string => {
        if (level === 1) return "title";
        if (level === 2) return "format_h2";
        return "format_h3";
    };

    return (
        <aside
            ref={panelRef}
            // Not role="navigation": the <nav> inside is already one, and two
            // nested navigation landmarks for one panel show up as two entries in
            // NVDA's landmark list. An <aside> is a complementary landmark, which
            // is what this actually is.
            aria-label="Table of contents"
            tabIndex={-1}
            // Closed, this panel is only translated off screen, so it stayed in the
            // accessibility tree AND the tab order: a screen reader user found
            // landmarks that are nowhere on screen, heard "Outline, no headings
            // yet", and could Tab to a Close button they could not see.
            aria-hidden={!isOpen}
            inert={!isOpen}
            className={`fixed left-0 top-12 bottom-7 w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] z-50 shadow-2xl flex flex-col overflow-hidden transition-transform duration-200 ease-out ${isOpen ? "translate-x-0" : "-translate-x-full"
                }`}
        >
            {/* Header */}
            <div className="h-10 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-titlebar)]">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] no-select">
                    <span className="material-symbols-outlined text-[18px]">format_list_bulleted</span>
                    <span>Outline</span>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close outline"
                    className="btn-press flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
            </div>

            {/* Filter (only shown when there are >5 headings to keep it clean) */}
            {headings.length > 5 && (
                <div className="px-3 py-2 shrink-0 border-b border-[var(--border-subtle)]">
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter headings…"
                        aria-label="Filter headings"
                        className="w-full px-2 py-1 text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-sm)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                </div>
            )}

            {/* Content */}
            <nav
                className="flex-1 min-h-0 overflow-y-auto"
                aria-label="Document headings"
                // Primary button only, matching what click itself would have done.
                onPointerDownCapture={(e) => { if (e.button === 0) pressInPanelRef.current = true; }}
            >
                {headings.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-[var(--text-secondary)] text-sm gap-2 px-4 text-center">
                        <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">format_list_bulleted</span>
                        <span>No headings yet.</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">Type <code className="font-mono">#</code> to add one.</span>
                    </div>
                ) : visible.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-2 text-[var(--text-secondary)] text-sm">
                        <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">search_off</span>
                        <span>No matches</span>
                    </div>
                ) : (
                    <ul className="py-2">
                        {visible.map(({ h: heading, i: index }) => {
                            const isActive = index === activeHeadingIdx;
                            return (
                            <li key={`${heading.id}-${index}`} data-toc-idx={index}>
                                <button
                                    onClick={() => handleHeadingClick(heading.line)}
                                    aria-label={`Go to heading: ${heading.text}`}
                                    aria-current={isActive ? "location" : undefined}
                                    className={`btn-press w-full px-4 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${getIndent(heading.level)} ${isActive
                                        ? "bg-[var(--bg-hover)] text-[var(--text-primary)] border-l-2 border-[var(--focus-ring)] -ml-px"
                                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                        }`}
                                >
                                    <span className={`material-symbols-outlined text-[14px] ${heading.level === 1 ? "text-[var(--text-primary)]" : "opacity-60"}`}>
                                        {getIcon(heading.level)}
                                    </span>
                                    <span className={`truncate ${heading.level === 1 ? "font-semibold" : heading.level === 2 ? "font-medium" : ""}`}>
                                        {heading.text}
                                    </span>
                                </button>
                            </li>
                            );
                        })}
                    </ul>
                )}
            </nav>
        </aside>
    );
}
