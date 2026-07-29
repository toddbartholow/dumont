// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

// Regression test for the invisible editor selection (CodenameFlux review).
// CodeMirror's base theme paints the FOCUSED selection through
// `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`,
// which out-specifies the app theme's generic `.cm-selectionBackground` rule —
// so every theme rendered CM's default lavender (#d7d4f0), unreadable against
// light/paper text. The theme must mirror that selector shape for
// --selection-bg to win.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, waitFor, cleanup, screen, act } from "@testing-library/react";
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

// The title-bar Find button reaches the editor's find bar through a registered
// callback, because that bar's state lives in here. The toggle reads findOpen
// from a ref rather than the effect's closure; capture it instead and the second
// click is a no-op, which is the whole failure this guards.
describe("registerToggleFind", () => {
    // The register prop is a vi.fn() rather than an inline arrow on purpose. An
    // inline arrow is a new identity every render, so the registering effect
    // re-runs constantly and hands out a freshly-closed-over toggle each time,
    // which is exactly the condition that would HIDE the stale-closure bug. In
    // production App's registerToggleFind is useCallback-stable, the effect runs
    // once, and the ref is what keeps the single long-lived toggle correct.
    // A stable mock reproduces that.
    type ToggleFind = () => void;

    async function mount() {
        const registerToggleFind = vi.fn<(t: ToggleFind | null) => void>();
        const onFindOpenChange = vi.fn<(open: boolean) => void>();
        const { container, unmount } = render(
            <TestProviders>
                <CodeEditor
                    content="hello"
                    onChange={() => {}}
                    registerToggleFind={registerToggleFind}
                    onFindOpenChange={onFindOpenChange}
                />
            </TestProviders>,
        );
        await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
        // A throw, not a cast: this narrows on a real runtime check, and it fails
        // legibly if registration ever stops happening instead of blowing up as
        // "toggle is not a function" from inside act().
        const toggle = registerToggleFind.mock.lastCall?.[0];
        if (typeof toggle !== "function") throw new Error("CodeEditor never registered a find toggle");
        return { toggle, onFindOpenChange, registerToggleFind, unmount };
    }

    it("opens the find bar, then closes it on a second call", async () => {
        const { toggle } = await mount();

        act(() => toggle());
        await waitFor(() => expect(screen.queryByLabelText("Find text")).toBeTruthy());

        act(() => toggle());
        await waitFor(() => expect(screen.queryByLabelText("Find text")).toBeNull());
    });

    it("reports every open and close to onFindOpenChange", async () => {
        const { toggle, onFindOpenChange } = await mount();
        onFindOpenChange.mockClear();

        // lastCall, not toHaveBeenCalledWith: the latter scans every call, so a
        // spurious extra report after the one we want would still pass.
        act(() => toggle());
        await waitFor(() => expect(onFindOpenChange.mock.lastCall).toEqual([true]));

        act(() => toggle());
        await waitFor(() => expect(onFindOpenChange.mock.lastCall).toEqual([false]));
    });

    // Closing from the title-bar button must not drag focus into the document:
    // that button stays mounted, unlike the bar's own × which has to rehome
    // focus because it is inside what is being removed.
    it("leaves focus alone when closed from outside the bar", async () => {
        const { toggle } = await mount();
        act(() => toggle());
        await waitFor(() => expect(screen.queryByLabelText("Find text")).toBeTruthy());

        const outside = document.createElement("button");
        document.body.appendChild(outside);
        outside.focus();

        act(() => toggle());
        await waitFor(() => expect(screen.queryByLabelText("Find text")).toBeNull());
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });

    it("hands the callback back as null on unmount", async () => {
        const { registerToggleFind, unmount } = await mount();
        unmount();
        expect(registerToggleFind).toHaveBeenLastCalledWith(null);
    });
});
