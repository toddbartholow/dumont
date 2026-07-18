/**
 * The themes and fonts offered in the UI, in display order.
 *
 * Single source of truth for both settings surfaces (the gear dropdown and the
 * full modal) and for the command palette. They each used to carry their own copy,
 * which had already drifted: the dropdown previewed Inter with a shorter font
 * stack than the one index.css actually applies.
 *
 * The `stack` values must stay in sync with the [data-font] rules in index.css.
 * The theme colors no longer need keeping in sync with anything, because they are
 * read from the theme itself (src/themes).
 */
import type { Theme, FontFamily } from '../context/ThemeContext';
import { BUILTIN_THEMES, resolveTheme } from '../themes';

export interface ThemeOption {
    id: Theme;
    name: string;
    /** [page, accent]: the two-tone swatch shown next to the name. */
    colors: [string, string];
}

export interface FontOption {
    id: FontFamily;
    name: string;
    /** "Serif" / "Sans-serif" / "Monospace" — the secondary label. */
    kind: string;
    /** The full font-family stack, so each option can preview in its own face. */
    stack: string;
}

/**
 * The themes, straight from the registry.
 *
 * The swatch is the theme's own colors, not a pair of hexes typed out next to the
 * name. Three of the original five had been hand-picked from some other token
 * (light's was its titlebar, Dracula's its hover state), so the swatch showed a
 * color the theme did not paint anything with, and nothing would have told us if
 * the theme had moved out from under it. A user's theme gets a swatch for free,
 * which it could not have done from a literal.
 *
 * The second tone is the ACCENT, not the panel surface. Page-plus-panel worked
 * while the five themes all had a visible step between the two, and stopped working
 * the moment the ported ones arrived: Solarized Dark is #002b36 on #00212b, Mocha
 * #1e1e2e on #181825, Latte #eff1f5 on #e6e9ef. Those swatches are flat squares,
 * and three flat dark squares in a row tell you nothing about which theme is which.
 * The accent is the one color that actually names a theme on sight, and it is the
 * thing a person picking Dracula over Nord is choosing between.
 */
export const THEMES: readonly ThemeOption[] = BUILTIN_THEMES.map((def) => {
    const tokens = resolveTheme(def.id);
    return {
        id: def.id as Theme,
        name: def.name,
        colors: [tokens['--bg-primary'], tokens['--accent']],
    };
});

export const FONTS: readonly FontOption[] = [
    { id: 'inter', name: 'Inter', kind: 'Sans-serif', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    { id: 'merriweather', name: 'Merriweather', kind: 'Serif', stack: "'Merriweather', Georgia, 'Times New Roman', serif" },
    { id: 'lora', name: 'Lora', kind: 'Serif', stack: "'Lora', Georgia, 'Times New Roman', serif" },
    { id: 'source-serif', name: 'Source Serif', kind: 'Serif', stack: "'Source Serif 4', Georgia, 'Times New Roman', serif" },
    { id: 'fira-sans', name: 'Fira Sans', kind: 'Sans-serif', stack: "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    { id: 'hack-nerd', name: 'Hack Nerd Font', kind: 'Monospace', stack: "'Hack Nerd Font Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" },
    // Already bundled (it's the code face), so it costs nothing to offer — and
    // it's the editor's historical typeface, for anyone who wants it back.
    { id: 'jetbrains-mono', name: 'JetBrains Mono', kind: 'Monospace', stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" },
];

/** True when `font` is one of the bundled options rather than a custom stack. */
export function isBundledFont(font: string): boolean {
    return FONTS.some((f) => f.id === font);
}

/**
 * Strip anything that could escape a CSS declaration.
 *
 * A font is no longer a value from a fixed list: it can be any string the user
 * typed into settings.json, and it is interpolated into a `font-family:` rule in
 * exported HTML. A value like `x; } body { display: none } .z {` would otherwise
 * escape the declaration and rewrite the exported document. `style.setProperty`
 * is stricter and would just drop it, but the export path is plain string
 * interpolation, so this has to hold for both.
 *
 * Anything up to the first `;` is kept, so a stray semicolon truncates the stack
 * instead of injecting.
 */
export function sanitizeFontStack(raw: string): string {
    return raw
        .split(';')[0]
        .replace(/[{}<>@\\]/g, '')
        .replace(/\/\*|\*\//g, '')
        .trim()
        .slice(0, 200);
}

/**
 * The CSS font-family value for a font setting.
 *
 * THE one place a font id turns into a stack. There used to be three copies of
 * these strings (this list, the [data-font] rules in index.css, and a private map
 * in exportUtils), which is the same duplication that let the theme list drift.
 *
 * An unrecognized value is not an error: it is treated as a CSS font-family list,
 * so any font installed on the machine works by naming it. That is what makes
 * fonts extensible without a plugin system, a download, or a restart.
 */
export function fontStack(font: string): string {
    const bundled = FONTS.find((f) => f.id === font);
    if (bundled) return bundled.stack;

    const custom = sanitizeFontStack(font);
    if (!custom) return FONTS[0].stack;
    // Fall back through the generic family so a misspelled name degrades to
    // something readable rather than to the browser's default serif.
    return `${custom}, ${FONTS[0].stack}`;
}
