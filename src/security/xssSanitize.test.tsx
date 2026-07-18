// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * XSS is a release-gating invariant, not a best effort.
 *
 * A Markdown document is untrusted content (it is shared, mailed, pulled off the
 * web), and the preview renders it inside a webview that can reach native code
 * through the Tauri IPC bridge, which exposes arbitrary file read and write (see
 * .claude/security-audit.md, finding 1). So a single script that runs in the
 * preview is host RCE, and the ONLY thing standing between a hostile `.md` and that
 * is the sanitize step. This test exists so a regression in the schema, the plugin
 * order, or a dependency bump cannot ship without turning this suite red.
 *
 * It drives the app's REAL schema (imported, not copied) through the same
 * raw -> sanitize pair the preview wires up. The preview's other plugins
 * (highlight, heading ids, math) run AFTER sanitize and reintroduce no raw HTML,
 * so this pair is the whole boundary.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { SANITIZE_SCHEMA } from "../components/MarkdownPreview";

afterEach(cleanup);

function renderMd(src: string) {
    return render(
        <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] as never}
        >
            {src}
        </Markdown>,
    );
}

// Elements that either run script directly or are the classic DOM-clobbering /
// navigation sinks. None may survive sanitize.
const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "form", "base", "meta", "link", "style"];

function assertInert(container: HTMLElement) {
    for (const tag of DANGEROUS_TAGS) {
        expect(container.querySelector(tag), `rendered a <${tag}>`).toBeNull();
    }
    for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
            // No inline event handlers (onerror, onload, ontoggle, ...).
            expect(attr.name, `${el.tagName} kept the handler ${attr.name}`).not.toMatch(/^on/i);
        }
        for (const urlAttr of ["href", "src", "xlink:href"]) {
            const value = el.getAttribute(urlAttr);
            if (value) {
                expect(
                    value.trim().toLowerCase(),
                    `${el.tagName} ${urlAttr}=${value}`,
                ).not.toMatch(/^(javascript|vbscript):/);
            }
        }
    }
    // Belt and suspenders: nothing dangerous survived as raw text or an attribute
    // React chose not to bind, either.
    expect(container.innerHTML.toLowerCase()).not.toMatch(
        /onerror|onload|onclick|ontoggle|javascript:|data:text\/html|<script/,
    );
}

describe("the Markdown -> webview XSS boundary holds", () => {
    it.each([
        ["a bare script tag", "<script>alert(1)</script>"],
        ["an img error handler", "<img src=x onerror=alert(1)>"],
        ["an svg load handler", "<svg onload=alert(1)></svg>"],
        ["a script inside svg", "<svg><script>alert(1)</script></svg>"],
        ["a details toggle handler", "<details open ontoggle=alert(1)>x</details>"],
        ["a javascript: markdown link", "[x](javascript:alert(1))"],
        ["a javascript: markdown image", "![x](javascript:alert(1))"],
        ["a javascript: raw link", '<a href="javascript:alert(1)">x</a>'],
        ["a data:text/html link", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
        ["an iframe", '<iframe src="https://evil.example"></iframe>'],
        ["an object", '<object data="https://evil.example"></object>'],
        ["an embed", '<embed src="https://evil.example">'],
        ["a form", '<form action="https://evil.example"><button>go</button></form>'],
        ["a style with @import", "<style>@import url(https://evil.example)</style>"],
        ["an xmp breakout", "<xmp><script>alert(1)</script></xmp>"],
        ["a template payload", "<template><img src=x onerror=alert(1)></template>"],
        ["a body load handler", "<body onload=alert(1)>x"],
    ])("neutralizes %s", (_label, payload) => {
        const { container } = renderMd(payload);
        assertInert(container);
    });

    // The other half of a sanitizer worth having: it must not shred safe content,
    // or authors route around it and the boundary rots. These also pin the schema's
    // two deliberate additions so a future "tidy up the schema" cannot silently drop
    // them.
    it("keeps legitimate Markdown intact", () => {
        const { container } = renderMd("**bold**, `code`, and [a link](https://example.com).");
        expect(container.querySelector("strong")?.textContent).toBe("bold");
        expect(container.querySelector("code")?.textContent).toBe("code");
        expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
        assertInert(container);
    });

    it("keeps the schema's <mark> addition (the ==highlight== element)", () => {
        const { container } = renderMd("<mark>highlighted</mark>");
        expect(container.querySelector("mark")?.textContent).toBe("highlighted");
    });

    it("keeps the schema's math classes so KaTeX can find them", () => {
        const { container } = renderMd('<span class="math-inline">x</span>');
        expect(container.querySelector("span")?.className).toContain("math-inline");
    });
});
