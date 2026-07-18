// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The theme registry: the ONE place a theme id becomes colors.
 *
 * Three consumers, and they must never disagree:
 *   - ThemeProvider writes the resolved tokens onto <html>, which is how the app
 *     is painted (index.css is `var(--bg-primary)` all the way down).
 *   - exportUtils bakes the same record into exported HTML/PDF, which is how an
 *     export comes out looking like the app the user is staring at.
 *   - appearanceOptions/schema list the themes and their swatches.
 *
 * There used to be no such place, and the export's private copy of the colors had
 * drifted: seven stale values across four of the five themes, plus a green for code
 * function names that belonged to the dark theme and was painted on all of them.
 * Nobody noticed, because nothing in the codebase could compare the two.
 */
import { BUILTIN_THEMES } from "./builtin";
import { CODE_TOKEN_NAMES, deriveCodeTokens } from "./highlight";
import { BASE_THEME_ID, THEME_TOKEN_NAMES, type ThemeDef, type ThemeTokens } from "./types";

export { BUILTIN_THEMES } from "./builtin";
export { CODE_TOKEN_NAMES, CODE_TOKEN_SOURCE } from "./highlight";
export { BASE_THEME_ID, THEME_TOKEN_NAMES } from "./types";
export type { ThemeDef, ThemeTokens } from "./types";

/** The canonical token names, as a plain array a caller may iterate or sort. */
export function themeTokenNames(): string[] {
    return [...THEME_TOKEN_NAMES];
}

/** Look a theme up among the built-ins and any extras the caller supplies. */
export function findTheme(id: string, extra: readonly ThemeDef[] = []): ThemeDef | undefined {
    // Extras first: a user theme may deliberately replace a built-in by id.
    return extra.find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === id);
}

const BASE = BUILTIN_THEMES.find((t) => t.id === BASE_THEME_ID)!;

/**
 * The color functions a theme value is allowed to call.
 *
 * Deliberately just the ones that PRODUCE A COLOR. `expression()` (dead IE code
 * execution), `url()` and `attr()` (data exfiltration in a `background`) are all
 * syntactically "identifier(...)" too, and none of them is here, so none of them
 * survives sanitizeColor. Adding one means deciding it is a color.
 */
const COLOR_FUNCS = new Set([
    "rgb", "rgba", "hsl", "hsla", "hwb",
    "lab", "lch", "oklab", "oklch",
    "color", "color-mix", "var",
]);

/** Every parenthesis opened is closed, and none closes before it opens. */
function parensBalanced(value: string): boolean {
    let depth = 0;
    for (const ch of value) {
        if (ch === "(") depth++;
        else if (ch === ")" && --depth < 0) return false;
    }
    return depth === 0;
}

/**
 * A color value, if `raw` is one; "" if it is not.
 *
 * This is a trust boundary. A theme can come from a file the user was mailed or
 * pulled off a gist, and its token values are interpolated STRAIGHT into a <style>
 * block when a document is exported (`color: <value>;` in exportUtils). One string
 * concatenation away from the exported HTML is exactly where an injection lives.
 *
 * Two gates, and the division is the point:
 *
 *   1. A CHARACTER allowlist that is the actual security boundary. It permits only
 *      what a color needs and excludes every character that could END the
 *      declaration (`;`), leave its block (`}`), start another property (`:`),
 *      escape the <style> element (`<` `>`), open a CSS comment (`*`, with `/`
 *      already harmless once `*` is gone), or begin an at-rule (`@`). With those
 *      gone, no value can be anything but a single, contained declaration value,
 *      however malformed.
 *
 *   2. A SHAPE allowlist that makes this a lint rather than a scrub. The character
 *      gate alone would pass `expression(alert(1))`: harmless in every engine we
 *      target (CSS expressions died with IE7), but not a color, and so not a
 *      value we have any business emitting. Requiring the string to actually BE a
 *      color, a hex literal, a bare keyword, or a call to a known color function,
 *      turns "safe but ugly" into "rejected".
 *
 * The old version kept the safe characters and returned the scrubbed REMAINDER, so
 * `#12g` became `#12` and `expression(x)` passed through whole. This returns the
 * value untouched when it is a color and "" when it is not: an all-or-nothing
 * lint. A rejected token paints nothing, which is a visible, safe failure in the
 * one file its author can fix.
 */
function sanitizeColor(raw: string): string {
    const value = raw.trim();
    if (!value || value.length > 120) return "";

    // Gate 1: the security boundary. No ; { } : < > @ * \ or quotes, ever.
    if (!/^[#0-9a-zA-Z.,%/()\s-]+$/.test(value)) return "";

    // Gate 2: it must be a color, not merely be spelled with safe characters.

    // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa. Nothing else with a `#`.
    if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value;

    // A bare word is a named color (rebeccapurple), a system color
    // (currentColor) or a keyword (transparent). An unrecognized one is an unknown
    // *keyword*, which paints nothing and, having no parenthesis, can do nothing
    // else, so the 148-name list need not be spelled out to stay safe.
    if (/^[a-z]+$/i.test(value)) return value;

    // Functional notation, nesting allowed (`color-mix(in srgb, var(--a), #fff)`).
    // Every function NAME must be a color function, the parentheses must balance,
    // and the whole value must be one call, so `expression(...)` and `url(...)`
    // are refused by name even though their characters are all permitted.
    if (/^[a-z-]+\(.*\)$/is.test(value) && parensBalanced(value)) {
        const names = value.match(/[a-z-]+(?=\()/gi) ?? [];
        if (names.length > 0 && names.every((n) => COLOR_FUNCS.has(n.toLowerCase()))) {
            return value;
        }
    }

    return "";
}

/**
 * Merge a theme's `extends` chain into one record, child last.
 *
 * A cycle (a -> b -> a) is a broken theme file, not a reason to hang the app: stop
 * at the repeat, and resolve what is left against the base. Same for an `extends`
 * that names a theme nobody has: inherit from the base rather than from nothing,
 * so the result is still a complete, legible theme.
 */
function mergeChain(id: string, extra: readonly ThemeDef[]): Partial<ThemeTokens> {
    const chain: ThemeDef[] = [];
    const seen = new Set<string>();

    let current = findTheme(id, extra);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        chain.unshift(current);
        current = current.extends ? findTheme(current.extends, extra) : undefined;
    }

    // Base first, so every token exists even for a theme that names three of them.
    const merged: Partial<ThemeTokens> = { ...BASE.tokens };
    for (const def of chain) Object.assign(merged, def.tokens);
    return merged;
}

function pickTokens(merged: Partial<ThemeTokens>): ThemeTokens {
    const out: ThemeTokens = {};
    for (const name of THEME_TOKEN_NAMES) {
        // The `??` cannot fire for a well-formed theme: BASE defines all 37, and it
        // is merged in first. It fires for a BASE with a token missing, which the
        // completeness test exists to prevent.
        out[name] = sanitizeColor(merged[name] ?? "");
    }
    return out;
}

function pickCodeTokens(merged: Partial<ThemeTokens>, tokens: ThemeTokens): ThemeTokens {
    const derived = deriveCodeTokens(tokens, merged);
    const out: ThemeTokens = {};
    for (const name of CODE_TOKEN_NAMES) out[name] = sanitizeColor(derived[name] ?? "");
    return out;
}

/**
 * A theme id to its full set of colors: all 37, always, with the `extends` chain
 * merged and the child winning. An unknown id resolves to the base theme rather
 * than to a half-painted app.
 */
export function resolveTheme(id: string, extra: readonly ThemeDef[] = []): ThemeTokens {
    return pickTokens(mergeChain(id, extra));
}

/** The ten code-block colors for a theme: derived from its tokens unless it
 *  declares its own (as vs2017-dark does). See highlight.ts. */
export function resolveCodeTokens(id: string, extra: readonly ThemeDef[] = []): ThemeTokens {
    const merged = mergeChain(id, extra);
    return pickCodeTokens(merged, pickTokens(merged));
}

/**
 * Every custom property the app writes onto <html> for a theme.
 *
 * ThemeProvider applies this record and the export bakes it. Both call THIS
 * function: that is the whole point of the refactor, and parity.test.tsx fails if
 * either one starts computing its colors some other way.
 */
export function resolveThemeStyles(id: string, extra: readonly ThemeDef[] = []): ThemeTokens {
    const merged = mergeChain(id, extra);
    const tokens = pickTokens(merged);
    return { ...tokens, ...pickCodeTokens(merged, tokens) };
}

/** Which OS appearance a theme answers to. Unknown ids follow the base. */
export function themeType(id: string, extra: readonly ThemeDef[] = []): "dark" | "light" {
    return findTheme(id, extra)?.type ?? BASE.type;
}
