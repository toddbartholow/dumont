import { describe, it, expect, vi, type Mock } from "vitest";

// exportUtils imports Tauri plugins at module load; stub them so the pure
// HTML-generation helpers can be tested without a Tauri runtime. The functions
// under test (generateHTML, prepareExportHtml) never call these.
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { exportToDocx, generateHTML, prepareExportHtml } from "./exportUtils";
import { BUILTIN_THEMES } from "../themes";

describe("generateHTML", () => {
    it("wraps the content in a standalone HTML document", () => {
        const out = generateHTML("<p>Hello</p>", "My Doc", "dark", "inter", 16, []);
        expect(out).toContain("<!DOCTYPE html>");
        expect(out).toContain("<title>My Doc</title>");
        expect(out).toContain("<p>Hello</p>");
        expect(out).toContain("<article>");
    });

    it("escapes HTML-special characters in the title (XSS-safe)", () => {
        const out = generateHTML("<p>x</p>", '<script>alert(1)</script>&"', "dark", "inter", 16, []);
        expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;");
        expect(out).not.toContain("<title><script>");
    });

    it("includes the export footer by default and omits it when disabled", () => {
        expect(generateHTML("<p>x</p>", "t", "dark", "inter", 16, [])).toContain("Exported from Dumont");
        expect(generateHTML("<p>x</p>", "t", "dark", "inter", 16, [], false)).not.toContain("Exported from Dumont");
    });

    it("applies theme-specific colors", () => {
        expect(generateHTML("<p>x</p>", "t", "dark", "inter", 16, [])).toContain("#0a0a0a");
        expect(generateHTML("<p>x</p>", "t", "paper", "inter", 16, [])).toContain("#f5f0e6");
    });

    it("applies the selected font family and size", () => {
        const out = generateHTML("<p>x</p>", "t", "dark", "inter", 18, []);
        expect(out).toContain("'Inter'");
        expect(out).toContain("18px");
    });

    // The size is an arbitrary number now, not a small/medium/large enum, so an
    // export has to honor whatever the user typed rather than snap to a preset.
    it("bakes an arbitrary font size into the export CSS", () => {
        expect(generateHTML("<p>x</p>", "t", "dark", "inter", 21, [])).toContain("21px");
        // Out-of-range values clamp instead of emitting nonsense.
        expect(generateHTML("<p>x</p>", "t", "dark", "inter", 999, [])).toContain("32px");
    });

    // ==highlight== and definition lists render in the preview DOM that exports
    // capture, so the export stylesheet must ship matching rules (SYNTAX-01).
    it("ships mark and definition-list styling in the export CSS", () => {
        const out = generateHTML("<p>x</p>", "t", "dark", "inter", 16, []);
        expect(out).toMatch(/mark \{[^}]*background: rgba\(255, 196, 0, 0\.35\)/);
        expect(out).toMatch(/dt \{[^}]*font-weight: 600/);
        expect(out).toMatch(/dd \{[^}]*margin: 0 0 0\.25rem 1\.5rem/);
    });

    // The export used to give light and paper their own opaque ambers (#ffe28a,
    // #efd489), which the app has never painted: `.markdown-body mark` is one
    // translucent amber on every theme. A highlight that changes color when you
    // export it is a highlight that does not match the document on screen.
    // "Every theme" means the registry, not a list of ids typed out here. The five
    // that were spelled out stopped being every theme the moment a sixth shipped,
    // and the test would have gone on passing while saying so.
    it("highlights with the same amber the app uses, on every theme", () => {
        for (const { id } of BUILTIN_THEMES) {
            expect(generateHTML("<p>x</p>", "t", id, "inter", 16, []), id)
                .toMatch(/mark \{[^}]*background: rgba\(255, 196, 0, 0\.35\)/);
        }
    });

    // Mermaid SVGs carry an inline natural-size max-width from the preview;
    // export CSS must scale them to the column or they render tiny.
    it("ships column-scaling CSS for rendered mermaid diagrams", () => {
        const out = generateHTML("<p>x</p>", "t", "dark", "inter", 16, []);
        expect(out).toContain(".mermaid-rendered > svg");
        expect(out).toContain("max-width: none !important");
        // Diagrams must not be sliced mid-box when printing to PDF.
        expect(out).toMatch(/pre, blockquote, table, img, tr, \.mermaid-rendered \{/);
    });
});

describe("prepareExportHtml", () => {
    it("strips leaked UI chrome (buttons and icon ligatures)", async () => {
        const html = '<p>Body</p><button>Copy</button><span class="material-symbols-outlined">link</span>';
        const out = await prepareExportHtml(html);
        expect(out).toContain("<p>Body</p>");
        expect(out).not.toContain("<button");
        expect(out).not.toContain("material-symbols-outlined");
    });

    it("neutralizes app-internal wikilink anchors into plain text", async () => {
        const out = await prepareExportHtml('<a href="wikilink:Foo">Foo</a>');
        expect(out).toContain("Foo");
        expect(out).not.toContain("wikilink:");
        expect(out).not.toContain("<a");
    });

    it("leaves ordinary links and non-blob images intact", async () => {
        const html = '<a href="https://example.com">site</a><img src="data:image/png;base64,AAAA">';
        const out = await prepareExportHtml(html);
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('src="data:image/png;base64,AAAA"');
    });

    // Relative .md links keep their real href in exports (sibling-file
    // convention); they used to be captured as dead href="#" anchors. EXPORT-04.
    it("preserves relative markdown link hrefs", async () => {
        const out = await prepareExportHtml('<a href="notes/other.md" data-relative-md="true">other</a>');
        expect(out).toContain('href="notes/other.md"');
        expect(out).not.toContain('href="#"');
    });

    // Finding 2: mermaid is the one rendered path that skips the Markdown sanitizer
    // (MermaidBlock trusts securityLevel:strict and injects the SVG raw), and a
    // standalone export has no CSP to backstop it, so the export must re-sanitize.
    it("strips script, event handlers, and javascript: URLs from a mermaid SVG", async () => {
        const html = [
            '<div class="mermaid-rendered"><svg xmlns="http://www.w3.org/2000/svg">',
            '<script>window.__pwned = 1</script>',
            '<rect onload="window.__pwned = 2" width="10" height="10"></rect>',
            '<a xlink:href="javascript:window.__pwned=3"><text>x</text></a>',
            // A payload smuggled inside a foreignObject label must be stripped too,
            // even though foreignObject itself is allowed for legitimate labels.
            '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">',
            '<script>window.__pwned=4</script><img src="x" onerror="window.__pwned=5">',
            '</div></foreignObject>',
            '</svg></div>',
        ].join("");
        const out = await prepareExportHtml(html);
        expect(out).not.toContain("<script");
        expect(out).not.toContain("__pwned");
        expect(out.toLowerCase()).not.toContain("onload");
        expect(out.toLowerCase()).not.toContain("onerror");
        expect(out.toLowerCase()).not.toContain("javascript:");
    });

    // Mermaid renders labels as native SVG <text> (its bundle uses no foreignObject),
    // so the sanitize pass must leave a real diagram fully intact: shapes, text, and
    // the colors it carries in a <style> block and inline style attributes.
    it("keeps a benign mermaid diagram's shapes, text labels, and colors", async () => {
        const html = [
            '<div class="mermaid-rendered"><svg xmlns="http://www.w3.org/2000/svg">',
            '<style>.node rect { fill: #ff0000; }</style>',
            '<g class="node"><rect width="40" height="20" style="stroke: #0000ff"></rect>',
            '<text x="5" y="15">Start</text></g>',
            '</svg></div>',
        ].join("");
        const out = await prepareExportHtml(html);
        expect(out).toContain("<svg");
        expect(out).toContain("<rect");
        expect(out).toContain("Start");
        expect(out).toContain("#ff0000");
        expect(out).toContain("stroke: #0000ff");
    });

    // DOMPurify sanitizes markup, not CSS, and the export ships with no CSP, so a
    // remote @import or url() in a mermaid <style> or inline style would fire a
    // network request (a tracking beacon) when a recipient opens the file.
    it("neutralizes phone-home @import and remote url() in mermaid CSS, keeping url(#) refs", async () => {
        const html = [
            '<div class="mermaid-rendered"><svg xmlns="http://www.w3.org/2000/svg">',
            '<style>@import url(https://evil.test/x.css); .node{background:url("https://evil.test/beacon.png")} .edge{marker-end:url(#arrow)}</style>',
            '<rect style="fill:url(https://evil.test/p.png)"></rect>',
            '</svg></div>',
        ].join("");
        const out = await prepareExportHtml(html);
        expect(out).not.toContain("evil.test");
        expect(out.toLowerCase()).not.toContain("@import");
        expect(out).toContain("url(#arrow)");
    });
});

describe("exportToDocx", () => {
    it("returns false and writes nothing when the save dialog is cancelled", async () => {
        (save as Mock).mockResolvedValueOnce(null);
        (writeFile as Mock).mockClear();
        const ok = await exportToDocx("<h1>Hi</h1>", "doc.md", "dark", "inter", 16);
        expect(ok).toBe(false);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("converts the HTML and writes a valid OOXML .docx to the chosen path", async () => {
        (save as Mock).mockResolvedValueOnce("C:/tmp/out.docx");
        (writeFile as Mock).mockClear();
        const ok = await exportToDocx(
            "<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>a</li><li>b</li></ul>",
            "doc.md",
            "dark", "inter", 16
        );
        expect(ok).toBe(true);
        expect(writeFile).toHaveBeenCalledOnce();
        const [path, bytes] = (writeFile as Mock).mock.calls[0];
        expect(path).toBe("C:/tmp/out.docx");
        expect(bytes).toBeInstanceOf(Uint8Array);
        // A .docx is a ZIP archive — it must start with the local-file-header
        // magic bytes "PK\x03\x04". This proves we wrote a real Office document,
        // not an HTML blob with a .docx extension.
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    }, 20000);

    // NOTE (EXPORT-05): the webview provides no Node globals, and the
    // converter's browser build reaches for global/Buffer/process anyway —
    // exportToDocx shims them via ensureDocxRuntime before loading the chunk.
    // That scenario is untestable under vitest (removing Node's own globals
    // takes the runner down); it was verified against the built bundle in a
    // real browser, where conversion fails without the shims and succeeds
    // with them.
});
