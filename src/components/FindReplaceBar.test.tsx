// Regression tests for the find-bar focus steal (Reddit: Individual-Diet-5051).
// The auto-jump that follows each query keystroke used to call view.focus(),
// moving DOM focus into the CodeMirror document ~100ms (one debounce) after the
// first character — so the user's next keystroke overwrote the matched text.
// These tests mount the real CodeEditor and assert focus stays in the find
// input across the debounce and across Enter-to-cycle.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, fireEvent, waitFor, screen, cleanup } from "@testing-library/react";
import { CodeEditor } from "./CodeEditor";
import { FindReplaceBar } from "./FindReplaceBar";
import { TestProviders } from "../test/providers";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";

beforeAll(installCodeMirrorDomPolyfills);

// RTL's automatic cleanup needs vitest `globals: true`, which this repo doesn't
// enable — without this the second test finds two mounted editors.
afterEach(cleanup);

const DEBOUNCE_MS = 100;

async function mountEditorWithFindOpen(onChange = vi.fn()) {
    const utils = render(
        <TestProviders>
            <CodeEditor content="hello world hello" onChange={onChange} />
        </TestProviders>,
    );
    const content = await waitFor(() => {
        const el = utils.container.querySelector<HTMLElement>(".cm-content");
        expect(el).toBeTruthy();
        return el!;
    });
    fireEvent.keyDown(content, { key: "f", ctrlKey: true });
    const input = await screen.findByLabelText<HTMLInputElement>("Find text");
    input.focus();
    return { ...utils, input, content, onChange };
}

describe("FindReplaceBar focus ownership", () => {
    it("keeps focus in the find input after typing a character and passing the debounce", async () => {
        const { input, onChange } = await mountEditorWithFindOpen();
        expect(document.activeElement).toBe(input);

        fireEvent.change(input, { target: { value: "h" } });
        // The counter renders in the same commit whose effects run the
        // auto-jump, so once it shows, the jump (the old focus thief) has fired.
        await screen.findByText("1 of 2", undefined, { timeout: DEBOUNCE_MS * 20 });

        expect(document.activeElement).toBe(input);
        // The document itself must never change from find-as-you-type.
        expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps focus in the find input when Enter cycles to the next match", async () => {
        const { input, onChange } = await mountEditorWithFindOpen();

        fireEvent.change(input, { target: { value: "hello" } });
        await screen.findByText("1 of 2", undefined, { timeout: DEBOUNCE_MS * 20 });

        fireEvent.keyDown(input, { key: "Enter" });
        // "2 of 2" proves the cycle actually advanced (and re-ran the jump).
        await screen.findByText("2 of 2", undefined, { timeout: DEBOUNCE_MS * 20 });

        expect(document.activeElement).toBe(input);
        expect(onChange).not.toHaveBeenCalled();
    });
});

/**
 * A CLOSED find bar must be inert.
 *
 * CodeEditor mounts this component unconditionally and it only hides itself with
 * `if (!isOpen) return null`, so its effects keep running after Escape. It does not
 * clear the query on close either. Both effects therefore kept going: every keystroke
 * in the document re-ran the search against the dismissed query, and when an edit
 * shifted a match's offset the memo bail-out failed, `match` changed identity, and the
 * auto-jump effect called onJumpTo. The caret was dragged out of the sentence the user
 * was typing and back to a match they had already dismissed.
 *
 * Rendering it directly (rather than through CodeEditor) is the point: nothing in the
 * suite had ever rendered this component CLOSED, which is exactly why the bug survived.
 */
describe("a closed FindReplaceBar", () => {
    const props = (over: Partial<React.ComponentProps<typeof FindReplaceBar>> = {}) => ({
        isOpen: true,
        content: "hello world hello",
        selectionStart: 0,
        onClose: vi.fn(),
        onReplace: vi.fn(),
        onJumpTo: vi.fn(),
        ...over,
    });

    it("does not move the caret when the document changes after it is closed", async () => {
        const onJumpTo = vi.fn();
        const p = props({ onJumpTo });
        const { rerender } = render(<FindReplaceBar {...p} />);

        // Search for something, and let the auto-jump land as it should while open.
        const input = screen.getByLabelText<HTMLInputElement>("Find text");
        fireEvent.change(input, { target: { value: "hello" } });
        await waitFor(() => expect(onJumpTo).toHaveBeenCalled(), { timeout: DEBOUNCE_MS * 20 });

        // Close the bar. The query is deliberately NOT cleared, matching CodeEditor's
        // onClose, which only flips the flag and refocuses the editor.
        onJumpTo.mockClear();
        rerender(<FindReplaceBar {...p} isOpen={false} />);

        // Now type in the document. Every one of these used to re-run the search and
        // could yank the caret to a stale match.
        rerender(<FindReplaceBar {...p} isOpen={false} content="Xhello world hello" />);
        rerender(<FindReplaceBar {...p} isOpen={false} content="XYhello world hello" />);
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 4));

        expect(onJumpTo).not.toHaveBeenCalled();
    });

    it("still works normally once it is reopened", async () => {
        const onJumpTo = vi.fn();
        const p = props({ onJumpTo, isOpen: false });
        const { rerender } = render(<FindReplaceBar {...p} />);

        rerender(<FindReplaceBar {...p} isOpen={true} />);
        const input = screen.getByLabelText<HTMLInputElement>("Find text");
        fireEvent.change(input, { target: { value: "world" } });

        await waitFor(() => expect(onJumpTo).toHaveBeenCalledWith(6, 11), {
            timeout: DEBOUNCE_MS * 20,
        });
    });

    /**
     * THE invariant. Every jump must target a match that exists in the document as it
     * is NOW.
     *
     * The bar keeps its query across a close (that is deliberate: Ctrl+F remembers what
     * you last looked for), and the component never unmounts, so the MATCH ARRAY used to
     * outlive the close too. Guarding the effects on `isOpen` froze that array rather
     * than clearing it, and `isOpen` in the auto-jump's deps made that effect run the
     * instant the bar reopened, before the debounced re-search could correct anything.
     * So reopening jumped to an offset computed against a document that no longer
     * existed. Re-searching on reopen and jumping to a REAL match is fine, and is what
     * the app has always done; jumping to a remembered offset is not.
     */
    it("only ever jumps to a match that exists in the current document", async () => {
        const onJumpTo = vi.fn();
        const p = props({ onJumpTo, content: "hello world hello" });
        const { rerender } = render(<FindReplaceBar {...p} />);

        const input = screen.getByLabelText<HTMLInputElement>("Find text");
        fireEvent.change(input, { target: { value: "hello" } });
        await waitFor(() => expect(onJumpTo).toHaveBeenCalled(), { timeout: DEBOUNCE_MS * 20 });

        rerender(<FindReplaceBar {...p} isOpen={false} />);
        onJumpTo.mockClear();

        // The user switches to a MUCH shorter document and reopens the bar. The old
        // offsets (0 and 12) are now past the end of it.
        const now = "hi";
        rerender(<FindReplaceBar {...p} isOpen={false} content={now} />);
        rerender(<FindReplaceBar {...p} isOpen={true} content={now} />);
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 4));

        for (const [start, end] of onJumpTo.mock.calls) {
            // A selection outside the document is a RangeError out of a passive effect,
            // which unwinds into the error boundary and takes the app down.
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeLessThanOrEqual(now.length);
            // And it must be a genuine occurrence, not a coincidence of arithmetic.
            expect(now.slice(start, end).toLowerCase()).toBe("hello".slice(0, end - start));
        }
    });

    /**
     * Reopening searches from where the CARET is now, not from where the last session
     * left off.
     *
     * This is what the match-clearing on close buys, and it is separate from the crash.
     * The recompute has a sticky rule: if the match array is unchanged it keeps the
     * previous `activeIdx`. So with a surviving match array, reopening the bar in an
     * unedited document re-selects the match the user had walked to before, and yanks
     * the view back to it, however far they have since scrolled. Clearing on close means
     * `activeIdx` restarts at -1 and the first match at or after the caret wins, which
     * is what "find" has always meant.
     */
    it("finds from the caret on reopen, not from the last session's active match", async () => {
        const onJumpTo = vi.fn();
        // Caret sits past the first "hello" (offset 0), so the search starts at the second.
        const p = props({ onJumpTo, content: "hello world hello", selectionStart: 12 });
        const { rerender } = render(<FindReplaceBar {...p} />);

        const input = screen.getByLabelText<HTMLInputElement>("Find text");
        fireEvent.change(input, { target: { value: "hello" } });
        await waitFor(() => expect(onJumpTo).toHaveBeenCalledWith(12, 17), {
            timeout: DEBOUNCE_MS * 20,
        });

        rerender(<FindReplaceBar {...p} isOpen={false} />);
        onJumpTo.mockClear();

        // The user scrolls back to the top and puts the caret there, then reopens.
        rerender(<FindReplaceBar {...p} isOpen={false} selectionStart={0} />);
        rerender(<FindReplaceBar {...p} isOpen={true} selectionStart={0} />);

        // The FIRST match, because that is the one at or after the caret. Not (12, 17),
        // which is where the previous session happened to stop.
        await waitFor(() => expect(onJumpTo).toHaveBeenCalledWith(0, 5), {
            timeout: DEBOUNCE_MS * 20,
        });
    });

    /** The document still holds the query: reopening finds it again, at its real offset. */
    it("re-searches the current document on reopen rather than trusting the old result", async () => {
        const onJumpTo = vi.fn();
        const p = props({ onJumpTo, content: "hello world hello" });
        const { rerender } = render(<FindReplaceBar {...p} />);

        const input = screen.getByLabelText<HTMLInputElement>("Find text");
        fireEvent.change(input, { target: { value: "hello" } });
        await waitFor(() => expect(onJumpTo).toHaveBeenCalled(), { timeout: DEBOUNCE_MS * 20 });

        rerender(<FindReplaceBar {...p} isOpen={false} />);
        onJumpTo.mockClear();

        // Six characters are inserted at the front, so every match moves by six.
        const shifted = "XXXXXX" + "hello world hello";
        rerender(<FindReplaceBar {...p} isOpen={false} content={shifted} />);
        rerender(<FindReplaceBar {...p} isOpen={true} content={shifted} />);

        await waitFor(() => expect(onJumpTo).toHaveBeenCalledWith(6, 11), {
            timeout: DEBOUNCE_MS * 20,
        });
    });
});
