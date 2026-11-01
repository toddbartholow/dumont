import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import katex from "katex";
import { hasKatexMarkup, inlineKatexFonts, katexExportCss, usedKatexFamilies } from "./katexExport";
import { generateHTML } from "./exportUtils";

// The real stylesheet, read from disk: vitest stubs CSS imports (?raw included)
// to an empty string.
const KATEX_CSS = readFileSync(resolve(__dirname, "../../node_modules/katex/dist/katex.min.css"), "utf8");
const loadCss = async () => KATEX_CSS;

const FORMULA = katex.renderToString("\\sqrt{x^2} + \\mathbb{R} \\left( \\frac{a}{b} \\right)", { displayMode: true });

describe("hasKatexMarkup", () => {
    it("spots rendered KaTeX and nothing else", () => {
        expect(hasKatexMarkup(FORMULA)).toBe(true);
        expect(hasKatexMarkup('<span class="katex">x</span>')).toBe(true);
        expect(hasKatexMarkup("<p>katex is a library</p>")).toBe(false);
        expect(hasKatexMarkup('<span class="not-katex">x</span>')).toBe(false);
    });
});

describe("usedKatexFamilies", () => {
    it("finds the families a formula's classes call for, and only those", () => {
        const used = usedKatexFamilies(KATEX_CSS, FORMULA);
        expect(used.has("KaTeX_Main")).toBe(true);   // .katex base font
        expect(used.has("KaTeX_Math")).toBe(true);   // italic x
        expect(used.has("KaTeX_AMS")).toBe(true);    // blackboard R
        expect(used.has("KaTeX_Fraktur")).toBe(false);
        expect(used.has("KaTeX_Typewriter")).toBe(false);
        expect(used.has("KaTeX_Script")).toBe(false);
    });
});

describe("inlineKatexFonts", () => {
    it("inlines used faces, drops unused ones, and leaves no relative font URL", () => {
        const out = inlineKatexFonts(KATEX_CSS, new Set(["KaTeX_Main"]), {
            "KaTeX_Main-Regular.woff2": "data:font/woff2;base64,AAAA",
        });
        expect(out).not.toMatch(/url\(\s*['"]?fonts\//);
        expect(out).toContain('src:url(data:font/woff2;base64,AAAA) format("woff2")');
        expect(out).not.toMatch(/@font-face\{[^}]*KaTeX_Fraktur/);
        expect(out).toMatch(/@font-face\{[^}]*KaTeX_Main/);
        // The layout rules themselves are untouched.
        expect(out).toContain(".katex .mfrac");
    });
});

describe("katexExportCss", () => {
    it("returns nothing for a document without math", async () => {
        expect(await katexExportCss("<p>plain</p>", async () => "x", loadCss)).toBe("");
    });

    it("asks only for the faces the document uses", async () => {
        const asked: string[] = [];
        const css = await katexExportCss(
            '<span class="katex"><span class="mord">1</span></span>',
            async (file) => { asked.push(file); return `data:font/woff2;base64,${file}`; },
            loadCss,
        );
        expect(asked.sort()).toEqual([
            "KaTeX_Main-Bold.woff2", "KaTeX_Main-BoldItalic.woff2",
            "KaTeX_Main-Italic.woff2", "KaTeX_Main-Regular.woff2",
        ]);
        expect(css).toContain("data:font/woff2;base64,KaTeX_Main-Regular.woff2");
    });

    it("inlines the real woff2 files through the lazy font imports", async () => {
        const css = await katexExportCss(FORMULA, undefined, loadCss);
        expect(css).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{100,}\) format\("woff2"\)/);
        expect(css).not.toMatch(/url\(\s*['"]?fonts\//);
    });

    it("drops a face whose font cannot be loaded rather than leaving a dead URL", async () => {
        const css = await katexExportCss(FORMULA, async () => null, loadCss);
        expect(css).not.toContain("@font-face");
        expect(css).toContain(".katex");
    });
});

describe("generateHTML", () => {
    it("puts the extra stylesheet in the head", () => {
        const out = generateHTML("<p>x</p>", "t", "light", "inter", 16, [], true, ".katex{color:red}");
        expect(out).toMatch(/<style>\.katex\{color:red\}<\/style>\s*<\/head>/);
        expect(generateHTML("<p>x</p>", "t", "light", "inter", 16, [])).not.toContain("<style></style>");
    });
});
