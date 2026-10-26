// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

// Syntax colours for the settings JSON editor (components/SettingsJsonEditor.tsx).
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Every color comes from the theme's CSS variables, so the JSON editor changes
 * theme with everything else rather than pinning one palette.
 *
 * These are TEXT, on --bg-input, and on --bg-hover wherever the caret's line is.
 * That makes 4.5:1 the bar on every theme, which rules out most of the palette:
 * every --syntax-* token falls below it somewhere (--syntax-code bottoms out at
 * 3.48:1, and --accent at 2.37:1, which is the number this project already knows
 * by heart). So the tokens here are the ones the contrast validator guarantees:
 * --focus-ring is held to 4.5:1 on --bg-hover, and --text-primary and
 * --text-secondary are held to it everywhere.
 *
 * The first version of this reached for var(--syntax-heading), var(--syntax-string)
 * and var(--syntax-keyword). NONE of those tokens exists, in any theme, so the
 * fallback silently won every time and the property names, which are the actual
 * content of settings.json, were painted in --accent: 2.37:1 on the active line in
 * vs2017. A CSS variable that does not exist fails quietly, which is exactly why
 * jsonEditorTokens is asserted against the registry in the tests.
 *
 * The comment color is --text-muted on purpose, as in every code editor, and is
 * the one deliberate exception. It is also the token this project exempts from the
 * contrast floor by design.
 */
export const JSON_EDITOR_HIGHLIGHT = HighlightStyle.define([
    { tag: t.propertyName, color: "var(--focus-ring)" },
    { tag: t.string, color: "var(--text-primary)" },
    { tag: t.number, color: "var(--text-secondary)" },
    { tag: t.bool, color: "var(--text-secondary)" },
    { tag: t.null, color: "var(--text-secondary)" },
    { tag: t.comment, color: "var(--text-muted)", fontStyle: "italic" },
    { tag: t.separator, color: "var(--text-muted)" },
]);

/** The tokens above that carry TEXT, so a test can hold them to the 4.5:1 bar. */
export const JSON_EDITOR_TEXT_TOKENS = [
    "--focus-ring",
    "--text-primary",
    "--text-secondary",
] as const;
