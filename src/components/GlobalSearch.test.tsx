import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { GlobalSearch } from "./GlobalSearch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

// Vitest globals are off, so testing-library's auto-cleanup isn't registered.
afterEach(cleanup);

type Result = { path: string; name: string; matches: { line: number; text: string }[] };
const hit = (name: string, text = "foo"): Result[] => [{ path: `/notes/${name}`, name, matches: [{ line: 3, text }] }];

/** Every search_files call, held open until the test settles it. */
let pending: { query: string; resolve: (r: Result[]) => void; reject: (e: unknown) => void }[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    pending = [];
    mockInvoke.mockReset().mockImplementation((_cmd, args) =>
        new Promise((resolve, reject) => {
            pending.push({ query: (args as { query: string }).query, resolve: resolve as (r: Result[]) => void, reject });
        })
    );
});
afterEach(() => vi.useRealTimers());

function setup(props: Partial<Parameters<typeof GlobalSearch>[0]> = {}) {
    const onOpenResult = vi.fn();
    const all = { isOpen: true, directory: "/notes", onClose: vi.fn(), onOpenResult, ...props };
    const view = render(<GlobalSearch {...all} />);
    return { ...view, onOpenResult, rerender: (p: Partial<typeof all>) => view.rerender(<GlobalSearch {...all} {...p} />) };
}

const input = () => screen.getByPlaceholderText(/Search across files/);
/** Type into the box and let the 200 ms debounce send the search. */
const type = async (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
};
const settle = (i: number, how: { results?: Result[]; error?: string }) =>
    act(async () => {
        if (how.error !== undefined) pending[i].reject(how.error);
        else pending[i].resolve(how.results ?? []);
    });
const enter = () => fireEvent.keyDown(input(), { key: "Enter" });

describe("GlobalSearch", () => {
    it("opens the active match on Enter", async () => {
        const { onOpenResult } = setup();
        await type("foo");
        await settle(0, { results: hit("a.md") });

        enter();

        expect(onOpenResult).toHaveBeenCalledWith("/notes/a.md", 3);
    });

    // The bug: an empty query did not retire the search in flight, so it landed after the
    // box was cleared, refilled the list, and Enter on the empty box opened it.
    it("ignores a search that returns after the box was cleared", async () => {
        const { onOpenResult } = setup();
        await type("foo");
        await type("");
        await settle(0, { results: hit("a.md") });

        expect(screen.queryByText("a.md")).toBeNull();
        enter();
        expect(onOpenResult).not.toHaveBeenCalled();
    });

    it("ignores a search that returns after the panel closed", async () => {
        const { rerender } = setup();
        await type("foo");
        rerender({ isOpen: false });
        await settle(0, { results: hit("a.md") });

        // Reopened on another folder: the new search is still out, and nothing from the old
        // folder may stand in for its results.
        rerender({ isOpen: true, directory: "/elsewhere" });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });

        expect(screen.queryByText("a.md")).toBeNull();
        expect(screen.getByText(/Searching/)).toBeTruthy();
    });

    it("does not open a match from the previous query while the new one runs", async () => {
        const { onOpenResult } = setup();
        await type("foo");
        await settle(0, { results: hit("a.md") });
        await type("food");

        // The old list is still on screen, but it answers "foo", not "food".
        enter();
        expect(onOpenResult).not.toHaveBeenCalled();

        await settle(1, { results: hit("b.md", "food") });
        enter();
        expect(onOpenResult).toHaveBeenCalledWith("/notes/b.md", 3);
    });

    it("keeps the newest answer when an older search fails after it", async () => {
        setup();
        await type("foo");
        await type("food");
        await settle(1, { results: hit("b.md", "food") });
        await settle(0, { error: "disk on fire" });

        expect(screen.getByText("b.md")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps the newest answer when an older search succeeds after it", async () => {
        setup();
        await type("foo");
        await type("food");
        await settle(1, { results: hit("b.md", "food") });
        await settle(0, { results: hit("a.md") });

        expect(screen.getByText("b.md")).toBeTruthy();
        expect(screen.queryByText("a.md")).toBeNull();
    });
});
