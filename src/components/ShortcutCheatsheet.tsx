import { useEffect, useRef, useState } from "react";
import { attachFocusTrap } from "../utils/focusTrap";
import { matchesShortcut, shortcutGroups } from "../utils/shortcutGroups";

interface ShortcutCheatsheetProps {
    isOpen: boolean;
    onClose: () => void;
}

// Built once: the platform does not change while the app runs.
const groups = shortcutGroups();

const renderKey = (k: string): React.ReactNode => {
    return k.split(/\s+/).map((part, i) => (
        <span key={i} className="inline-flex items-center">
            {i > 0 && <span className="mx-0.5 text-[var(--text-secondary)]">+</span>}
            <kbd className="px-1.5 py-0.5 text-[11px] font-mono rounded border border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-primary)] shadow-sm">
                {part}
            </kbd>
        </span>
    ));
};

export function ShortcutCheatsheet({ isOpen, onClose }: ShortcutCheatsheetProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [filter, setFilter] = useState("");

    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        document.addEventListener("keydown", handleKey);
        // Trap first (captures the trigger for focus-restore on close), then
        // move focus into the search input. UX-01.
        const detach = attachFocusTrap(dialogRef.current);
        const input = dialogRef.current?.querySelector<HTMLInputElement>("input");
        input?.focus();
        return () => {
            document.removeEventListener("keydown", handleKey);
            detach();
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const q = filter.trim().toLowerCase();
    const filtered = q
        ? groups
            .map((g) => ({
                ...g,
                items: g.items.filter((it) => matchesShortcut(it, q)),
            }))
            .filter((g) => g.items.length > 0)
        : groups;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="cheatsheet-title">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                className="relative z-10 w-[640px] max-h-[80vh] flex flex-col bg-[var(--bg-primary)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-2xl overflow-hidden animate-fade-in"
            >
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
                    <span aria-hidden="true" className="material-symbols-outlined text-[32px] text-[var(--text-muted)]">keyboard</span>
                    <h2 id="cheatsheet-title" className="text-base font-semibold text-[var(--text-primary)]">Keyboard Shortcuts</h2>
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter shortcuts…"
                        aria-label="Filter shortcuts"
                        className="ml-auto px-2 py-1 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] w-48"
                    />
                    <button
                        onClick={onClose}
                        aria-label="Close cheatsheet"
                        className="w-7 h-7 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
                    >
                        <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-5">
                    {filtered.length === 0 ? (
                        <div className="col-span-2 text-center text-[var(--text-secondary)] py-8 text-sm">
                            No shortcuts match "{filter}"
                        </div>
                    ) : filtered.map((g) => (
                        <section key={g.title}>
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                                {g.title}
                            </h3>
                            <ul className="space-y-1.5">
                                {g.items.map((it, i) => (
                                    <li key={i} className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-[var(--text-primary)]">{it.description}</span>
                                        <span className="flex items-center gap-1 shrink-0">{renderKey(it.keys)}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>

                <div className="px-5 py-2 text-[11px] text-[var(--text-secondary)] border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                    Press <kbd className="px-1 py-0.5 font-mono rounded border border-[var(--border)] bg-[var(--bg-input)]">Esc</kbd> to close
                </div>
            </div>
        </div>
    );
}
