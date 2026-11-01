/**
 * KaTeX's stylesheet for exported HTML and PDF.
 *
 * Exports capture the reader's DOM, which carries KaTeX's rendered spans, and
 * their layout depends entirely on katex.min.css: without it every formula in
 * an export came out as jumbled, unpositioned glyphs. The stylesheet is
 * inlined into the export when the document contains KaTeX markup.
 *
 * Its @font-face rules point at `fonts/KaTeX_*.woff2`, relative URLs that
 * resolve to nothing in a standalone file (or in the temp file the PDF is
 * printed from), and the browser's fallback serif cannot draw radicals, big
 * delimiters or blackboard letters. So the fonts a document's formulas
 * actually use are inlined as data: URLs, and the faces it does not use are
 * dropped. A family counts as used when a KaTeX rule naming it has a selector
 * whose classes all appear in the exported markup.
 *
 * Everything here is lazy: the stylesheet and each font are their own dynamic
 * imports, so none of it reaches the startup bundle (KaTeX itself is already
 * loaded only for documents with math).
 */

type FontLoader = () => Promise<{ default: string }>;

// One explicit import per face, so Vite emits each as its own lazily loaded
// chunk holding the base64 data URL. The keys are the file names katex.min.css
// refers to.
const FONT_LOADERS: Record<string, FontLoader> = {
    "KaTeX_AMS-Regular.woff2": () => import("katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline"),
    "KaTeX_Caligraphic-Bold.woff2": () => import("katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline"),
    "KaTeX_Caligraphic-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline"),
    "KaTeX_Fraktur-Bold.woff2": () => import("katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline"),
    "KaTeX_Fraktur-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline"),
    "KaTeX_Main-Bold.woff2": () => import("katex/dist/fonts/KaTeX_Main-Bold.woff2?inline"),
    "KaTeX_Main-BoldItalic.woff2": () => import("katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline"),
    "KaTeX_Main-Italic.woff2": () => import("katex/dist/fonts/KaTeX_Main-Italic.woff2?inline"),
    "KaTeX_Main-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Main-Regular.woff2?inline"),
    "KaTeX_Math-BoldItalic.woff2": () => import("katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline"),
    "KaTeX_Math-Italic.woff2": () => import("katex/dist/fonts/KaTeX_Math-Italic.woff2?inline"),
    "KaTeX_SansSerif-Bold.woff2": () => import("katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline"),
    "KaTeX_SansSerif-Italic.woff2": () => import("katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline"),
    "KaTeX_SansSerif-Regular.woff2": () => import("katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline"),
    "KaTeX_Script-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Script-Regular.woff2?inline"),
    "KaTeX_Size1-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline"),
    "KaTeX_Size2-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline"),
    "KaTeX_Size3-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline"),
    "KaTeX_Size4-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline"),
    "KaTeX_Typewriter-Regular.woff2": () => import("katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline"),
};

/** Does this exported markup contain rendered KaTeX? */
export function hasKatexMarkup(html: string): boolean {
    return /class="(?:[^"]*\s)?katex(?:\s[^"]*)?"/.test(html);
}

/** Every class token used anywhere in the markup. */
function classTokens(html: string): Set<string> {
    const out = new Set<string>();
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c) out.add(c);
    }
    return out;
}

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;

/**
 * The KaTeX font families a document's markup uses, read from the
 * stylesheet's own rules: a family is used when some rule that names it has
 * a selector whose classes are all present in the markup.
 */
export function usedKatexFamilies(css: string, html: string): Set<string> {
    const classes = classTokens(html);
    const used = new Set<string>();
    const rules = css.replace(FONT_FACE, "");
    for (const m of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const families = m[2].match(/KaTeX_[A-Za-z0-9]+/g);
        if (!families) continue;
        const matches = m[1].split(",").some((selector) => {
            const needed = selector.match(/\.[A-Za-z0-9_-]+/g);
            return !!needed && needed.every((c) => classes.has(c.slice(1)));
        });
        if (matches) families.forEach((f) => used.add(f));
    }
    return used;
}

/**
 * Rewrite katex.min.css for a standalone file: the faces of used families get
 * their woff2 inlined (`fonts` maps a file name to its data URL), and every
 * other face is dropped, along with the woff/ttf fallbacks that would never
 * load.
 */
export function inlineKatexFonts(css: string, used: Set<string>, fonts: Record<string, string>): string {
    return css.replace(FONT_FACE, (face) => {
        const family = face.match(/font-family:\s*([^;}]+)/)?.[1].trim();
        const file = face.match(/url\(\s*['"]?fonts\/([^)'"]+\.woff2)/)?.[1];
        if (!family || !file || !used.has(family) || !fonts[file]) return "";
        return face.replace(/src:[^;}]+/, `src:url(${fonts[file]}) format("woff2")`);
    });
}

/**
 * The <style> contents an export needs for its KaTeX markup, or "" when it
 * has none. `loadFont` is injectable for tests.
 */
export async function katexExportCss(
    html: string,
    loadFont: (file: string) => Promise<string | null> = defaultLoadFont,
    loadCss: () => Promise<string> = defaultLoadCss,
): Promise<string> {
    if (!hasKatexMarkup(html)) return "";
    const css = await loadCss();
    const used = usedKatexFamilies(css, html);
    const files = Array.from(css.matchAll(FONT_FACE))
        .map((m) => ({
            family: m[0].match(/font-family:\s*([^;}]+)/)?.[1].trim(),
            file: m[0].match(/url\(\s*['"]?fonts\/([^)'"]+\.woff2)/)?.[1],
        }))
        .filter((f): f is { family: string; file: string } => !!f.family && !!f.file && used.has(f.family))
        .map((f) => f.file);
    const fonts: Record<string, string> = {};
    await Promise.all(files.map(async (file) => {
        const data = await loadFont(file).catch(() => null);
        if (data) fonts[file] = data;
    }));
    return inlineKatexFonts(css, used, fonts);
}

async function defaultLoadCss(): Promise<string> {
    return (await import("katex/dist/katex.min.css?raw")).default;
}

async function defaultLoadFont(file: string): Promise<string | null> {
    const load = FONT_LOADERS[file];
    return load ? (await load()).default : null;
}
