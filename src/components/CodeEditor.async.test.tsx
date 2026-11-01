// Things the editor does LATER: an HTML or image paste that waits on a
// conversion or a disk write, the AI bubble's Replace and Insert, and a review
// that ends when its last change is resolved. Each one used to act on offsets
// or state captured before the wait, which by then could point at different
// text or a different document.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { getChunks, acceptChunk, rejectChunk } from "@codemirror/merge";
import { CodeEditor } from "./CodeEditor";
import { TestProviders } from "../test/providers";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";
import { htmlToMarkdown } from "../utils/smartPaste";
import { getImageFromClipboard, saveImageToFile } from "../utils/imageUtils";
import { runAIAction } from "../utils/aiAssist";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("../utils/smartPaste", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/smartPaste")>()),
    htmlToMarkdown: vi.fn(),
}));
vi.mock("../utils/imageUtils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/imageUtils")>()),
    getImageFromClipboard: vi.fn(() => null),
    saveImageToFile: vi.fn(),
}));
vi.mock("../utils/aiAssist", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/aiAssist")>()),
    runAIAction: vi.fn(),
}));

beforeAll(installCodeMirrorDomPolyfills);
beforeEach(() => {
    vi.mocked(getImageFromClipboard).mockReturnValue(null);
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

type Props = Partial<React.ComponentProps<typeof CodeEditor>>;

function setup(initial: Props & { content: string }) {
    const onNotice = vi.fn();
    const onReviewResolve = vi.fn();
    const base: React.ComponentProps<typeof CodeEditor> = {
        onChange: () => {},
        onNotice,
        onReviewResolve,
        docSwapId: 1,
        aiConfig: { endpoint: "http://localhost:1234/v1", model: "m" },
        ...initial,
    };
    const ui = (p: Props) => (
        <TestProviders settings={{ "ai.enabled": true }}>
            <CodeEditor {...base} {...p} />
        </TestProviders>
    );
    const utils = render(ui({}));
    const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
    return { ...utils, view, onNotice, onReviewResolve, update: (p: Props) => utils.rerender(ui(p)) };
}

function paste(view: EditorView, html: string, text: string) {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
        value: { getData: (t: string) => (t === "text/html" ? html : t === "text/plain" ? text : ""), items: [] },
    });
    view.contentDOM.dispatchEvent(ev);
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

describe("HTML paste across its await", () => {
    it("lands where it was pasted even if the caret moved meanwhile", async () => {
        const conv = deferred<string>();
        vi.mocked(htmlToMarkdown).mockReturnValue(conv.promise);
        const { view } = setup({ content: "hello world" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 5 } });
        paste(v, "<b>B</b>", "B");

        // While turndown loads, the user clicks to the end and types.
        v.dispatch({ selection: { anchor: 11 } });
        v.dispatch({ changes: { from: 11, insert: "!" }, selection: { anchor: 12 } });
        await act(async () => { conv.resolve("**B**"); await conv.promise; });

        expect(v.state.doc.toString()).toBe("hello**B** world!");
        // And the caret stays where they were typing.
        expect(v.state.selection.main.head).toBe(17);
    });

    it("follows the text when something is typed in front of it", async () => {
        const conv = deferred<string>();
        vi.mocked(htmlToMarkdown).mockReturnValue(conv.promise);
        const { view } = setup({ content: "hello world" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 5 } });
        paste(v, "<b>B</b>", "B");
        v.dispatch({ changes: { from: 0, insert: "Oh, " } });
        await act(async () => { conv.resolve("**B**"); await conv.promise; });
        expect(v.state.doc.toString()).toBe("Oh, hello**B** world");
    });

    it("does not delete text typed inside the selection it was going to replace", async () => {
        const conv = deferred<string>();
        vi.mocked(htmlToMarkdown).mockReturnValue(conv.promise);
        const { view } = setup({ content: "hello world" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 0, head: 5 } });
        paste(v, "<b>B</b>", "B");
        v.dispatch({ changes: { from: 2, insert: "X" } });
        await act(async () => { conv.resolve("**B**"); await conv.promise; });
        // The edited selection is kept and the paste goes after it.
        expect(v.state.doc.toString()).toBe("heXllo**B** world");
    });

    it("replaces the selection as usual when nothing changed", async () => {
        const conv = deferred<string>();
        vi.mocked(htmlToMarkdown).mockReturnValue(conv.promise);
        const { view } = setup({ content: "hello world" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 6, head: 11 } });
        paste(v, "<b>B</b>", "B");
        await act(async () => { conv.resolve("**B**"); await conv.promise; });
        expect(v.state.doc.toString()).toBe("hello **B**");
        expect(v.state.selection.main.head).toBe(11);
    });

    it("is dropped, not written into the next document, after a tab switch", async () => {
        const conv = deferred<string>();
        vi.mocked(htmlToMarkdown).mockReturnValue(conv.promise);
        const { view, update } = setup({ content: "hello world" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 5 } });
        paste(v, "<b>B</b>", "B");
        update({ content: "another file", docSwapId: 2 });
        await act(async () => { conv.resolve("**B**"); await conv.promise; });
        expect(v.state.doc.toString()).toBe("another file");
    });
});

describe("image paste across its await", () => {
    const fakeImage = () => new File([new Uint8Array([1])], "x.png", { type: "image/png" });

    it("lands where it was pasted even if the caret moved meanwhile", async () => {
        const save = deferred<string>();
        vi.mocked(getImageFromClipboard).mockReturnValue(fakeImage());
        vi.mocked(saveImageToFile).mockReturnValue(save.promise);
        const { view } = setup({ content: "ab", filePath: "/notes/a.md" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        v.dispatch({ selection: { anchor: 1 } });
        paste(v, "", "");
        v.dispatch({ selection: { anchor: 2 } });
        await act(async () => { save.resolve("img.png"); await save.promise; });
        expect(v.state.doc.toString()).toMatch(/^a!\[[^\]]*\]\(img\.png\)b$/);
    });

    it("is not inserted into another document after a tab switch, and says so", async () => {
        const save = deferred<string>();
        vi.mocked(getImageFromClipboard).mockReturnValue(fakeImage());
        vi.mocked(saveImageToFile).mockReturnValue(save.promise);
        const { view, update, onNotice } = setup({ content: "ab", filePath: "/notes/a.md" });
        await waitFor(() => expect(view()).toBeTruthy());
        const v = view();
        paste(v, "", "");
        update({ content: "other", filePath: "/notes/b.md", docSwapId: 2 });
        await act(async () => { save.resolve("img.png"); await save.promise; });
        await flush();
        expect(v.state.doc.toString()).toBe("other");
        expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("img.png"));
    });
});

describe("AI bubble Replace and Insert", () => {
    async function openBubbleOn(content: string, from: number, to: number) {
        const ai = deferred<string>();
        vi.mocked(runAIAction).mockReturnValue(ai.promise);
        const s = setup({ content });
        await waitFor(() => expect(s.view()).toBeTruthy());
        const v = s.view();
        v.dispatch({ selection: { anchor: from, head: to } });
        act(() => { window.dispatchEvent(new CustomEvent("dumont:ai-assist")); });
        fireEvent.click(await screen.findByTitle("Rewrite"));
        return { ...s, v, ai };
    }
    const finish = async (ai: { resolve: (s: string) => void; promise: Promise<string> }, out: string) => {
        await act(async () => { ai.resolve(out); await ai.promise; });
        return within();
    };
    const within = () => screen.getByRole("dialog", { name: "AI assist" });

    it("replaces the original words even after text was typed above them", async () => {
        const { v, ai } = await openBubbleOn("hello world", 6, 11);
        v.dispatch({ changes: { from: 0, insert: "Oh, " } });
        await finish(ai, "EARTH");
        fireEvent.click(screen.getByRole("button", { name: "Replace" }));
        // Used to splice at the offsets captured on open: "Oh, heEARTHorld".
        expect(v.state.doc.toString()).toBe("Oh, hello EARTH");
        expect(screen.queryByRole("dialog", { name: "AI assist" })).toBeNull();
    });

    it("inserts below the mapped selection", async () => {
        const { v, ai } = await openBubbleOn("hello world", 0, 5);
        v.dispatch({ changes: { from: 0, insert: ">> " } });
        await finish(ai, "HI");
        fireEvent.click(screen.getByRole("button", { name: "Insert below" }));
        expect(v.state.doc.toString()).toBe(">> hello\n\nHI world");
    });

    it("refuses to Replace when the selected words were edited, and keeps the bubble", async () => {
        const { v, ai, onNotice } = await openBubbleOn("hello world", 6, 11);
        v.dispatch({ changes: { from: 8, insert: "X" } });
        await finish(ai, "EARTH");
        fireEvent.click(screen.getByRole("button", { name: "Replace" }));
        expect(v.state.doc.toString()).toBe("hello woXrld");
        expect(onNotice).toHaveBeenCalled();
        // Insert is still offered and still lands after the (edited) selection.
        fireEvent.click(screen.getByRole("button", { name: "Insert below" }));
        expect(v.state.doc.toString()).toBe("hello woXrld\n\nEARTH");
    });

    it("closes on a tab switch so it cannot write into the next document", async () => {
        const { v, update } = await openBubbleOn("hello world", 6, 11);
        expect(within()).toBeTruthy();
        update({ content: "a different file", docSwapId: 2 });
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI assist" })).toBeNull());
        expect(v.state.doc.toString()).toBe("a different file");
    });
});

describe("AI review resolved one change at a time", () => {
    const original = "one\ntwo\nthree\nfour\nfive\nsix\n";
    const proposed = "one\nTWO\nthree\nfour\nfive\nSIX\n";

    async function startReview(reviewDoc: string) {
        const s = setup({ content: original });
        await waitFor(() => expect(s.view()).toBeTruthy());
        s.update({ reviewDoc });
        await screen.findByRole("button", { name: "Accept all" });
        return s;
    }
    const chunks = (v: EditorView) => getChunks(v.state)?.chunks ?? [];

    it("ends the review when the last change is resolved individually", async () => {
        const { view, onReviewResolve } = await startReview(proposed);
        const v = view();
        expect(chunks(v).length).toBe(2);
        act(() => { rejectChunk(v, chunks(v)[0].fromB); });
        act(() => { acceptChunk(v, chunks(v)[0].fromB); });
        await nextFrame();
        await waitFor(() => expect(onReviewResolve).toHaveBeenCalledWith("one\ntwo\nthree\nfour\nfive\nSIX\n"));
        expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    });

    it("ends it when every change is ACCEPTED one by one, which leaves the doc unchanged", async () => {
        const { view, onReviewResolve } = await startReview(proposed);
        const v = view();
        act(() => { acceptChunk(v, chunks(v)[0].fromB); });
        act(() => { acceptChunk(v, chunks(v)[0].fromB); });
        await nextFrame();
        await waitFor(() => expect(onReviewResolve).toHaveBeenCalledWith(proposed));
        expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    });

    it("stays open while changes remain", async () => {
        const { view, onReviewResolve } = await startReview(proposed);
        const v = view();
        act(() => { acceptChunk(v, chunks(v)[0].fromB); });
        await nextFrame();
        await nextFrame();
        expect(onReviewResolve).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Accept all" })).toBeTruthy();
    });

    it("does not close a review that started with no changes at all", async () => {
        const { view, onReviewResolve } = await startReview(original);
        expect(chunks(view()).length).toBe(0);
        // Any edit runs the update listener; a zero count must not read as "done".
        act(() => { view().dispatch({ selection: { anchor: 1 } }); });
        await nextFrame();
        await nextFrame();
        expect(onReviewResolve).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Accept all" })).toBeTruthy();
    });
});
