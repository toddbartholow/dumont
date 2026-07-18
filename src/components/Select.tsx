import { useState, useRef, useEffect, useLayoutEffect, useId, useCallback, type ReactNode, type CSSProperties } from "react";

export interface SelectOption<T extends string> {
    value: T;
    label: string;
    /** Applied to the label — lets a font option preview in its own typeface. */
    style?: CSSProperties;
    /** Rendered before the label (a theme swatch, say). */
    adornment?: ReactNode;
    /** Secondary text after the label ("Serif", "Monospace"). */
    hint?: string;
}

interface SelectProps<T extends string> {
    /** Visible label; also names the listbox for screen readers. */
    label: string;
    value: T;
    options: readonly SelectOption<T>[];
    onChange: (value: T) => void;
    /**
     * Apply each option as it becomes active while arrowing or hovering, and
     * revert on Escape. Turns the control into a live previewer — worth it for
     * theme and font (a cheap attribute flip); not for anything that forces an
     * expensive relayout on every keypress.
     *
     * REQUIRES `onPreview`. Previewing through `onChange` would persist every
     * option the pointer merely passed over, which is not a choice the user made.
     */
    previewOnActive?: boolean;
    /** Apply a value transiently. Must NOT persist it — only `onChange` does. */
    onPreview?: (value: T) => void;
}

/** Type-ahead buffer resets after this long without a keystroke. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * A select-only combobox (WAI-ARIA APG). Used instead of a native <select>
 * because the options need to render rich previews — a font option must be set
 * in its own typeface, a theme option must show its colors — and macOS
 * WKWebView draws <option> with the native menu, ignoring any styling.
 *
 * Options are `<li role="option">` WITHOUT tabindex, and selection is tracked
 * with aria-activedescendant rather than DOM focus. That is deliberate: this
 * control lives inside menus driven by useDropdownKeyboard, whose roving-focus
 * query matches `button`/`input`/`[tabindex]`. Focusable options would be swept
 * into that outer ring and the two keyboard models would fight. Keeping DOM
 * focus on the trigger at all times sidesteps it entirely.
 */
export function Select<T extends string>({ label, value, options, onChange, previewOnActive, onPreview }: SelectProps<T>) {
    const [isOpen, setIsOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [flipUp, setFlipUp] = useState(false);

    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    // The value to restore if the user escapes out of a live preview.
    const valueOnOpenRef = useRef<T>(value);
    const typeaheadRef = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
    // Whether the pending active-option change should scroll the list. See the
    // effect below: only the keyboard cursor gets to move the list.
    const scrollActiveRef = useRef(true);
    // The list's scrollTop when the pointer went down on an option, so pointerup
    // can tell a choice from a drag-scroll.
    const pressScrollRef = useRef<number | null>(null);

    const baseId = useId();
    const labelId = `${baseId}-label`;
    const valueId = `${baseId}-value`;
    const listboxId = `${baseId}-listbox`;
    const optionId = (i: number) => `${baseId}-opt-${i}`;

    // The option the user actually COMMITTED to. With previewOnActive, `value`
    // tracks the option they are merely arrowing over — driving aria-selected
    // from that would announce every option in turn as "selected" and drag the
    // check mark along with the cursor, leaving no way to tell what was set when
    // the list opened. Selected is where you were; active is where you are.
    const committedValue = previewOnActive && isOpen ? valueOnOpenRef.current : value;
    const selectedIndex = Math.max(0, options.findIndex((o) => o.value === committedValue));
    const displayed = options[Math.max(0, options.findIndex((o) => o.value === value))];

    const open = useCallback((startIndex: number) => {
        valueOnOpenRef.current = value;
        scrollActiveRef.current = true;   // the selected option must be in view
        setActiveIndex(startIndex);
        setIsOpen(true);
    }, [value]);

    const close = useCallback((focusTrigger = true) => {
        setIsOpen(false);
        if (focusTrigger) triggerRef.current?.focus();
    }, []);

    /** Commit the option at `i` and close. */
    const commit = useCallback((i: number) => {
        const option = options[i];
        if (option) onChange(option.value);
        close();
    }, [options, onChange, close]);

    /** Apply transiently. Falls back to onChange only when the caller didn't opt
     *  into previewing at all, so a preview can never write through to storage. */
    const preview = useCallback((v: T) => {
        (onPreview ?? onChange)(v);
    }, [onPreview, onChange]);

    /** Cancel: undo any live preview and close without committing. */
    const cancel = useCallback(() => {
        if (previewOnActive && valueOnOpenRef.current !== value) preview(valueOnOpenRef.current);
        close();
    }, [previewOnActive, value, preview, close]);

    /** Move the active option, previewing it when the control opted in.
     *  `scroll` keeps the option in view. Pointer-driven moves pass false: the
     *  option is under the cursor, so it is visible by definition. */
    const moveActive = useCallback((i: number, scroll = true) => {
        const next = Math.min(options.length - 1, Math.max(0, i));
        scrollActiveRef.current = scroll;
        setActiveIndex(next);
        if (previewOnActive) {
            const option = options[next];
            if (option) preview(option.value);
        }
    }, [options, previewOnActive, preview]);

    /** Jump to the next option whose label starts with the buffered keystrokes.
     *  Repeating a single character cycles through the options starting with it. */
    const typeahead = useCallback((char: string, from: number) => {
        const now = Date.now();
        const t = typeaheadRef.current;
        t.buffer = now - t.at > TYPEAHEAD_RESET_MS ? char : t.buffer + char;
        t.at = now;

        const repeated = t.buffer.length > 1 && t.buffer.split("").every((c) => c === t.buffer[0]);
        const query = (repeated ? t.buffer[0] : t.buffer).toLowerCase();
        // A repeated character advances past the current match; a growing buffer
        // re-matches from the current one.
        const start = repeated ? from + 1 : from;

        for (let n = 0; n < options.length; n++) {
            const i = (start + n) % options.length;
            if (options[i].label.toLowerCase().startsWith(query)) return i;
        }
        return -1;
    }, [options]);

    const onClosedKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case "Enter":
            case " ":
            case "ArrowDown":
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                open(selectedIndex);
                return;
            case "Home":
                e.preventDefault();
                e.stopPropagation();
                open(0);
                return;
            case "End":
                e.preventDefault();
                e.stopPropagation();
                open(options.length - 1);
                return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const i = typeahead(e.key, selectedIndex);
            if (i >= 0) {
                e.preventDefault();
                e.stopPropagation();
                open(i);
            }
        }
    };

    const onOpenKeyDown = (e: React.KeyboardEvent) => {
        // Every handled key stops here: the surrounding menu (useDropdownKeyboard)
        // and the app's global Escape listeners must not also act on it.
        switch (e.key) {
            case "Escape":
                e.preventDefault();
                e.stopPropagation();
                cancel();
                return;
            case "Enter":
            case " ":
                e.preventDefault();
                e.stopPropagation();
                commit(activeIndex);
                return;
            case "Tab":
                // Tab commits (standard combobox behavior) but must keep moving
                // focus, so it is not prevented — only kept from the outer menu.
                e.stopPropagation();
                commit(activeIndex);
                return;
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                moveActive(activeIndex + 1);
                return;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                moveActive(activeIndex - 1);
                return;
            case "Home":
                e.preventDefault();
                e.stopPropagation();
                moveActive(0);
                return;
            case "End":
                e.preventDefault();
                e.stopPropagation();
                moveActive(options.length - 1);
                return;
            case "PageDown":
                e.preventDefault();
                e.stopPropagation();
                moveActive(activeIndex + 10);
                return;
            case "PageUp":
                e.preventDefault();
                e.stopPropagation();
                moveActive(activeIndex - 10);
                return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const i = typeahead(e.key, activeIndex);
            if (i >= 0) {
                e.preventDefault();
                e.stopPropagation();
                moveActive(i);
            }
        }
    };

    // Close on an outside click. Pointerdown (not click) so it fires before the
    // trigger's own click handler would re-open the list.
    //
    // The same effect ends the press. An option's pointerup clears its own stamp,
    // but every OTHER way a press can end (released outside the list, released on
    // the trigger, or cancelled because a touch became a pan) would leave the
    // stamp behind, and a stale stamp is indistinguishable from a fresh one: the
    // next release over an option would read it and commit an option the user
    // never pressed. These fire after React's own handlers, which sit on the root
    // container, so an option's pointerup still sees its stamp.
    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) cancel();
        };
        const endPress = () => { pressScrollRef.current = null; };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("pointerup", endPress);
        document.addEventListener("pointercancel", endPress);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("pointerup", endPress);
            document.removeEventListener("pointercancel", endPress);
        };
    }, [isOpen, cancel]);

    // Open upward when there isn't room below (the gear panel sits near the top
    // of the window, but the modal's Appearance section can sit near the bottom).
    useLayoutEffect(() => {
        if (!isOpen) return;
        const trigger = triggerRef.current;
        const list = listRef.current;
        if (!trigger || !list) return;
        const rect = trigger.getBoundingClientRect();
        const needed = list.offsetHeight + 8;
        setFlipUp(rect.bottom + needed > window.innerHeight && rect.top > needed);
    }, [isOpen]);

    // Keep the active option visible while arrowing through a scrolled list.
    // Indexed, not queried by id: React's useId values contain colons, which
    // would need CSS.escape to be selector-safe.
    //
    // ONLY for the keyboard cursor (scrollActiveRef). Hover used to scroll too,
    // which is incoherent — a hovered option is already under the pointer — and
    // it moved the list out from under the press: the row the user pushed down on
    // was no longer the row they released on, so the browser synthesised the
    // click on the <ul> (their nearest common ancestor) and the option never
    // committed. It also fought the wheel, snapping the list back to whatever
    // option the scroll had just dragged under the cursor. The font list is the
    // one that overflows 240px, so it was the one that stuck.
    useEffect(() => {
        if (!isOpen || !scrollActiveRef.current) return;
        const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
        el?.scrollIntoView({ block: "nearest" });
    }, [isOpen, activeIndex]);

    return (
        <div ref={rootRef} className="relative flex items-center gap-3">
            <span id={labelId} className="w-[68px] shrink-0 text-xs font-medium text-[var(--text-secondary)]">
                {label}
            </span>

            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-expanded={isOpen}
                aria-haspopup="listbox"
                aria-controls={isOpen ? listboxId : undefined}
                aria-activedescendant={isOpen ? optionId(activeIndex) : undefined}
                // Label AND value. A combobox that isn't an <input> has no value
                // property for VoiceOver to read, and aria-labelledby suppresses
                // name-from-content — so naming it by the label alone made it
                // announce as a bare "Theme", never saying which theme.
                aria-labelledby={`${labelId} ${valueId}`}
                onClick={() => (isOpen ? cancel() : open(selectedIndex))}
                // Focus never leaves the trigger (options are addressed with
                // aria-activedescendant), so it handles the keys for both states.
                onKeyDown={isOpen ? onOpenKeyDown : onClosedKeyDown}
                className={`flex-1 min-w-0 h-9 flex items-center gap-2 px-3 rounded-[var(--radius-md)] bg-[var(--bg-input)] border text-sm text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors ${isOpen ? "border-[var(--focus-ring)]" : "border-[var(--border)]"
                    }`}
            >
                {displayed?.adornment}
                <span id={valueId} className="flex-1 min-w-0 truncate" style={displayed?.style}>
                    {displayed?.label ?? ""}
                </span>
                {/* Material Symbols is a ligature font: without aria-hidden the
                    literal text "expand_more" joins the accessible name. */}
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[var(--text-secondary)] shrink-0">
                    {isOpen ? "expand_less" : "expand_more"}
                </span>
            </button>

            {isOpen && (
                <ul
                    ref={listRef}
                    id={listboxId}
                    role="listbox"
                    aria-labelledby={labelId}
                    // Stamped here, on the LIST, rather than on each option: a press
                    // that lands between rows (or on a row, then drags off one) must
                    // still be a press this list knows about, or the stamp from some
                    // earlier gesture is still sitting there and the NEXT release
                    // over a row reads it and commits. Cleared whenever the press
                    // ends, wherever it ends (see the effect above).
                    onPointerDownCapture={(e) => {
                        pressScrollRef.current = e.button === 0 ? (listRef.current?.scrollTop ?? 0) : null;
                    }}
                    // z-[80] clears the settings panel (z-[70]) it opens inside of.
                    className={`absolute left-[80px] right-0 z-[80] max-h-[min(240px,40vh)] overflow-y-auto py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-md)] shadow-2xl ${flipUp ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]"
                        }`}
                >
                    {options.map((option, i) => {
                        const isSelected = i === selectedIndex;
                        return (
                            <li
                                key={option.value}
                                id={optionId(i)}
                                role="option"
                                aria-selected={isSelected}
                                data-active={i === activeIndex}
                                // Pointer input commits on pointerup, NOT on click. A
                                // click only fires when pointerdown and pointerup
                                // land on the same element, so anything that moves
                                // the row between the two (a scroll, a reflow)
                                // silently eats the selection. WKWebView was
                                // forgiving enough to hide that; WebView2 was not,
                                // and Windows users could not choose an option.
                                onPointerDown={(e) => {
                                    // Primary button only. pointerup fires for EVERY
                                    // button, where click fired for none but the
                                    // primary, so without this a right-click or a
                                    // middle-click on an option would commit it.
                                    if (e.button !== 0) return;
                                    // Focus stays on the trigger (the whole control
                                    // is driven by aria-activedescendant), and the
                                    // press doesn't start a text selection. Not for
                                    // touch: preventing it there kills panning.
                                    if (e.pointerType !== "touch") e.preventDefault();
                                }}
                                onPointerUp={(e) => {
                                    if (e.button !== 0) return;
                                    // A list that scrolled under the press was being
                                    // dragged, not chosen from: releasing over a row
                                    // you only scrolled past is not a selection. A
                                    // null stamp means the press did not begin in
                                    // this list at all, which is not one either.
                                    const press = pressScrollRef.current;
                                    pressScrollRef.current = null;
                                    if (press !== null && press === (listRef.current?.scrollTop ?? 0)) commit(i);
                                }}
                                // Assistive technology does not emit pointer events.
                                // It activates an element through the platform a11y
                                // API, which bottoms out in a SIMULATED click:
                                // VoiceOver's VO+Space, browse-mode Enter in
                                // NVDA/JAWS, and "click Dracula" in Voice Control
                                // all arrive here and nowhere else. Committing only
                                // on pointerup left them no way to choose an option
                                // at all. detail is 0 for a synthesised click and
                                // counts up for a real one, so this admits exactly
                                // the events pointerup cannot see, and the pointer
                                // never commits twice.
                                onClick={(e) => { if (e.detail === 0) commit(i); }}
                                // moveActive, not setActiveIndex: hovering has to
                                // preview too, or the option announced as active
                                // and the theme actually applied drift apart.
                                onPointerEnter={() => moveActive(i, false)}
                                // The active option is the keyboard CURSOR, and
                                // these options never take DOM focus — so the
                                // app's focus-visible ring can never fire for
                                // them. A --bg-hover tint was the only cue, at
                                // ~1.1:1 against the list: invisible. An accent
                                // outline clears 3:1 in every theme, and being a
                                // different FORM from the check mark, it stays
                                // distinguishable from "selected" without relying
                                // on color alone.
                                className="relative h-9 px-3 flex items-center gap-2 cursor-pointer text-sm text-[var(--text-primary)] data-[active=true]:bg-[var(--bg-hover)] data-[active=true]:outline data-[active=true]:outline-2 data-[active=true]:-outline-offset-2 data-[active=true]:outline-[var(--focus-ring)]"
                            >
                                {option.adornment}
                                <span className="flex-1 min-w-0 truncate" style={option.style}>
                                    {option.label}
                                </span>
                                {option.hint && (
                                    <span className="text-[10px] text-[var(--text-secondary)] shrink-0">{option.hint}</span>
                                )}
                                {isSelected && (
                                    <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[var(--focus-ring)] shrink-0">check</span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

/** The two-tone color chip a theme option previews itself with. */
export function ThemeSwatch({ colors }: { colors: [string, string] }) {
    return (
        <span
            className="w-5 h-5 shrink-0 rounded-[var(--radius-sm)] overflow-hidden border border-[var(--border)] flex"
            aria-hidden="true"
        >
            <span className="w-1/2 h-full" style={{ backgroundColor: colors[0] }} />
            <span className="w-1/2 h-full" style={{ backgroundColor: colors[1] }} />
        </span>
    );
}
