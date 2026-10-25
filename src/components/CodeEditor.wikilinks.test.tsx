import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { startCompletion } from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";
import { CodeEditor } from "./CodeEditor";
import { TestProviders } from "../test/providers";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

beforeAll(installCodeMirrorDomPolyfills);
afterEach(cleanup);

type Entry = { name: string; path: string };

/**
 * `[[` completion offers the open file's sibling notes, listed through Rust. The listing
 * takes time, and the open file can change while it is out: a late listing of the folder
 * just left must not become the completions for the folder now open.
 */
describe("wikilink completion", () => {
    it("offers the current folder's notes when the previous folder's listing lands late", async () => {
        const held = new Map<string, (e: Entry[]) => void>();
        mockInvoke.mockImplementation(((cmd: string, args: { directory?: string }) => {
            if (cmd !== "list_directory_files") return Promise.resolve(null);
            return new Promise((resolve) => held.set(args.directory!, resolve as (e: Entry[]) => void));
        }) as typeof invoke);

        const editor = (filePath: string) => (
            <TestProviders>
                <CodeEditor content="" onChange={() => {}} filePath={filePath} />
            </TestProviders>
        );
        const { container, rerender } = render(editor("/old/x.md"));
        await waitFor(() => expect(held.has("/old")).toBe(true));
        rerender(editor("/new/y.md"));
        await waitFor(() => expect(held.has("/new")).toBe(true));

        await act(async () => held.get("/new")!([{ name: "current-note.md", path: "/new/current-note.md" }]));
        await act(async () => held.get("/old")!([{ name: "stale-note.md", path: "/old/stale-note.md" }]));

        const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
        act(() => {
            view.dispatch({ changes: { from: 0, insert: "[[" }, selection: { anchor: 2 } });
            startCompletion(view);
        });

        await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeTruthy());
        const offered = document.querySelector(".cm-tooltip-autocomplete")!.textContent ?? "";
        expect(offered).toMatch(/current-note/);
        expect(offered).not.toMatch(/stale-note/);
    });
});
