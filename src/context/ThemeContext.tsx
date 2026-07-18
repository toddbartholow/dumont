// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from 'react';
import { ensureFontLoaded } from '../fonts';
import { clampFontSize, typeScale } from '../utils/typeScale';
import { fontStack } from '../utils/appearanceOptions';
import { resolveThemeStyles, themeType } from '../themes';
import { useSettings } from '../settings/SettingsProvider';
import { setKnownThemeIds } from '../settings/schema';
import { BUILTIN_THEMES } from '../themes';
import { listen } from '@tauri-apps/api/event';
import { loadUserThemes, type UserThemeProblem } from '../themes/userThemes';
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

interface ThemeContextType {
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

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const KEY_THEME = 'appearance.theme';
const KEY_FONT = 'appearance.font';
const KEY_FONT_SIZE = 'appearance.fontSize';

/** True when the OS reports a light color scheme. Guarded for non-browser
 *  contexts (SSR/tests) where matchMedia is absent. */
function prefersLight(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const { values, present, set } = useSettings();

    // The user's choice, if they have made one. `present` is what makes this
    // possible: a theme key that is absent from settings.json means "no opinion",
    // which is NOT the same as the schema default. Read the default instead and
    // the app is pinned to dark for everyone, forever, and the OS-follow behavior
    // dies silently.
    const chosenTheme = present.has(KEY_THEME) ? (values[KEY_THEME] as Theme) : null;

    // Live state, so a preview can apply without persisting. Seeded from the file,
    // or from the OS when the file has no opinion.
    const [theme, setThemeState] = useState<Theme>(
        () => chosenTheme ?? (prefersLight() ? 'light' : 'dark'),
    );
    const [font, setFontState] = useState<FontFamily>(() => values[KEY_FONT] as FontFamily);
    const [fontSize, setFontSizeState] = useState<FontSize>(() => values[KEY_FONT_SIZE] as number);

    // Follow the file. This is what makes an external edit to settings.json apply
    // live: Rust sees the write, the provider reloads, and these land here.
    useEffect(() => {
        if (chosenTheme) setThemeState(chosenTheme);
    }, [chosenTheme]);
    // Pulled out of the dependency arrays rather than indexed inside them. A member
    // expression in a dep array is opaque to the lint rule, so it could not verify these
    // effects at all, and an effect it cannot verify is an effect nobody is checking.
    const fontFromFile = values[KEY_FONT] as FontFamily;
    const fontSizeFromFile = values[KEY_FONT_SIZE] as number;
    useEffect(() => { setFontState(fontFromFile); }, [fontFromFile]);
    useEffect(() => { setFontSizeState(fontSizeFromFile); }, [fontSizeFromFile]);

    // All three setters are memoised, and this is not tidiness. They go into the context
    // value, and App threads `setTheme` straight into the command palette's useMemo. As
    // plain arrows they were a new function on every render of this provider, so that memo
    // could never hold, no matter how honest its dependency list was. The same trap as
    // useSetting's setter, one layer up.
    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        void set(KEY_THEME, next);
    }, [set]);

    const setFont = useCallback((next: FontFamily) => {
        setFontState(next);
        void set(KEY_FONT, next);
    }, [set]);

    const setFontSize = useCallback((next: FontSize) => {
        const size = clampFontSize(next);
        setFontSizeState(size);
        void set(KEY_FONT_SIZE, size);
    }, [set]);

    // The user's own themes.
    //
    // Loaded here rather than at boot so that a theme dropped into the directory
    // applies LIVE: Rust watches the folder and emits themes-changed, exactly as it
    // does for settings.json. Without this the whole feature is dead code: the
    // registry takes an `extra` argument that nothing was passing, so a theme file
    // could sit in the directory being read by nobody.
    const [userThemes, setUserThemes] = useState<readonly ThemeDef[]>([]);
    const [themeProblems, setThemeProblems] = useState<readonly UserThemeProblem[]>([]);

    useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const { themes, problems } = await loadUserThemes();
            if (!alive) return;
            setUserThemes(themes);
            setThemeProblems(problems);
            // The settings layer validates appearance.theme against this list, and
            // the JSON editor completes from it.
            setKnownThemeIds([...BUILTIN_THEMES.map((t) => t.id), ...themes.map((t) => t.id)]);
        };
        void refresh();

        const un = listen('themes-changed', () => { void refresh(); });
        return () => {
            alive = false;
            void un.then((f) => f());
        };
    }, []);

    // Paint the theme.
    //
    // A theme is data (src/themes), not a [data-theme] block in the stylesheet, so
    // applying one means writing its colors onto <html> as custom properties. The
    // whole app is var(--bg-primary) and friends, so this is all it takes. The
    // :root block in index.css is now only the no-JS fallback (the dark theme's
    // values), exactly as it is for the type scale below.
    //
    // The data-theme attribute stays. No stylesheet rule keys off it any more, but
    // the tests assert on it, and a theme id in the DOM is worth having when you
    // are in the inspector wondering which one you are looking at.
    //
    // data-theme-type is what the diff palette keys off, so a light theme nobody
    // has written yet still gets a legible red and green.
    useEffect(() => {
        const el = document.documentElement;
        const type = themeType(theme, userThemes);
        el.setAttribute('data-theme', theme);
        el.setAttribute('data-theme-type', type);
        const tokens = resolveThemeStyles(theme, userThemes);
        for (const [name, value] of Object.entries(tokens)) {
            el.style.setProperty(name, value);
        }
        // Cache what index.html's anti-flash pre-paint needs to paint THIS theme
        // before React mounts on the next launch or webview reload. The real value
        // is appearance.theme in settings.json, but that sits behind async Tauri IPC
        // that is not up at first paint, so this synchronous localStorage mirror is
        // the only source the pre-paint can read. Storing the resolved --bg-primary
        // (not just the id) keeps it correct for user themes and cannot drift when a
        // built-in theme is added, which is the exact bug this replaced: the old
        // pre-paint read a `dumont-theme` key nothing had written since the theme
        // moved into settings.json, so it silently fell back to the OS light/dark
        // default for every theme.
        try {
            localStorage.setItem('dumont-theme', theme);
            localStorage.setItem('dumont-theme-type', type);
            localStorage.setItem('dumont-theme-bg', tokens['--bg-primary']);
        } catch {
            // localStorage blocked: the pre-paint falls back to the OS default, the
            // same graceful degradation it always had.
        }
    }, [theme, userThemes]);

    // Apply the font and font size. Also lazy-load the chosen body font's CSS (a
    // no-op for the eager Inter default).
    //
    // The size is an arbitrary px number, so its derived values are written as
    // inline custom properties rather than matched by a [data-font-size="…"] rule.
    // The :root defaults in index.css remain the no-JS fallback.
    useEffect(() => {
        // A no-op for a font that is not bundled: a system font is already there,
        // and there is nothing to fetch.
        void ensureFontLoaded(font);
        const el = document.documentElement;
        el.setAttribute('data-font', font);
        el.setAttribute('data-font-size', String(fontSize));

        // Set the stack directly rather than leaning on the [data-font="..."] rules
        // in index.css. Those rules can only match the seven bundled names, so a
        // custom font would silently fall back to Inter. The CSS blocks remain the
        // no-JS default, exactly as with the type scale below.
        el.style.setProperty('--font-body', fontStack(font));

        const scale = typeScale(fontSize);
        el.style.setProperty('--font-size-base', scale.base);
        el.style.setProperty('--font-size-h1', scale.h1);
        el.style.setProperty('--font-size-h2', scale.h2);
        el.style.setProperty('--font-size-h3', scale.h3);
        el.style.setProperty('--line-height', scale.lineHeight);
        el.style.setProperty('--font-size-editor', scale.editor);
        el.style.setProperty('--line-height-editor', scale.editorLineHeight);
    }, [theme, font, fontSize]);

    // Track the OS appearance until the user picks a theme explicitly. Gated on
    // the SETTING being absent rather than on a stored value, so flipping the OS
    // between light and dark never overrides a choice already in settings.json.
    useEffect(() => {
        if (chosenTheme) return;
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = (e: MediaQueryListEvent) => setThemeState(e.matches ? 'light' : 'dark');
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [chosenTheme]);

    return (
        <ThemeContext.Provider value={{
            theme, setTheme, font, setFont, fontSize, setFontSize,
            // State only, deliberately no write. See the interface.
            previewTheme: setThemeState,
            previewFont: setFontState,
            userThemes,
            themeProblems,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}
