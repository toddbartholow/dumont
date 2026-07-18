// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useDropdownKeyboard } from '../hooks/useDropdownKeyboard';
import { Select, ThemeSwatch, type SelectOption } from './Select';
import { FontSizeField } from './FontSizeField';
import { THEMES, FONTS, fontStack, isBundledFont } from '../utils/appearanceOptions';
import type { Theme, FontFamily } from '../context/ThemeContext';

const themeOptions: SelectOption<Theme>[] = THEMES.map((t) => ({
    value: t.id,
    label: t.name,
    adornment: <ThemeSwatch colors={t.colors} />,
}));

// Each font previews in its own face — the reason this is a custom listbox and
// not a native <select> (WKWebView ignores font-family on <option>).
const fontOptions: SelectOption<FontFamily>[] = FONTS.map((f) => ({
    value: f.id,
    label: f.name,
    hint: f.kind,
    style: { fontFamily: f.stack },
}));

/**
 * The bundled fonts, plus the user's own if they have set one.
 *
 * `appearance.font` can name any font installed on the machine, so the value need
 * not be in the list. Without this the dropdown would match nothing and render an
 * empty box, which reads as a bug: the setting IS applied, the picker just cannot
 * name it. Appending it keeps the current font visible and selectable.
 */
function fontOptionsFor(font: FontFamily): SelectOption<FontFamily>[] {
    if (isBundledFont(font)) return fontOptions;
    return [
        ...fontOptions,
        { value: font, label: font, hint: "Custom", style: { fontFamily: fontStack(font) } },
    ];
}

/**
 * The quick-settings panel behind the titlebar gear: theme, font and size — the
 * three settings you change while reading a document, each instantly reversible.
 *
 * It deliberately holds nothing else. It used to render every appearance option
 * as a grid of swatch cards and a column of font buttons, which grew to ~700px
 * and broke its own layout as themes and fonts were added. Anything that isn't
 * one of these three rows belongs in the full Settings modal, behind
 * "More settings…".
 */
export function SettingsMenu() {
    const [isOpen, setIsOpen] = useState(false);
    const { theme, setTheme, previewTheme, font, setFont, previewFont, fontSize, setFontSize } = useTheme();
    const menuRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    // roving: false — this panel holds form controls (two comboboxes and a text
    // field), not menu items. Arrow/Home/End belong to those controls; hoisting
    // them to the panel meant Home in the font-size box jumped focus instead of
    // moving the caret. Tab traverses; the hook still traps focus and closes on
    // Escape.
    const onMenuKeyDown = useDropdownKeyboard(isOpen, panelRef, () => setIsOpen(false), false);

    // Close menu when clicking outside or pressing Escape. The Selects stop
    // propagation on their own Escape, so closing one doesn't close the panel.
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsOpen(false);
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleKey);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen]);

    return (
        <div ref={menuRef} className="relative no-drag">
            {/* Settings Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                aria-label="Quick settings"
                aria-expanded={isOpen}
                // Not "true" (which resolves to `menu`) — what opens is a small
                // group of form controls, and promising a menu makes screen
                // readers enter menu mode and hunt for menuitems that don't exist.
                aria-haspopup="dialog"
                className="btn-press flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                title="Settings"
            >
                <span className="material-symbols-outlined text-[18px]">settings</span>
            </button>

            {/* Dropdown Menu. z-[70] keeps it above the floating Reader/Code mode
                toggle (z-50, mounted later in the DOM so it wins z-index ties).
                overflow-visible is required: the Selects open absolutely
                positioned listboxes that would otherwise be clipped by the panel.
                Safe now that the panel is only ~200px tall — the scroll guard it
                replaces was there for the old 700px version. */}
            {isOpen && (
                <div
                    ref={panelRef}
                    onKeyDown={onMenuKeyDown}
                    // role="dialog", not "menu": `menu` has required owned
                    // elements (menuitem and friends) and this panel owns none —
                    // it owns comboboxes. Claiming `menu` is invalid ARIA and
                    // drops NVDA/JAWS into a mode where the controls inside
                    // announce badly or not at all. `dialog` is what this
                    // actually is: useDropdownKeyboard traps Tab inside it and
                    // returns focus to the trigger on close, and it makes the
                    // trigger's aria-haspopup="dialog" honest.
                    role="dialog"
                    aria-label="Quick settings"
                    className="absolute right-0 top-full mt-2 w-[300px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-visible z-[70] animate-fade-in-down"
                >
                    <div className="p-3 flex flex-col gap-2.5">
                        <Select
                            label="Theme"
                            value={theme}
                            options={themeOptions}
                            onChange={setTheme}
                            onPreview={previewTheme}
                            previewOnActive
                        />
                        <Select
                            label="Font"
                            value={font}
                            options={fontOptionsFor(font)}
                            onChange={setFont}
                            onPreview={previewFont}
                            previewOnActive
                        />
                        <FontSizeField value={fontSize} onChange={setFontSize} />
                    </div>

                    {/* More settings — opens the full settings modal (AI, editor toggles, about). */}
                    <div className="p-2 border-t border-[var(--border)]">
                        <button
                            onClick={() => { setIsOpen(false); window.dispatchEvent(new CustomEvent("dumont:open-settings")); }}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                            {/* aria-hidden: Material Symbols is a ligature font, so
                                without it this button's name computes to
                                "tuneMore settings…". */}
                            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">tune</span>
                            More settings…
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
