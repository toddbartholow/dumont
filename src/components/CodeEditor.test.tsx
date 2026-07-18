// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

// Regression test for the invisible editor selection (CodenameFlux review).
// CodeMirror's base theme paints the FOCUSED selection through
// `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`,
// which out-specifies the app theme's generic `.cm-selectionBackground` rule —
// so every theme rendered CM's default lavender (#d7d4f0), unreadable against
// light/paper text. The theme must mirror that selector shape for
// --selection-bg to win.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { CodeEditor } from "./CodeEditor";
import { TestProviders } from "../test/providers";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";

beforeAll(installCodeMirrorDomPolyfills);
afterEach(cleanup);

describe("editor selection theming", () => {
    it("overrides CodeMirror's focused-selection base rule with --selection-bg", async () => {
        const { container } = render(
            <TestProviders>
                <CodeEditor content="hello" onChange={() => {}} />
            </TestProviders>,
        );
        await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

        const css = Array.from(document.querySelectorAll("style"))
            .map((s) => s.textContent ?? "")
            .join("\n");
        expect(css).toMatch(
            /\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground[^}]*var\(--selection-bg\)/,
        );
    });
});

// The Settings font and size used to apply to the preview only: the CodeMirror
// theme hard-coded `font-family: 'JetBrains Mono'` and `font-size: 14px`, so
// changing either did nothing to the markdown source. These lock the editor to
// the same variables the preview reads, and keep code spans monospace so tables
// and indentation still line up under a proportional body font.
describe("editor typography follows the Settings font and size", () => {
    async function editorCss() {
        const { container } = render(
            <TestProviders>
                <CodeEditor content="hello `code`" onChange={() => { }} />
            </TestProviders>,
        );
        await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
        return Array.from(document.querySelectorAll("style"))
            .map((s) => s.textContent ?? "")
            .join("\n");
    }

    it("sizes the editor from --font-size-editor, not a fixed px value", async () => {
        const css = await editorCss();
        expect(css).toMatch(/font-size:\s*var\(--font-size-editor\)/);
        expect(css).toMatch(/line-height:\s*var\(--line-height-editor\)/);
    });

    it("sets the editor typeface from --font-body", async () => {
        expect(await editorCss()).toMatch(/\.cm-scroller\s*\{[^}]*font-family:\s*var\(--font-body\)/);
    });

    it("keeps code spans monospace regardless of the body font", async () => {
        expect(await editorCss()).toMatch(/var\(--syntax-code\)[^}]*font-family:\s*var\(--font-mono\)/);
    });
});
