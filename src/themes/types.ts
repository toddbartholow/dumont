// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * A theme is DATA, not CSS.
 *
 * It used to be four things at once: a [data-theme] block in index.css, a swatch
 * in appearanceOptions, a second hand-written color table in exportUtils, and a
 * union member in ThemeContext. The export copy had already drifted from the CSS
 * (see the CHANGELOG), silently, because nothing could compare them. A theme is
 * now one object; the app, the exports, and (later) a user's own theme file all
 * resolve it through this registry.
 */

/**
 * Colors keyed by CSS custom property name, INCLUDING the leading "--".
 *
 * The keys are the names the stylesheet already uses (`var(--bg-primary)`), which
 * is what lets ThemeProvider apply a theme by writing them straight onto <html>
 * with no translation layer. A camelCase mirror is exactly the sort of second
 * vocabulary that let the export table drift in the first place.
 */
export type ThemeTokens = Record<string, string>;

export interface ThemeDef {
    id: string;
    name: string;
    /** Which OS appearance this theme answers to, and which diff palette it gets. */
    type: "dark" | "light";
    /** Inherit another theme's tokens, so a variant overrides 3 tokens, not 37. */
    extends?: string;
    tokens: Partial<ThemeTokens>;
}

/**
 * The theme vocabulary: every color the app can ask for.
 *
 * The list is explicit rather than derived from the dark theme, so a typo
 * (`--bg-primry`) is a test failure instead of a new token nobody styles. Adding
 * a color to the UI means adding it here and to all five built-ins; the
 * completeness test in themes.test.ts will tell you which ones you forgot.
 */
export const THEME_TOKEN_NAMES = [
    // Surfaces
    "--bg-primary",
    "--bg-secondary",
    "--bg-titlebar",
    "--bg-editor",
    "--bg-gutter",
    "--bg-hover",
    "--bg-input",

    // Text
    "--text-primary",
    "--text-secondary",
    "--text-muted",

    // Accent. See CLAUDE.md on which of these to reach for: --accent is for
    // FILLS, --focus-ring for keyboard cursors and active borders. They are not
    // interchangeable, and on vs2017 they are deliberately different colors.
    "--accent",
    "--accent-hover",
    "--focus-ring",
    "--accent-text",

    // Lines
    "--border",
    "--border-subtle",

    // Prose blocks
    "--code-bg",
    "--code-text",
    "--blockquote-bg",

    // Markdown syntax, in the preview and the editor
    "--syntax-h1",
    "--syntax-h2",
    "--syntax-h3",
    "--syntax-link",
    "--syntax-bold",
    "--syntax-list",
    "--syntax-number",
    "--syntax-quote",
    "--syntax-code",

    // Status. --danger fills, --danger-text is the 4.5:1 variant for error TEXT.
    "--status-saved",
    "--status-unsaved",
    "--danger",
    "--danger-text",

    // Scrollbars
    "--scrollbar-track",
    "--scrollbar-thumb",
    "--scrollbar-hover",

    // Selection
    "--selection-bg",
    "--selection-text",
] as const;

/** The theme every other theme falls back to: it is the one that must be complete. */
export const BASE_THEME_ID = "dark";
