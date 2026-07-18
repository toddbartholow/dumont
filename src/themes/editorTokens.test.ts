// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The settings JSON editor paints real text in theme tokens, and got it wrong in
 * two ways at once, both of which fail SILENTLY:
 *
 *  1. It referenced tokens that do not exist (--syntax-heading, --syntax-string,
 *     --syntax-keyword). A missing CSS variable does not error, it falls back, so
 *     the fallback won every time and nobody noticed.
 *  2. That fallback was --accent, which is 2.37:1 on --bg-hover in vs2017. The
 *     property names, which ARE the content of settings.json, were being drawn at
 *     half the contrast that text requires, on the caret's own line.
 *
 * Neither the contrast validator nor tokenUsage.test.ts could see it: the first
 * reads themes, the second greps Tailwind class strings, and this is a CodeMirror
 * theme object. So it is checked here.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_THEMES, resolveTheme } from "./index";
import { contrastRatio } from "./contrast";
import { JSON_EDITOR_TEXT_TOKENS } from "../components/SettingsJsonEditor";

/** The surfaces the editor's text is actually drawn on. */
const SURFACES = ["--bg-input", "--bg-hover"] as const;

describe("the settings JSON editor's syntax colors", () => {
    it("only uses tokens that exist", () => {
        for (const theme of BUILTIN_THEMES) {
            const tokens = resolveTheme(theme.id);
            for (const token of JSON_EDITOR_TEXT_TOKENS) {
                expect(tokens[token], `${theme.id} is missing ${token}`).toBeDefined();
            }
        }
    });

    it("clears the 4.5:1 text bar on every surface, in every theme", () => {
        const failures: string[] = [];

        for (const theme of BUILTIN_THEMES) {
            const tokens = resolveTheme(theme.id);
            for (const token of JSON_EDITOR_TEXT_TOKENS) {
                for (const surface of SURFACES) {
                    const ratio = contrastRatio(tokens[token], tokens[surface]);
                    if (ratio < 4.5) {
                        failures.push(`${theme.id}: ${token} on ${surface} is ${ratio}:1`);
                    }
                }
            }
        }

        expect(failures, "settings.json is read as text; it needs the text floor").toEqual([]);
    });

    it("would have caught the original bug", () => {
        // The exact regression: --accent, on the active line, in vs2017.
        const vs = resolveTheme("vs2017-dark");
        expect(contrastRatio(vs["--accent"], vs["--bg-hover"])).toBeLessThan(4.5);
        expect(JSON_EDITOR_TEXT_TOKENS).not.toContain("--accent");
    });
});
