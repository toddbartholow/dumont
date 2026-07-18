// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * Code-block colors (highlight.js), derived from the theme's markdown tokens.
 *
 * index.css used to paint these with `color: var(--syntax-h2)` and friends, and
 * exportUtils re-implemented the same mapping in TypeScript with two of the
 * colors hardcoded (`#22c55e` for functions on every theme, even the ones whose
 * --status-saved is not that green). vs2017-dark then overrode the lot twice
 * over: once as a [data-theme="vs2017-dark"] .hljs-* block in index.css, and
 * again as a literal object in exportUtils. Three copies of one palette.
 *
 * Now: derive the ten colors from the theme's own tokens, resolve them once, and
 * write them onto <html> as --hljs-* properties. index.css reads those, and the
 * export bakes the same record. A theme that wants its own code palette (as
 * vs2017 does, because Visual Studio's C/C++ colors ARE its identity) declares
 * the --hljs-* tokens itself and they win. That hook is what makes a user-supplied
 * theme's code blocks look deliberate rather than accidental.
 */
import type { ThemeTokens } from "./types";

/**
 * Which theme token each code color falls back to.
 *
 * These reproduce the generic .hljs-* rules index.css shipped, so no built-in
 * theme's code blocks change color. They are a mapping of convenience, not of
 * meaning: a number is not a heading. That is why a theme can override them.
 */
export const CODE_TOKEN_SOURCE: Readonly<Record<string, string>> = {
    "--hljs-keyword": "--syntax-h2",
    "--hljs-string": "--syntax-bold",
    "--hljs-number": "--syntax-h1",
    "--hljs-literal": "--syntax-h1",
    "--hljs-function": "--status-saved",
    "--hljs-title": "--status-saved",
    "--hljs-attr": "--status-saved",
    "--hljs-params": "--syntax-number",
    "--hljs-comment": "--text-secondary",
    "--hljs-built-in": "--syntax-link",
};

export const CODE_TOKEN_NAMES = Object.keys(CODE_TOKEN_SOURCE);

/**
 * The ten code colors for a theme.
 *
 * `declared` is the theme's own token record (already merged along its `extends`
 * chain): anything it names explicitly wins over the derivation.
 */
export function deriveCodeTokens(
    tokens: ThemeTokens,
    declared: Partial<ThemeTokens> = {},
): ThemeTokens {
    const out: ThemeTokens = {};
    for (const [name, source] of Object.entries(CODE_TOKEN_SOURCE)) {
        out[name] = declared[name] ?? tokens[source] ?? "";
    }
    return out;
}
