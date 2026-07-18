import { useState, useRef, useEffect, useLayoutEffect, useId } from "react";
import {
    FONT_SIZE_PRESETS,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    clampFontSize,
} from "../utils/typeScale";

interface FontSizeFieldProps {
    value: number;
    onChange: (size: number) => void;
}

/**
 * An editable combobox for the font size: pick a preset, or type any size.
 *
 * Typing does NOT apply as you go. Keystroke-apply looks reasonable until you
 * type "18": the intermediate "1" would clamp to the minimum and relayout the
 * whole document (and force CodeMirror to re-measure) before the "8" arrives.
 * Debouncing only delays that — it doesn't stop the partial value from being
 * applied. So the draft is local and commits on Enter, on blur, or on picking a
 * preset. Arrow keys are the exception: ±1px is bounded and intentional, and
 * live feedback is the whole point of nudging.
 */
export function FontSizeField({ value, onChange }: FontSizeFieldProps) {
    const [draft, setDraft] = useState(String(value));
    const [isOpen, setIsOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [flipUp, setFlipUp] = useState(false);

    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    const baseId = useId();
    const labelId = `${baseId}-label`;
    const listboxId = `${baseId}-listbox`;
    const optionId = (i: number) => `${baseId}-opt-${i}`;

    // Follow the value when it changes elsewhere (a preset click, a reset, or
    // another surface editing the same setting).
    useEffect(() => setDraft(String(value)), [value]);

    // Flagged while typing, so the message describes what is actually wrong. It
    // used to fire ONLY for non-numeric input while claiming "enter a number
    // between 11 and 32" — so `999`, the one input that violates that sentence,
    // was reported as valid and then silently clamped on blur, which a screen
    // reader user had no way of noticing at all.
    const typed = draft.trim();
    const parsed = Number(typed);
    const notANumber = typed !== "" && !Number.isFinite(parsed);

    // Never judge a draft that can still become valid. The minimum is 11, i.e.
    // two digits — so a naive `parsed < MIN` fires on the "2" of "24", flashing a
    // red border and firing an ASSERTIVE alert mid-word on the happy path. Only a
    // number that no further digit can rescue is wrong: too large already, or too
    // small at a length that can no longer reach the minimum.
    const tooLarge = parsed > MAX_FONT_SIZE;
    const tooSmall = parsed < MIN_FONT_SIZE && typed.length >= String(MIN_FONT_SIZE).length;
    const outOfRange = typed !== "" && Number.isFinite(parsed) && (tooLarge || tooSmall);
    const invalid = notANumber || outOfRange;

    /** Apply the draft. Junk reverts; out-of-range clamps and rewrites the field,
     *  so what actually took effect is visible (and, via the alert, audible). */
    const commit = () => {
        if (typed === "" || !Number.isFinite(parsed)) {
            setDraft(String(value));
            return;
        }
        const size = clampFontSize(parsed);
        onChange(size);
        setDraft(String(size));
    };

    const step = (delta: number) => {
        const from = Number.isFinite(Number(draft)) && draft.trim() !== "" ? Number(draft) : value;
        const size = clampFontSize(from + delta);
        onChange(size);
        setDraft(String(size));
    };

    const choose = (i: number) => {
        const size = FONT_SIZE_PRESETS[i];
        onChange(size);
        setDraft(String(size));
        setIsOpen(false);
        inputRef.current?.focus();
    };

    const openList = () => {
        const at = FONT_SIZE_PRESETS.indexOf(value as typeof FONT_SIZE_PRESETS[number]);
        setActiveIndex(at >= 0 ? at : 0);
        setIsOpen(true);
        // Focus must sit on the input: aria-activedescendant is only honored on
        // the focused element, and the keydown handler lives here. Clicking the
        // chevron in a Chromium webview (Windows) would otherwise focus the
        // button, leaving an open listbox that announces nothing and ignores the
        // arrow keys.
        inputRef.current?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (isOpen) {
            switch (e.key) {
                case "Escape":
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOpen(false);
                    return;
                case "Enter":
                    e.preventDefault();
                    e.stopPropagation();
                    choose(activeIndex);
                    return;
                case "ArrowDown":
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveIndex((i) => Math.min(FONT_SIZE_PRESETS.length - 1, i + 1));
                    return;
                case "ArrowUp":
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveIndex((i) => Math.max(0, i - 1));
                    return;
                case "Home":
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveIndex(0);
                    return;
                case "End":
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveIndex(FONT_SIZE_PRESETS.length - 1);
                    return;
                case "Tab":
                    // Commit and close, but let focus move on — a Tab that left
                    // the listbox open stranded it floating over the UI, closable
                    // only with the mouse.
                    e.stopPropagation();
                    setIsOpen(false);
                    commit();
                    return;
            }
            return;
        }

        switch (e.key) {
            case "Enter":
                e.preventDefault();
                e.stopPropagation();
                commit();
                return;
            case "Escape":
                // Only swallow Escape when there is genuinely an edit to abandon.
                // Swallowing it unconditionally meant that, with focus in this
                // field, Escape could never close the surrounding panel or the
                // settings modal — not on the second press, not ever.
                if (draft === String(value)) return;
                e.preventDefault();
                e.stopPropagation();
                setDraft(String(value));
                return;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                if (e.altKey) openList();
                else step(1);
                return;
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                if (e.altKey) openList();
                else step(-1);
                return;
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [isOpen]);

    useLayoutEffect(() => {
        if (!isOpen) return;
        const input = inputRef.current;
        const list = listRef.current;
        if (!input || !list) return;
        const rect = input.getBoundingClientRect();
        const needed = list.offsetHeight + 8;
        setFlipUp(rect.bottom + needed > window.innerHeight && rect.top > needed);
    }, [isOpen]);

    return (
        <div ref={rootRef} className="relative flex items-center gap-3">
            <span id={labelId} className="w-[68px] shrink-0 text-xs font-medium text-[var(--text-secondary)]">
                Size
            </span>

            <div
                className={`flex-1 min-w-0 h-9 flex items-center rounded-[var(--radius-md)] bg-[var(--bg-input)] border transition-colors ${invalid
                    ? "border-[var(--danger)]"
                    : isOpen
                        ? "border-[var(--focus-ring)]"
                        : "border-[var(--border)]"
                    }`}
            >
                <input
                    ref={inputRef}
                    role="combobox"
                    type="text"
                    inputMode="numeric"
                    value={draft}
                    aria-labelledby={labelId}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? listboxId : undefined}
                    aria-activedescendant={isOpen ? optionId(activeIndex) : undefined}
                    aria-autocomplete="list"
                    aria-invalid={invalid || undefined}
                    // Error FIRST, then the hint: on refocus after a failure the
                    // failure is what you need to hear, not the rule you already
                    // broke. The hint is always attached so the allowed range is
                    // discoverable up front rather than only after tripping it.
                    aria-describedby={invalid ? `${baseId}-error ${baseId}-hint` : `${baseId}-hint`}
                    onChange={(e) => {
                        setDraft(e.target.value);
                        // Typing takes over from the preset list. Leaving it open
                        // meant Enter routed to the highlighted PRESET and threw
                        // the typed number away: at 17px (not a preset, so the
                        // active index fell back to 0) typing "22" and pressing
                        // Enter applied 12px.
                        setIsOpen(false);
                    }}
                    onKeyDown={onKeyDown}
                    onBlur={commit}
                    className="flex-1 min-w-0 h-full pl-3 pr-1 bg-transparent text-sm text-[var(--text-primary)] outline-none"
                />
                <span className="text-xs text-[var(--text-secondary)] select-none" aria-hidden="true">px</span>
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Font size presets"
                    // Chromium (WebView2, i.e. the Windows build) focuses a button
                    // on mousedown even at tabIndex -1. That blurred the input,
                    // fired its blur-commit, and left focus on the chevron with an
                    // open listbox the keyboard could no longer reach.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => (isOpen ? setIsOpen(false) : openList())}
                    className="w-8 h-full flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                        {isOpen ? "expand_less" : "expand_more"}
                    </span>
                </button>
            </div>

            <span id={`${baseId}-hint`} className="sr-only">
                A number between {MIN_FONT_SIZE} and {MAX_FONT_SIZE} pixels.
            </span>

            {/* role="alert" — a description is only announced when the field
                receives focus, but the field already HAS focus while you type, so
                the message was otherwise never spoken. The container is mounted
                unconditionally and only its TEXT changes: WebKit (the macOS
                build, and VoiceOver with it) is unreliable at announcing a live
                region that appears in the same tick as its content. */}
            <span
                id={`${baseId}-error`}
                role="alert"
                className="absolute left-[80px] top-full mt-1 text-[11px] text-[var(--danger-text)] empty:hidden"
            >
                {!invalid ? "" : outOfRange
                    ? `Size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}`
                    : `Enter a number between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}`}
            </span>

            {isOpen && (
                <ul
                    ref={listRef}
                    id={listboxId}
                    role="listbox"
                    aria-labelledby={labelId}
                    className={`absolute left-[80px] right-0 z-[80] max-h-[min(240px,40vh)] overflow-y-auto py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-md)] shadow-2xl ${flipUp ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]"
                        }`}
                >
                    {FONT_SIZE_PRESETS.map((size, i) => (
                        <li
                            key={size}
                            id={optionId(i)}
                            role="option"
                            aria-selected={size === value}
                            data-active={i === activeIndex}
                            onPointerDown={(e) => e.preventDefault()} // don't blur-commit the input first
                            onClick={() => choose(i)}
                            onPointerEnter={() => setActiveIndex(i)}
                            // Accent outline for the keyboard cursor — see the
                            // matching note in Select.tsx. --bg-hover alone was
                            // ~1.1:1 against the list, and these options never
                            // take DOM focus, so no focus ring can stand in.
                            className="h-8 px-3 flex items-center gap-2 cursor-pointer text-sm text-[var(--text-primary)] data-[active=true]:bg-[var(--bg-hover)] data-[active=true]:outline data-[active=true]:outline-2 data-[active=true]:-outline-offset-2 data-[active=true]:outline-[var(--focus-ring)]"
                        >
                            <span className="flex-1">{size} px</span>
                            {size === value && (
                                <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[var(--focus-ring)]">check</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
