// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { createContext, useContext } from 'react';
import type { UserThemeProblem } from '../themes/userThemes';
import type { ThemeDef } from '../themes/types';

/**
 * A built-in theme id, or the filename stem of a theme in the user's themes
 * directory. Not a union of the five built-ins, for the same reason FontFamily is
 * not a union of the seven bundled fonts: the app does not get to decide which
 * themes exist. An id that resolves to nothing falls back to the base theme, and
 * the JSON editor reports it.
 */
export type Theme = string;
/**
 * A bundled font id ('inter', 'lora', ...) OR any CSS font-family list naming a
 * font installed on the machine. It is deliberately not a union of the seven
 * bundled ids: the whole point is that the app does not get to decide which fonts
 * exist. `fontStack()` resolves either form; see utils/appearanceOptions.
 */
export type FontFamily = string;
/** A body font size in px. */
export type FontSize = number;

export interface ThemeContextType {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    font: FontFamily;
    setFont: (font: FontFamily) => void;
    fontSize: FontSize;
    setFontSize: (size: FontSize) => void;
    /**
     * Apply a theme or font WITHOUT recording it as the user's choice.
     *
     * The settings dropdowns preview each option as you arrow or hover over it.
     * Doing that through setTheme used to persist on every hover, and the
     * OS-appearance listener below only follows the system theme while the key is
     * ABSENT. So merely running the mouse down the theme list and pressing Escape
     * silently opted the user out of light/dark following, permanently, from an
     * interaction they explicitly cancelled. Only a commit persists.
     *
     * With settings.json this matters more, not less: a preview must never touch
     * the file. Watching your settings file rewrite itself as the mouse moves
     * would be alarming, and it would spam the disk.
     */
    previewTheme: (theme: Theme) => void;
    previewFont: (font: FontFamily) => void;
    /** Themes the user wrote, from <config>/themes. Empty when there are none. */
    userThemes: readonly ThemeDef[];
    /** Theme files that could not be used, and why. */
    themeProblems: readonly UserThemeProblem[];
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}
