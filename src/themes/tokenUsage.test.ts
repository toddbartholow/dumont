// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * Color tokens are only legible against the surface they are actually drawn on,
 * and that is a fact about the MARKUP, not about the palette. No amount of
 * checking contrast between token pairs can tell you which pairs meet on screen.
 * This test reads the components and enforces it there.
 *
 * The rule it guards: `--accent` may not be drawn on `--bg-hover`.
 *
 * `--accent` is a FILL token, held to 3:1. In vs2017 it is #007acc, which is
 * 3.70:1 on the panel but only 2.37:1 on --bg-hover. Seven components drew it
 * there anyway (an active toolbar button's text, the title bar's active state,
 * the AI panel's "selection" badge, the settings cards' selected ring, the table
 * of contents' active border), so in that theme those indicators were all but
 * invisible, and the three that were TEXT needed 4.5:1 and had 2.37:1.
 *
 * `--focus-ring` exists for exactly this: things drawn on --bg-hover. It is
 * #4fc1ff in vs2017 (5.29:1 there) and #d6bcfa in dracula (5.42:1).
 *
 * A token-pair contrast checker cannot catch a regression here, because once the
 * usages are fixed the pair no longer co-occurs and measuring it would condemn a
 * theme for a condition that is not on screen. The invariant lives in the markup,
 * so the test does too.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
}

/**
 * The class string a match sits inside, from the quote that opens it to the one
 * that closes it. The exemptions have to be read from the SAME string as the token,
 * not the whole source line: an icon in one element on a physical line must not
 * launder muted body text sitting in a different element on that same line.
 */
function enclosingClassList(line: string, at: number): string {
    const isQuote = (c: string) => c === '"' || c === "'" || c === "`";
    let start = at;
    while (start > 0 && !isQuote(line[start - 1])) start--;
    let end = at;
    while (end < line.length && !isQuote(line[end])) end++;
    return line.slice(start, end);
}

/** A class list that paints --bg-hover AND an --accent foreground on it. */
const DRAWS_ACCENT_ON_HOVER =
    /bg-\[var\(--bg-hover\)\][^"'`]*(?:text|ring|border)-\[var\(--accent\)\]|(?:text|ring|border)-\[var\(--accent\)\][^"'`]*bg-\[var\(--bg-hover\)\]/;

describe("color tokens are used on surfaces they contrast with", () => {
    it("never draws --accent on --bg-hover (use --focus-ring)", () => {
        const offenders: string[] = [];

        for (const file of sourceFiles("src")) {
            readFileSync(file, "utf8").split("\n").forEach((line, i) => {
                if (DRAWS_ACCENT_ON_HOVER.test(line)) offenders.push(`${file}:${i + 1}`);
            });
        }

        expect(
            offenders,
            "--accent is only 2.37:1 on --bg-hover in vs2017. Use --focus-ring for anything drawn on a hover surface.",
        ).toEqual([]);
    });

    /**
     * --text-muted may not paint TEXT.
     *
     * It fails the 4.5:1 floor on every single theme, on both surfaces: 2.11:1 on nord, and
     * even the best case (paper) only reaches 4.24:1. And it had become the app's de facto
     * secondary text color: every setting's description, every backlink's line number, every
     * command's shortcut hint, the recent-files list, the empty states, the placeholders. Sixty
     * sites of real copy that a user is meant to read, in a color no theme makes readable.
     *
     * contrast.ts exempts the token from its linted floor on the grounds that it "paints
     * decorative things". That was not true when it was written. It is true now, and this test
     * is what keeps it true, because a contrast checker over token PAIRS structurally cannot:
     * the pair is only a violation when the markup puts them together, and the markup is here.
     *
     * It reads all of src, not just src/components. App.tsx and the settings and context
     * trees render just as much chrome, and a muted line of copy added there has to fail too.
     *
     * What may still use it, and why:
     *   - the minimap, which is aria-hidden, is a canvas, and draws at low alpha. Raising the
     *     token for AA once made the overview brighter than the document it summarizes.
     *   - `material-symbols-outlined` glyphs that sit beside text saying the same thing.
     *     Redundant decoration, not content. (The exemption keys on that class, not on
     *     aria-hidden: not every such glyph carries the attribute, but each is an icon.)
     *   - a DISABLED control (ExportMenu), which has to look disabled. WCAG 1.4.3 exempts
     *     inactive components for that exact reason.
     *   - the editor's own gutter and the settings-JSON comment color, where dimming is a
     *     deliberate, universal editor convention. Called out as a known exception, with
     *     numbers, rather than pretended away.
     *
     * One thing this does NOT catch: --text-muted set as an inline `color:` value instead
     * of a Tailwind class. The only uses of that form are the two editor holdouts just
     * named (a CodeMirror theme is a JS object, not markup), so matching it would flag
     * exactly what is meant to stay. Components set text color with the class form, and
     * that is what is guarded; a future inline-style muted TEXT site would slip through.
     */
    it("never paints text with --text-muted (use --text-secondary)", () => {
        const MUTED_TEXT = /text-\[var\(--text-muted\)\]/g;
        const offenders: string[] = [];
        for (const file of sourceFiles("src")) {
            readFileSync(file, "utf8").split("\n").forEach((line, i) => {
                for (const m of line.matchAll(MUTED_TEXT)) {
                    const cls = enclosingClassList(line, m.index ?? 0);
                    // An icon glyph is decoration, redundant with adjacent text.
                    if (cls.includes("material-symbols-outlined")) continue;
                    // A disabled control must look disabled; WCAG 1.4.3 exempts it.
                    if (cls.includes("cursor-not-allowed")) continue;
                    offenders.push(`${file}:${i + 1}`);
                }
            });
        }

        expect(
            offenders,
            "--text-muted fails 4.5:1 on ALL ten themes (nord 2.11:1). Text belongs in --text-secondary.",
        ).toEqual([]);
    });
});
