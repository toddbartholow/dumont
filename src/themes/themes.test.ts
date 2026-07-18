// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect } from "vitest";
import {
    BUILTIN_THEMES,
    CODE_TOKEN_NAMES,
    CODE_TOKEN_SOURCE,
    THEME_TOKEN_NAMES,
    findTheme,
    resolveCodeTokens,
    resolveTheme,
    resolveThemeStyles,
    themeTokenNames,
    themeType,
    type ThemeDef,
} from "./index";
import { contrastRatio } from "./contrast";

describe("the built-in themes", () => {
    // A theme whose id changes is a theme every settings.json naming it stops
    // finding, silently, on the next launch. The ids are part of the app's public
    // surface; the names are not.
    it("keeps the shipped ids", () => {
        expect(BUILTIN_THEMES.map((t) => t.id)).toEqual([
            "dark",
            "light",
            "paper",
            "dracula",
            "vs2017-dark",
            "solarized-dark",
            "solarized-light",
            "nord",
            "catppuccin-mocha",
            "catppuccin-latte",
        ]);
    });

    // The point of the test: a token nobody defines is an element nobody styles,
    // and you find out by looking at it. Here you find out by running the suite.
    it.each(BUILTIN_THEMES.map((t) => t.id))("%s defines or inherits all 37 tokens", (id) => {
        const tokens = resolveTheme(id);
        expect(Object.keys(tokens).sort()).toEqual([...THEME_TOKEN_NAMES].sort());
        for (const name of THEME_TOKEN_NAMES) {
            expect(tokens[name], `${id} ${name}`).toMatch(/\S/);
        }
    });

    // Catches --bg-primry, which would otherwise resolve to nothing at all and
    // leave the surface it names unpainted.
    it.each(BUILTIN_THEMES.map((t) => t.id))("%s declares no unknown token", (id) => {
        const known = new Set<string>([...THEME_TOKEN_NAMES, ...CODE_TOKEN_NAMES]);
        for (const name of Object.keys(findTheme(id)!.tokens)) {
            expect(known.has(name), `${id} declares unknown token ${name}`).toBe(true);
        }
    });

    // Spot checks on the colors that were lifted out of index.css. Not every
    // value (that would just be builtin.ts typed twice), but the three that carry a
    // contrast fix and the one the export table had gone stale on.
    it("ships the accessible values, not the ones they replaced", () => {
        expect(resolveTheme("dark")["--text-secondary"]).toBe("#8a8a8a"); // not #737373
        expect(resolveTheme("paper")["--text-muted"]).toBe("#7a7160"); // not #9a8f7a
        expect(resolveTheme("vs2017-dark")["--text-secondary"]).toBe("#b0b0b0"); // not #9d9d9d
        expect(resolveTheme("vs2017-dark")["--focus-ring"]).toBe("#4fc1ff"); // not --accent
    });

    /**
     * The ported palettes deviate from their upstream hexes, deliberately, and each
     * of these is the one token someone will "fix" back to the famous value.
     *
     * Every deviation is a contrast floor. What is preserved is the HUE: Solarized's
     * keywords are green and its strings cyan, Nord's strings are Aurora green, and
     * that is what makes a palette recognizable. What moves is lightness, and only far
     * enough to clear the floor. See the legibility test below for the floor itself.
     */
    it("keeps the ported themes' accessibility deviations", () => {
        // Solarized Light's own text tones do not clear AA on Solarized Light's own
        // backgrounds: base00 (body) is 4.13:1 on base3, base01 (emphasized) is
        // 4.39:1 on base2. This is the palette's best-known flaw, not a porting slip.
        expect(resolveTheme("solarized-light")["--text-primary"]).toBe("#073642"); // base02, not base01
        expect(resolveTheme("solarized-light")["--text-secondary"]).toBe("#4a5d63"); // not base00

        // Solarized's blue is squeezed: #268bd2 carries base03 at 4.08:1 and base3 at
        // 3.41:1, so it holds AA text on neither ground. The two modes cannot share
        // one blue fill, and each moves its own way.
        expect(resolveTheme("solarized-dark")["--accent"]).toBe("#3d9bdb"); // lightened
        expect(resolveTheme("solarized-light")["--accent"]).toBe("#1a6fa8"); // darkened

        // nord8 is 4.31:1 on nord2, just under the 4.5 floor for the text a focus ring
        // carries on a hover row.
        expect(resolveTheme("nord")["--focus-ring"]).toBe("#96c8d6"); // not nord8 #88c0d0

        // Latte's mauve is 3.51:1 on surface0, well under it.
        expect(resolveTheme("catppuccin-latte")["--focus-ring"]).toBe("#7230c9"); // not mauve #8839ef
        // ...but Mocha's clears it, so Mocha's accent carries its own ring unchanged.
        expect(resolveTheme("catppuccin-mocha")["--focus-ring"]).toBe("#cba6f7"); // mauve, untouched
    });

    /**
     * A color that renders WORDS is measured against the surface those words land on.
     *
     * checkContrast() governs the app's chrome and stops at the document: it has no
     * opinion about --hljs-comment or --syntax-quote, because for the original five
     * themes it never needed one. The ported palettes needed one badly. Nord's comment
     * (nord3) is 1.4:1 on the surface a code block is drawn on, Catppuccin Latte's
     * yellow is 2.15:1, and Solarized Light's comment tone is 2.0:1. Those are not
     * quiet colors, they are absent ones, and every theme that shipped before this
     * one puts its comments at 5:1 or better.
     *
     * Two surfaces, and getting them right is the whole test: a code token is drawn on
     * --code-bg and NOT on the page, which is how inline code slipped through at 4.26:1
     * while measuring a comfortable 4.84:1 against a background it never touches.
     *
     * Scoped to the ported themes on purpose. Three of the original five are below this
     * floor somewhere (the light theme paints code function names at 2.95:1), and those
     * are shipped colors with their own history: raising them is a separate decision,
     * not something to smuggle in under a port.
     */
    it("sets the ported themes' code and prose in colors you can actually read", () => {
        const PORTED = ["solarized-dark", "solarized-light", "nord", "catppuccin-mocha", "catppuccin-latte"];
        // Drawn on --code-bg: the ten code colors, plus the inline-code span.
        const ON_CODE_BG = [...CODE_TOKEN_NAMES, "--code-text"];
        // Drawn on --bg-editor, at body size, so they owe the 4.5 text floor.
        const ON_EDITOR = ["--syntax-link", "--syntax-list", "--syntax-number", "--syntax-quote",
            "--syntax-code", "--syntax-bold"];
        // Headings are large text, which WCAG puts at 3:1.
        const HEADINGS = ["--syntax-h1", "--syntax-h2", "--syntax-h3"];

        for (const id of PORTED) {
            const s = resolveThemeStyles(id);
            for (const name of ON_CODE_BG) {
                expect(contrastRatio(s[name], s["--code-bg"]), `${id} ${name} on --code-bg`)
                    .toBeGreaterThanOrEqual(4.5);
            }
            for (const name of ON_EDITOR) {
                expect(contrastRatio(s[name], s["--bg-editor"]), `${id} ${name} on --bg-editor`)
                    .toBeGreaterThanOrEqual(4.5);
            }
            for (const name of HEADINGS) {
                expect(contrastRatio(s[name], s["--bg-editor"]), `${id} ${name} on --bg-editor`)
                    .toBeGreaterThanOrEqual(3);
            }
        }
    });

    it("knows which OS appearance each theme answers to", () => {
        expect(themeType("dark")).toBe("dark");
        expect(themeType("paper")).toBe("light");
        expect(themeType("dracula")).toBe("dark");
        expect(themeType("solarized-light")).toBe("light");
        expect(themeType("catppuccin-latte")).toBe("light");
        expect(themeType("catppuccin-mocha")).toBe("dark");
        expect(themeType("nord")).toBe("dark");
        // An id nobody has follows the base rather than throwing.
        expect(themeType("no-such-theme")).toBe("dark");
    });
});

describe("resolveTheme", () => {
    it("returns the base theme for an id nobody has", () => {
        // A corrupt settings.json must not leave the app unpainted, and the schema
        // already coerces an unknown theme back to the default anyway.
        expect(resolveTheme("no-such-theme")).toEqual(resolveTheme("dark"));
    });

    it("fills in from the base, so a theme may name three tokens and mean it", () => {
        const sparse: ThemeDef = {
            id: "sparse",
            name: "Sparse",
            type: "dark",
            tokens: { "--accent": "#ff0000" },
        };
        const tokens = resolveTheme("sparse", [sparse]);
        expect(tokens["--accent"]).toBe("#ff0000");
        expect(tokens["--bg-primary"]).toBe(resolveTheme("dark")["--bg-primary"]);
        expect(Object.keys(tokens)).toHaveLength(37);
    });

    it("lets an extra theme replace a built-in by id", () => {
        const shadow: ThemeDef = {
            id: "dark",
            name: "Dark (theirs)",
            type: "dark",
            tokens: { "--bg-primary": "#000000" },
        };
        expect(resolveTheme("dark", [shadow])["--bg-primary"]).toBe("#000000");
    });

    it("strips anything that could escape the declaration it is written into", () => {
        // Token values are interpolated into a <style> block on export, so once a
        // theme can come from a user's file this is the same injection surface
        // sanitizeFontStack() closes for the font.
        const hostile: ThemeDef = {
            id: "hostile",
            name: "Hostile",
            type: "dark",
            tokens: { "--bg-primary": "#fff; } body { display: none } .x {" },
        };
        const value = resolveTheme("hostile", [hostile])["--bg-primary"];
        expect(value).not.toMatch(/[;{}]/);
        // A legitimate color goes through untouched.
        expect(resolveTheme("dark")["--accent-hover"]).toBe("rgba(255, 255, 255, 0.9)");
    });
});

describe("extends", () => {
    const base: ThemeDef = {
        id: "child-base",
        name: "Base",
        type: "light",
        tokens: { "--bg-primary": "#111111", "--accent": "#222222", "--border": "#333333" },
    };
    const child: ThemeDef = {
        id: "child",
        name: "Child",
        type: "light",
        extends: "child-base",
        tokens: { "--accent": "#ff0000" },
    };

    it("inherits the parent's tokens and lets the child win", () => {
        const tokens = resolveTheme("child", [base, child]);
        expect(tokens["--accent"]).toBe("#ff0000"); // the child's
        expect(tokens["--bg-primary"]).toBe("#111111"); // the parent's
        expect(tokens["--border"]).toBe("#333333"); // the parent's
        // And everything neither of them mentioned still exists.
        expect(tokens["--scrollbar-thumb"]).toBe(resolveTheme("dark")["--scrollbar-thumb"]);
    });

    it("merges a chain deeper than one link", () => {
        const grandchild: ThemeDef = {
            id: "grandchild",
            name: "Grandchild",
            type: "light",
            extends: "child",
            tokens: { "--border": "#00ff00" },
        };
        const tokens = resolveTheme("grandchild", [base, child, grandchild]);
        expect(tokens["--border"]).toBe("#00ff00"); // its own
        expect(tokens["--accent"]).toBe("#ff0000"); // its parent's
        expect(tokens["--bg-primary"]).toBe("#111111"); // its grandparent's
    });

    it("inherits from the base when it names a theme nobody has", () => {
        const orphan: ThemeDef = {
            id: "orphan",
            name: "Orphan",
            type: "dark",
            extends: "no-such-theme",
            tokens: { "--accent": "#ff0000" },
        };
        const tokens = resolveTheme("orphan", [orphan]);
        expect(tokens["--accent"]).toBe("#ff0000");
        expect(tokens["--bg-primary"]).toBe(resolveTheme("dark")["--bg-primary"]);
    });

    // A hand-written theme file can say anything, including something circular. It
    // must be a broken theme, never a hung app: the chain walk stops at the repeat.
    it("does not hang on a cycle, and still resolves every token", () => {
        const a: ThemeDef = { id: "a", name: "A", type: "dark", extends: "b", tokens: { "--accent": "#aaaaaa" } };
        const b: ThemeDef = { id: "b", name: "B", type: "dark", extends: "a", tokens: { "--border": "#bbbbbb" } };

        const tokens = resolveTheme("a", [a, b]);
        expect(Object.keys(tokens)).toHaveLength(37);
        expect(tokens["--accent"]).toBe("#aaaaaa"); // a's own token still wins
        expect(tokens["--bg-primary"]).toBe(resolveTheme("dark")["--bg-primary"]);
    });

    it("does not hang on a theme that extends itself", () => {
        const self: ThemeDef = {
            id: "self",
            name: "Self",
            type: "dark",
            extends: "self",
            tokens: { "--accent": "#ff0000" },
        };
        expect(resolveTheme("self", [self])["--accent"]).toBe("#ff0000");
    });
});

describe("code-block colors", () => {
    it("derives from the theme's own syntax tokens by default", () => {
        for (const id of ["dark", "light", "paper", "dracula"]) {
            const tokens = resolveTheme(id);
            const code = resolveCodeTokens(id);
            for (const [name, source] of Object.entries(CODE_TOKEN_SOURCE)) {
                expect(code[name], `${id} ${name}`).toBe(tokens[source]);
            }
        }
    });

    // Visual Studio's C/C++ palette is what that theme IS. The generic derivation
    // would paint its function names green, which no VS user has ever seen.
    it("lets a theme keep its own palette", () => {
        const code = resolveCodeTokens("vs2017-dark");
        expect(code["--hljs-string"]).toBe("#d69d85");
        expect(code["--hljs-comment"]).toBe("#57a64a");
        expect(code["--hljs-function"]).toBe("#dcdcdc"); // plain, as in the real IDE
        expect(code["--hljs-built-in"]).toBe("#4ec9b0");
        // And it is NOT the generic mapping's answer.
        expect(code["--hljs-function"]).not.toBe(resolveTheme("vs2017-dark")["--status-saved"]);
    });

    /**
     * The ported themes declare their own code colors, for the reason vs2017 does.
     *
     * The generic derivation maps --hljs-string to --syntax-bold, which in every one
     * of these themes is the near-white body tone. Derived, a Solarized code block
     * would set its strings in base2 instead of cyan and its keywords in cyan instead
     * of green, and a Nord one would lose the Aurora palette entirely. The code block
     * is a substantial part of what makes each of these recognizable, so it is spelled
     * out rather than inferred.
     */
    it("gives the ported themes their real code palettes, not the derivation's", () => {
        const solarized = resolveCodeTokens("solarized-dark");
        expect(solarized["--hljs-keyword"]).toBe("#92a800"); // green
        expect(solarized["--hljs-string"]).toBe("#2dada3"); // cyan
        // And NOT what the generic mapping would have said: base1, the body tone.
        expect(solarized["--hljs-string"]).not.toBe(resolveTheme("solarized-dark")["--syntax-bold"]);

        const nord = resolveCodeTokens("nord");
        expect(nord["--hljs-keyword"]).toBe("#99b3cd"); // nord9
        expect(nord["--hljs-string"]).toBe("#a3be8c"); // nord14, straight from the Aurora palette
        expect(nord["--hljs-string"]).not.toBe(resolveTheme("nord")["--syntax-bold"]);

        // Mocha is the one palette that needed no adjusting anywhere: every code color
        // it publishes already clears the floor, so these are its exact hexes.
        const mocha = resolveCodeTokens("catppuccin-mocha");
        expect(mocha["--hljs-keyword"]).toBe("#cba6f7"); // mauve
        expect(mocha["--hljs-string"]).toBe("#a6e3a1"); // green
        expect(mocha["--hljs-comment"]).toBe("#9399b2"); // overlay2
        expect(mocha["--hljs-string"]).not.toBe(resolveTheme("catppuccin-mocha")["--syntax-bold"]);
    });

    it("gives an inherited theme its parent's palette", () => {
        const variant: ThemeDef = {
            id: "vs-variant",
            name: "VS variant",
            type: "dark",
            extends: "vs2017-dark",
            tokens: { "--accent": "#ff0000" },
        };
        expect(resolveCodeTokens("vs-variant", [variant])["--hljs-string"]).toBe("#d69d85");
    });
});

describe("the registry's shape", () => {
    it("names all 37 tokens, and no more", () => {
        expect(themeTokenNames()).toHaveLength(37);
        expect(new Set(themeTokenNames()).size).toBe(37);
    });

    it("hands out a copy, so a caller cannot edit the vocabulary", () => {
        const names = themeTokenNames();
        names.push("--nonsense");
        expect(themeTokenNames()).toHaveLength(37);
    });

    it("resolveThemeStyles is the theme tokens plus the code tokens", () => {
        const styles = resolveThemeStyles("dracula");
        expect(Object.keys(styles)).toHaveLength(37 + CODE_TOKEN_NAMES.length);
        expect(styles).toEqual({ ...resolveTheme("dracula"), ...resolveCodeTokens("dracula") });
    });
});

/**
 * Color values are a trust boundary.
 *
 * A theme can arrive as a file the user was sent or pulled off a gist, and its
 * token values are interpolated straight into a <style> block when a document is
 * exported (`color: <value>;`, see exportUtils). sanitizeColor is what stands
 * between that file and the exported HTML, so these tests drive the real path a
 * shared theme takes: crafted ThemeDef -> resolveThemeStyles -> the string that
 * gets baked. The private function is exercised through the public API on purpose,
 * because that is the API the export actually calls.
 */
describe("a hostile color value cannot escape the declaration it is baked into", () => {
    const resolved = (value: string, token = "--bg-primary") =>
        resolveThemeStyles("evil", [{ id: "evil", name: "Evil", type: "dark", tokens: { [token]: value } }])[token];

    // The two that matter most: closing the declaration to inject a new rule, and
    // escaping the <style> element outright. Both must come out empty.
    it.each([
        ["close the declaration and add a rule", "red; } body { display:none } .x {"],
        ["escape the <style> element", "red</style><script>alert(1)</script>"],
        ["open an at-rule", "red;@import url(http://evil)"],
        ["start a second property", "rgb(1,2,3);color:blue"],
        ["open a CSS comment", "red /* x */ ; background:url(evil)"],
    ])("neutralises an attempt to %s", (_label, payload) => {
        expect(resolved(payload)).toBe("");
    });

    // Inert in every engine we target, but not a color, so a lint drops it where
    // the old character scrub would have passed it through whole.
    it.each([
        ["expression()", "expression(alert(1))"],
        ["url()", "url(https://evil.test/x.png)"],
        ["attr()", "attr(href)"],
        ["image-set()", "image-set(url(x.png) 1x)"],
        ["!important", "red !important"],
        ["a CSS-escaped url()", "\\75rl(evil)"],
    ])("rejects %s, which is not a color function", (_label, payload) => {
        expect(resolved(payload)).toBe("");
    });

    it("guards a code token as well as a surface token", () => {
        // --hljs-* values are baked into the same <style> block, so they run the
        // same gate. A user theme may set them (KNOWN_TOKENS includes them).
        expect(resolved("red; }", "--hljs-keyword")).toBe("");
    });

    it("rejects a malformed hex rather than keeping its valid prefix", () => {
        // The old scrub turned #12g into #12. All-or-nothing now.
        expect(resolved("#12g")).toBe("");
        expect(resolved("#менее")).toBe("");
    });

    // The other half of a lint: everything that IS a color survives byte for byte,
    // so no legitimate theme is quietly repainted.
    it.each([
        "#0a0a0a", "#fff", "#ffffffaa",
        "rgba(255, 255, 255, 0.9)", "rgb(255 0 0 / 50%)", "hsl(120, 50%, 50%)",
        "transparent", "currentColor", "rebeccapurple",
        "var(--accent)", "var(--x, #fff)", "color-mix(in srgb, #fff 50%, #000)",
    ])("passes the real color %s through untouched", (value) => {
        expect(resolved(value)).toBe(value);
    });

    it("leaves every shipped token painted", () => {
        // The gate is applied to the built-ins too, so a rule strict enough to
        // empty a real value would surface here first.
        for (const t of BUILTIN_THEMES) {
            for (const [name, value] of Object.entries(resolveThemeStyles(t.id))) {
                expect(value, `${t.id} ${name}`).toMatch(/\S/);
            }
        }
    });
});
