import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileExplorer } from "./FileExplorer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

// Vitest globals are off, so testing-library's auto-cleanup isn't registered.
afterEach(cleanup);

type Entry = { name: string; path: string; is_dir: boolean };

/** Every list_directory_files call, held open until the test settles it. */
let pending: { directory: string; resolve: (e: Entry[]) => void; reject: (e: unknown) => void }[] = [];

beforeEach(() => {
    pending = [];
    mockInvoke.mockReset().mockImplementation((_cmd, args) =>
        new Promise((resolve, reject) => {
            pending.push({ directory: (args as { directory: string }).directory, resolve: resolve as (e: Entry[]) => void, reject });
        })
    );
});

const NOTES: Entry[] = [
    { name: "sub", path: "/notes/sub", is_dir: true },
    { name: "a.md", path: "/notes/a.md", is_dir: false },
];
const SUB: Entry[] = [{ name: "deep.md", path: "/notes/sub/deep.md", is_dir: false }];

const settle = (i: number, how: { entries?: Entry[]; error?: string }) =>
    act(async () => {
        if (how.error !== undefined) pending[i].reject(how.error);
        else pending[i].resolve(how.entries ?? []);
    });

/** Open on /notes, then go into sub/ and straight back up before sub/ has listed. */
async function intoSubAndBackUp() {
    render(<FileExplorer isOpen currentFilePath="/notes/a.md" onFileSelect={vi.fn()} onClose={vi.fn()} />);
    await settle(0, { entries: NOTES });
    fireEvent.click(screen.getByText("sub"));
    fireEvent.click(screen.getByRole("button", { name: "Go up one folder" }));
    expect(pending.map((p) => p.directory)).toEqual(["/notes", "/notes/sub", "/notes"]);
}

describe("FileExplorer", () => {
    // The listing of the folder just left used to land last and show its files under the
    // name of the folder now open.
    it("ignores a listing that returns after the folder changed", async () => {
        await intoSubAndBackUp();
        await settle(2, { entries: NOTES });
        await settle(1, { entries: SUB });

        expect(screen.queryByText("deep.md")).toBeNull();
        expect(screen.getByText("a.md")).toBeTruthy();
    });

    it("ignores a failure that returns after the folder changed", async () => {
        await intoSubAndBackUp();
        await settle(2, { entries: NOTES });
        await settle(1, { error: "permission denied" });

        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByText("a.md")).toBeTruthy();
    });

    it("keeps showing Loading until the newest listing is back", async () => {
        await intoSubAndBackUp();
        await settle(1, { entries: SUB });

        expect(screen.getByText("Loading...")).toBeTruthy();
        expect(screen.queryByText("deep.md")).toBeNull();
    });
});
