// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { Theme, FontFamily, FontSize } from '../context/ThemeContext';
import { fontStack } from './appearanceOptions';
import { resolveThemeStyles, type ThemeDef } from '../themes';
import { typeScale } from './typeScale';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';

// The one amber every theme highlights with, lifted from `.markdown-body mark` in
// index.css. It is deliberately not a theme token: the app paints ==highlight==
// the same translucent amber on all five themes, and an export that invents a
// per-theme fill of its own (which this file used to do) stops looking like the
// document the user is looking at.
const MARK_BG = 'rgba(255, 196, 0, 0.35)';

// Generate CSS for export
function generateExportCSS(
    theme: Theme,
    font: FontFamily,
    fontSize: FontSize,
    userThemes: readonly ThemeDef[]
): string {
    // The SAME record ThemeProvider writes onto <html>, code colors included.
    //
    // This file used to carry a second, hand-maintained copy of every theme under
    // camelCase names of its own invention, and it had drifted: exports were still
    // shipping the pre-accessibility --text-secondary for three themes, the light
    // theme's colors from before it was warmed, and one hardcoded green for code
    // function names on every theme that wasn't vs2017-dark. Nothing could catch
    // any of it, because the two tables had no common source. Now there is one.
    //
    // `userThemes` is REQUIRED, and is not defaulted to `[]` on purpose. It was
    // omitted here, and ThemeProvider passed it, so the one function that exists to
    // stop the export drifting from the app drifted from the app: a user theme id is
    // not found without it, the merge chain comes back empty, and the export silently
    // fell back to the BASE (dark) palette. Someone using a custom theme exported a
    // document painted in a theme they had never chosen, and nothing said a word. A
    // default of `[]` would let the next call site make exactly that mistake again.
    const c = resolveThemeStyles(theme, userThemes);
    // Resolves a bundled id OR a custom stack, and sanitizes the latter: this
    // value is interpolated straight into a <style> block below.
    const fontFamily = fontStack(font);
    // Code spans and blocks stay monospace under a proportional body font, and the
    // stack comes from appearanceOptions rather than being spelled out here. This file
    // used to carry its own copy, and it had already drifted: it was missing
    // 'Liberation Mono', which is precisely the fallback the entry exists for on Linux,
    // so an exported document's code blocks fell through to the browser default on the
    // platform that needed it most.
    const monoStack = fontStack('jetbrains-mono');
    // Same scale the app itself renders with (utils/typeScale.ts), so an export
    // matches what the user sees at whatever size they picked.
    const sizes = typeScale(fontSize);

    // No Google Fonts @import here — exporting must succeed offline, and the
    // resulting HTML must render reasonably on machines that can't reach the
    // CDN. The font-family declarations below use the same display names as
    // the editor (Inter, Merriweather, Lora, Source Serif 4, Fira Sans,
    // JetBrains Mono); the recipient sees those if installed locally,
    // otherwise the cascade falls back to a safe system font in the same
    // genre (sans-serif, serif, or monospace).
    return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: ${fontFamily};
            font-size: ${sizes.base};
            line-height: ${sizes.lineHeight};
            background-color: ${c['--bg-primary']};
            color: ${c['--text-primary']};
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            padding: 3rem;
            max-width: 800px;
            margin: 0 auto;
        }

        @page {
            margin: 18mm 16mm;
        }

        @media print {
            html, body {
                background: #ffffff;
            }
            body {
                padding: 0;
                max-width: none;
                color: #171717;
            }
            /* Browsers drop background fills when printing unless asked; keep
               code blocks, table headers and blockquote tints visible. */
            pre, code, th, blockquote, .hljs, mark {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
            /* Keep atomic blocks and their headings from splitting awkwardly. */
            pre, blockquote, table, img, tr, .mermaid-rendered {
                page-break-inside: avoid;
                break-inside: avoid;
            }
            h1, h2, h3, h4, h5, h6 {
                page-break-after: avoid;
                break-after: avoid;
            }
        }

        h1 {
            font-size: ${sizes.h1};
            font-weight: 800;
            padding-bottom: 0.3em;
            border-bottom: 1px solid ${c['--border']};
            color: ${c['--syntax-h1']};
            margin-bottom: 1rem;
            margin-top: 0;
        }

        h2 {
            font-size: ${sizes.h2};
            font-weight: 700;
            padding-bottom: 0.3em;
            border-bottom: 1px solid ${c['--border']};
            color: ${c['--syntax-h2']};
            margin-top: 2rem;
            margin-bottom: 1rem;
        }

        h3 {
            font-size: ${sizes.h3};
            font-weight: 600;
            color: ${c['--syntax-h3']};
            margin-top: 1.5rem;
            margin-bottom: 0.5rem;
        }

        h4, h5, h6 {
            font-weight: 600;
            color: ${c['--syntax-h3']};
            margin-top: 1.25rem;
            margin-bottom: 0.5rem;
        }

        p {
            margin-bottom: 1rem;
        }

        a {
            color: ${c['--syntax-link']};
            text-decoration: none;
        }

        a:hover {
            text-decoration: underline;
        }

        strong {
            font-weight: 600;
            color: ${c['--syntax-bold']};
        }

        /* ==highlight== (remark-flexible-markers): the preview's
           .markdown-body mark rule, verbatim. One amber, every theme; the text
           keeps the theme's primary color for legibility. */
        mark {
            background: ${MARK_BG};
            color: ${c['--text-primary']};
            padding: 0.05em 0.15em;
            border-radius: 0.2em;
        }

        /* Definition lists (remark-definition-list) — mirrors the preview. */
        dl {
            margin: 0 0 1rem;
        }

        dt {
            font-weight: 600;
            color: ${c['--syntax-bold']};
            margin-top: 0.5rem;
        }

        dd {
            margin: 0 0 0.25rem 1.5rem;
        }

        em {
            font-style: italic;
        }

        code {
            font-family: ${monoStack};
            background: ${c['--code-bg']};
            border: 1px solid ${c['--border']};
            border-radius: 0.25rem;
            padding: 0.1em 0.3em;
            font-size: 0.875em;
            color: ${c['--code-text']};
        }

        pre {
            background: ${c['--code-bg']};
            border: 1px solid ${c['--border']};
            border-radius: 0.375rem;
            padding: 1rem;
            overflow-x: auto;
            margin: 1rem 0;
        }

        pre code {
            background: none;
            border: none;
            padding: 0;
            color: ${c['--text-primary']};
            font-size: 0.9em;
        }

        ul, ol {
            padding-left: 1.5rem;
            margin-bottom: 1rem;
        }

        li {
            margin-bottom: 0.25rem;
        }

        li > ul, li > ol {
            margin-top: 0.25rem;
            margin-bottom: 0;
        }

        blockquote {
            border-left: 4px solid ${c['--accent']};
            background: ${c['--blockquote-bg']};
            padding: 0.5rem 1rem;
            margin: 1rem 0;
            font-style: italic;
            color: ${c['--text-secondary']};
            border-radius: 0 0.25rem 0.25rem 0;
        }

        blockquote p:last-child {
            margin-bottom: 0;
        }

        hr {
            border: none;
            border-top: 1px solid ${c['--border']};
            margin: 2rem 0;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 1rem 0;
        }

        th, td {
            border: 1px solid ${c['--border']};
            padding: 0.5rem 0.75rem;
            text-align: left;
        }

        th {
            background: ${c['--bg-secondary']};
            font-weight: 600;
        }

        img {
            max-width: 100%;
            height: auto;
            border-radius: 0.375rem;
            margin: 1rem 0;
        }

        /* Exports capture the preview DOM, so rendered mermaid SVGs arrive
           with mermaid's inline natural-size max-width; mirror the preview's
           column scaling (see index.css .mermaid-rendered). The container's
           Tailwind classes don't exist in exports, hence the margin here. */
        .mermaid-rendered {
            margin: 1rem 0;
        }
        .mermaid-rendered > svg {
            width: 100%;
            height: auto;
            max-width: none !important;
        }

        /* Task lists */
        input[type="checkbox"] {
            margin-right: 0.5rem;
            transform: scale(1.1);
        }

        /* Syntax highlighting */
        .hljs-keyword { color: ${c['--hljs-keyword']}; }
        .hljs-string { color: ${c['--hljs-string']}; }
        .hljs-number { color: ${c['--hljs-number']}; }
        .hljs-function { color: ${c['--hljs-function']}; }
        .hljs-comment { color: ${c['--hljs-comment']}; font-style: italic; }
        .hljs-title { color: ${c['--hljs-title']}; }
        .hljs-params { color: ${c['--hljs-params']}; }
        .hljs-built_in { color: ${c['--hljs-built-in']}; }
        .hljs-attr { color: ${c['--hljs-attr']}; }
        .hljs-literal { color: ${c['--hljs-literal']}; }

        /* Footer */
        .export-footer {
            margin-top: 3rem;
            padding-top: 1rem;
            border-top: 1px solid ${c['--border']};
            text-align: center;
            font-size: 0.75rem;
            color: ${c['--text-secondary']};
        }
    `;
}

/**
 * Strip the CSS constructs that fetch over the network, so a shared export (which
 * ships with no CSP) cannot be turned into a tracking beacon: @import, and any
 * url() that is not a local #fragment. mermaid references its own markers and
 * gradients as url(#id), which are kept; a remote, data:, or javascript: url() is
 * replaced with an inert url(#). DOMPurify sanitizes markup, not CSS, so a shared
 * export needs this separate pass.
 */
function neutralizeCss(css: string): string {
    return css
        .replace(/@import\b[^;]*;?/gi, "")
        .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote, ref) =>
            (ref as string).trim().startsWith("#") ? match : "url(#)");
}

/**
 * Clean the live preview's innerHTML for export (EXPORT-01):
 *  - strips UI chrome that leaked in from interactive renderers: code-block
 *    "Copy" buttons and heading anchor buttons (whose Material Symbols
 *    ligatures render as literal words like "link" without the icon font);
 *  - inlines blob: image URLs as data: URIs — blob URLs are session-bound, so
 *    exported files referencing them show broken images;
 *  - neutralizes wikilink: hrefs (app-internal scheme) into plain text.
 *  - re-sanitizes mermaid SVGs, the one rendered path that skips the Markdown
 *    sanitizer, so a shared export carries neither script nor a phone-home CSS
 *    url() (SECURITY, Finding 2).
 */
export async function prepareExportHtml(rawHtml: string): Promise<string> {
    const doc = new DOMParser().parseFromString(`<div id="__export_root">${rawHtml}</div>`, "text/html");
    const root = doc.getElementById("__export_root");
    if (!root) return rawHtml;

    root.querySelectorAll("button").forEach((b) => b.remove());
    root.querySelectorAll(".material-symbols-outlined").forEach((s) => s.remove());

    root.querySelectorAll("a[href^='wikilink:']").forEach((a) => {
        const span = doc.createElement("span");
        span.textContent = a.textContent;
        a.replaceWith(span);
    });

    for (const img of Array.from(root.querySelectorAll("img"))) {
        const src = img.getAttribute("src") || "";
        if (!src.startsWith("blob:")) continue;
        try {
            const blob = await (await fetch(src)).blob();
            const dataUri = await new Promise<string>((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result as string);
                fr.onerror = () => reject(fr.error);
                fr.readAsDataURL(blob);
            });
            img.setAttribute("src", dataUri);
        } catch {
            // Blob already revoked or unreadable — leave the src; the alt text
            // still communicates what belonged there.
        }
    }

    // Mermaid is the one rendered-content path that never passes through the
    // Markdown sanitizer: MermaidBlock injects the SVG with dangerouslySetInnerHTML,
    // trusting mermaid's own securityLevel:strict. In the app the CSP is a backstop,
    // but a standalone exported .html has NO CSP, so a mermaid or DOMPurify bypass
    // would run script in whoever opens the export downstream. Re-sanitize each SVG
    // here as an independent gate: the shapes, native <text> labels, and colors
    // survive; any script, event handler, or javascript: URL does not.
    for (const container of Array.from(root.querySelectorAll(".mermaid-rendered"))) {
        container.innerHTML = DOMPurify.sanitize(container.innerHTML, {
            // Keep the diagram: SVG shapes and filters, the native <text> labels
            // mermaid renders with (it uses no foreignObject), and the <style> block
            // that carries its colors. The html profile lets DOMPurify reach INTO any
            // foreignObject to sanitize it rather than trust it, so a script or
            // handler in a label is still removed.
            USE_PROFILES: { svg: true, svgFilters: true, html: true },
            ADD_TAGS: ["style"],
        });
        // DOMPurify sanitizes markup, not CSS, and the export has no CSP, so close
        // the one channel that still phones home: @import and remote url() in the
        // <style> block and in inline style attributes. mermaid's own url(#marker)
        // references stay.
        for (const styleEl of Array.from(container.querySelectorAll("style"))) {
            styleEl.textContent = neutralizeCss(styleEl.textContent || "");
        }
        for (const el of Array.from(container.querySelectorAll("[style]"))) {
            el.setAttribute("style", neutralizeCss(el.getAttribute("style") || ""));
        }
    }

    return root.innerHTML;
}

// Escape HTML entities to prevent XSS in generated HTML
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Generate standalone HTML document
export function generateHTML(
    htmlContent: string,
    title: string,
    theme: Theme,
    font: FontFamily,
    fontSize: FontSize,
    userThemes: readonly ThemeDef[],
    includeFooter: boolean = true
): string {
    const css = generateExportCSS(theme, font, fontSize, userThemes);
    const safeTitle = escapeHtml(title);
    const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const footer = includeFooter
        ? `<footer class="export-footer">Exported from Dumont on ${date}</footer>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="generator" content="Dumont">
    <meta name="date" content="${new Date().toISOString()}">
    <title>${safeTitle}</title>
    <style>${css}</style>
</head>
<body>
    <article>
        ${htmlContent}
    </article>
    ${footer}
</body>
</html>`;
}

// Export to HTML file. Resolves `true` when a file was actually written, and
// `false` when the user cancelled the save dialog — so the caller can skip the
// "Exported" confirmation toast on cancel.
export async function exportToHTML(
    htmlContent: string,
    fileName: string,
    theme: Theme,
    font: FontFamily,
    fontSize: FontSize,
    userThemes: readonly ThemeDef[]
): Promise<boolean> {
    const title = fileName.replace(/\.(md|markdown)$/i, '');
    const cleaned = await prepareExportHtml(htmlContent);
    const fullHTML = generateHTML(cleaned, title, theme, font, fontSize, userThemes);

    // Use Tauri save dialog
    const filePath = await save({
        defaultPath: `${title}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }],
    });

    if (!filePath) return false;
    await writeTextFile(filePath, fullHTML);
    return true;
}

// ---------------------------------------------------------------------------
// DOCX export
//
// Converts the same cleaned preview HTML we use for HTML/PDF into a real Office
// Open XML (.docx) document via @turbodocx/html-to-docx — pure JS, no headless
// browser or native binary, and Vite resolves its dedicated browser ESM build.
// The library is dynamically imported so its weight stays out of the main chunk
// (and off the cold-start path) until the user actually exports to Word.
//
// Like PDF, DOCX is always a light, print-style document — a shared Word file
// must be legible on white. Headings, lists, tables, bold/italic, links, and
// images (inlined as data URIs by prepareExportHtml) carry over faithfully. Math
// (KaTeX) and Mermaid diagrams are HTML/SVG constructs Word has no native model
// for, so they degrade to their textual/markup form — the same caveat every
// Markdown-to-Word path has. EXPORT-02.
type HtmlToDocx = (
    html: string,
    header?: string | null,
    options?: Record<string, unknown>,
    footer?: string | null
) => Promise<ArrayBuffer | Blob | Uint8Array>;

// @turbodocx/html-to-docx's browser build still reaches for Node's `global`,
// `Buffer` and `process`; the webview provides none of them, so conversion
// threw "global is not defined" the moment the chunk ran. Tests never caught
// it because vitest runs in Node, which supplies all three. Shim them right
// before the library loads — the Buffer polyfill is itself dynamically
// imported, so none of this weighs on cold start. EXPORT-05.
async function ensureDocxRuntime(): Promise<void> {
    const g = globalThis as Record<string, unknown>;
    if (typeof g.global === "undefined") g.global = g;
    if (typeof g.process === "undefined") g.process = { env: {} };
    if (typeof g.Buffer === "undefined") {
        // In the browser bundle "buffer" resolves to the npm polyfill package;
        // under Node (vitest) it resolves to the builtin. Both export Buffer.
        const { Buffer } = await import("buffer");
        g.Buffer = Buffer;
    }
}

export async function exportToDocx(
    htmlContent: string,
    fileName: string,
    _theme: Theme,
    _font: FontFamily,
    _fontSize: FontSize
): Promise<boolean> {
    if (!htmlContent || htmlContent.trim() === '') {
        console.error('No HTML content to export!');
        return false;
    }

    const title = fileName.replace(/\.(md|markdown)$/i, '');
    const cleaned = await prepareExportHtml(htmlContent);
    // A minimal, unthemed document — the converter maps semantic HTML to Word
    // styles, so we deliberately don't inject the screen theme's colors here.
    const docHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><article>${cleaned}</article></body></html>`;

    // Prompt for the destination first so we don't do the (heavier) conversion
    // work when the user is just going to cancel.
    const filePath = await save({
        defaultPath: `${title}.docx`,
        filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (!filePath) return false;

    await ensureDocxRuntime();
    const mod = await import('@turbodocx/html-to-docx');
    // The package uses `export =`; the function is the default export under the
    // browser/ESM build. Fall back to the namespace itself for the CJS shape.
    const convert = ((mod as { default?: HtmlToDocx }).default ?? (mod as unknown as HtmlToDocx)) as HtmlToDocx;

    const out = await convert(docHtml, null, {
        title,
        creator: 'Dumont',
        footer: false,
        pageNumber: false,
        font: 'Calibri',
        // Word measures run size in half-points; 22 == 11pt body text.
        fontSize: 22,
        table: { row: { cantSplit: true } },
    });

    const bytes =
        out instanceof Blob ? new Uint8Array(await out.arrayBuffer())
        : out instanceof Uint8Array ? out
        : new Uint8Array(out as ArrayBuffer);
    await writeFile(filePath, bytes);
    return true;
}

// ---------------------------------------------------------------------------
// PDF export
//
// We deliberately do NOT rasterize or hand-roll a PDF layout. Instead we hand
// the same standalone HTML we produce for HTML export to a real print engine.
// That yields a vector PDF that matches the preview exactly: real Unicode and
// color emoji, selectable/searchable text and working links — none of which the
// old jsPDF standard-font path could do (it encoded text as single-byte
// WinAnsi, so anything outside Latin-1 — emoji, smart quotes, em dashes —
// printed as garbage).
//
// Windows and macOS go through the Rust `export_pdf` command, which writes the
// PDF silently (WebView2 PrintToPdf / NSPrintOperation). Linux renders in an
// isolated off-screen iframe and drives the webview's own print pipeline.
// ---------------------------------------------------------------------------

const PRINT_FRAME_ID = '__dumont_print_frame';

// Resolve once every <img> has finished loading (or failed) so the print job
// never captures half-decoded images. Sources are inlined as data: URIs by
// prepareExportHtml, so this usually settles almost immediately.
function waitForImages(doc: Document): Promise<void> {
    const imgs = Array.from(doc.images ?? []);
    return Promise.all(
        imgs.map((img) =>
            img.complete
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      img.addEventListener('load', () => resolve(), { once: true });
                      img.addEventListener('error', () => resolve(), { once: true });
                  })
        )
    ).then(() => undefined);
}

// Render `html` in a hidden iframe and invoke the webview's native print dialog.
// Resolves once printing has been triggered and cleaned up (or the dialog was
// dismissed). A webview that never fires `afterprint` is cleaned up by the
// fallback timer so we don't leak frames.
function printHtmlDocument(html: string): Promise<void> {
    return new Promise((resolve) => {
        // Remove any frame left over from a previous (e.g. cancelled) export.
        document.getElementById(PRINT_FRAME_ID)?.remove();

        const iframe = document.createElement('iframe');
        iframe.id = PRINT_FRAME_ID;
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('tabindex', '-1');
        Object.assign(iframe.style, {
            position: 'fixed',
            left: '-9999px',
            top: '0',
            // A4-ish width at 96dpi so on-screen layout is sane before the print
            // engine re-flows to the real page size.
            width: '794px',
            height: '0',
            border: '0',
            opacity: '0',
            pointerEvents: 'none',
        });

        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };

        iframe.onload = () => {
            const win = iframe.contentWindow;
            if (!win) {
                iframe.remove();
                finish();
                return;
            }

            const cleanup = () => {
                win.removeEventListener('afterprint', cleanup);
                clearTimeout(fallbackTimer);
                // Defer removal a tick — some engines read the document
                // asynchronously after print() returns.
                setTimeout(() => iframe.remove(), 300);
                finish();
            };
            // Fires when the dialog closes, whether the user saved or cancelled.
            win.addEventListener('afterprint', cleanup);
            // Safety net for webviews that don't emit afterprint. `cleanup` closes over
            // this binding and only ever runs asynchronously, so it is initialised by the
            // time anything reads it.
            const fallbackTimer: ReturnType<typeof setTimeout> = setTimeout(cleanup, 120000);

            Promise.all([
                win.document.fonts?.ready?.catch(() => undefined),
                waitForImages(win.document),
            ]).then(() => {
                try {
                    win.focus();
                    win.print();
                } catch {
                    cleanup();
                }
            });
        };

        document.body.appendChild(iframe);
        iframe.srcdoc = html;
    });
}

// Export to PDF. The theme argument is intentionally ignored: a shared/printed
// PDF must be legible on white paper, so we always render the light theme. The
// on-screen HTML export still honors the chosen theme.
//
// On Windows and macOS we ask once where to save (like HTML export) and hand
// the HTML to the Rust `export_pdf` command, which renders it in a hidden
// webview and writes a real PDF via the native print engine — no print dialog.
// The iframe fallback is NOT an option on macOS: WKWebView has no JS
// `window.print()` at all (wry only shims it for WebView2), so it silently did
// nothing there (#96). Linux keeps the print-pipeline fallback, which WebKitGTK
// does implement.
// Resolves:
//   'saved'    — Windows/macOS: the PDF was written to the chosen path.
//   'cancelled'— Windows/macOS: the user dismissed the save dialog.
//   'printing' — Linux: the native print dialog was handed off. We can't tell
//                save from cancel there, so the caller must NOT claim
//                "Exported" — the system dialog is its own feedback. EXPORT-01.
export type PdfExportResult = 'saved' | 'cancelled' | 'printing';

export async function exportToPDF(
    htmlContent: string,
    fileName: string,
    _theme: Theme,
    font: FontFamily,
    fontSize: FontSize
): Promise<PdfExportResult> {
    if (!htmlContent || htmlContent.trim() === '') {
        console.error('No HTML content to export!');
        return 'cancelled';
    }

    const title = fileName.replace(/\.(md|markdown)$/i, '');

    // Same cleanup as HTML export — strips UI chrome (copy buttons, heading
    // anchor icons) and inlines blob: images as data: URIs.
    const cleaned = await prepareExportHtml(htmlContent);
    // No user themes to resolve: a PDF is always rendered in the BUILT-IN 'light'
    // theme (see `_theme` above, deliberately ignored), because a PDF is for printing
    // and paper is white. A built-in id needs no extra definitions to resolve, so the
    // empty list here is a fact rather than the omission that broke the HTML export.
    const fullHTML = generateHTML(cleaned, title, 'light', font, fontSize, [], true);

    const canSaveSilently =
        typeof navigator !== 'undefined' &&
        /Windows|Macintosh/i.test(navigator.userAgent);

    if (canSaveSilently) {
        const filePath = await save({
            defaultPath: `${title}.pdf`,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        // Dialog cancelled — nothing to do.
        if (!filePath) return 'cancelled';
        await invoke('export_pdf', { html: fullHTML, path: filePath });
        return 'saved';
    }

    await printHtmlDocument(fullHTML);
    return 'printing';
}
