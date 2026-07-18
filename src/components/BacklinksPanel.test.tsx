import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { BacklinksPanel } from "./BacklinksPanel";

// The global setup mocks invoke with a resolver that answers every command; this
// suite needs to control what find_backlinks returns, so it takes it over.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = invoke as Mock;

const RESULTS = [
    {
        path: "/notes/alpha.md",
        name: "alpha.md",
        matches: [
            { line: 3, text: "see [[Foo]] for context", alias: null },
            { line: 9, text: "and again [[Foo|the other one]]", alias: "the other one" },
        ],
    },
    {
        path: "/notes/beta.md",
        name: "beta.md",
        matches: [{ line: 1, text: "[[Foo]]", alias: null }],
    },
];

const props = {
    isOpen: true,
    currentFilePath: "/notes/Foo.md",
    currentFileName: "Foo.md",
    onOpenResult: vi.fn(),
    onClose: vi.fn(),
};

/** Wait past the scan debounce without asserting anything. */
const idle = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
    mockInvoke.mockReset();
    props.onOpenResult.mockReset();
    props.onClose.mockReset();
});

afterEach(cleanup);

describe("BacklinksPanel", () => {
    it("scans the open file's own folder for its wiki name", async () => {
        mockInvoke.mockResolvedValue([]);
        render(<BacklinksPanel {...props} />);

        // The directory is the file's own folder, and the note name is the basename
        // with the extension stripped. Backlinks are same-folder only, because that
        // is the only place the wikilink resolver looks.
        await waitFor(() =>
            expect(mockInvoke).toHaveBeenCalledWith("find_backlinks", {
                directory: "/notes",
                noteName: "Foo",
            })
        );
    });

    it("groups matches by file and shows line numbers and aliases", async () => {
        mockInvoke.mockResolvedValue(RESULTS);
        render(<BacklinksPanel {...props} />);

        expect(await screen.findByText("alpha.md")).toBeInTheDocument();
        expect(screen.getByText("beta.md")).toBeInTheDocument();

        // Both of alpha.md's snippets, including the second link on its own line.
        expect(screen.getByText("see [[Foo]] for context")).toBeInTheDocument();
        expect(screen.getByText("and again [[Foo|the other one]]")).toBeInTheDocument();
        expect(screen.getByText("9")).toBeInTheDocument();
        // "3" twice: alpha.md's first line number, and the header's total (3 links).
        expect(screen.getAllByText("3")).toHaveLength(2);

        // The alias half of [[target|alias]] is surfaced, and only the aliased
        // link gets an alias line: the other two links have no alias to show.
        const aliasLines = screen.getAllByText(/^as\s/);
        expect(aliasLines).toHaveLength(1);
        expect(aliasLines[0]).toHaveTextContent("the other one");
    });

    it("opens the linking file at the line the link sits on", async () => {
        mockInvoke.mockResolvedValue(RESULTS);
        render(<BacklinksPanel {...props} />);

        fireEvent.click(await screen.findByText("see [[Foo]] for context"));
        expect(props.onOpenResult).toHaveBeenCalledWith("/notes/alpha.md", 3);
    });

    it("shows a real empty state when nothing links here", async () => {
        mockInvoke.mockResolvedValue([]);
        render(<BacklinksPanel {...props} />);

        expect(await screen.findByText("No notes link here yet.")).toBeInTheDocument();
        // The hint names the exact link the user would have to write.
        expect(screen.getByText("[[Foo]]")).toBeInTheDocument();
    });

    it("shows a loading state before the first result arrives", async () => {
        mockInvoke.mockReturnValue(new Promise(() => { /* never resolves */ }));
        render(<BacklinksPanel {...props} />);

        expect(await screen.findByText("Loading...")).toBeInTheDocument();
    });

    it("surfaces a failed scan instead of showing an empty folder", async () => {
        mockInvoke.mockRejectedValue("Failed to read file: boom");
        render(<BacklinksPanel {...props} />);

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Failed to read file: boom");
    });

    // A slow early scan must not overwrite a faster later one: switch files quickly
    // and the stale answer would win the race, and the panel would be showing
    // another note's backlinks under this note's name.
    it("ignores an out-of-order response from a previous file", async () => {
        let resolveFirst: (v: unknown) => void = () => { };
        mockInvoke.mockImplementationOnce(
            () => new Promise((res) => { resolveFirst = res; })
        );

        const { rerender } = render(<BacklinksPanel {...props} />);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

        // Switch to another note. Its scan is the fast one and answers first.
        mockInvoke.mockResolvedValue(RESULTS);
        rerender(
            <BacklinksPanel {...props} currentFilePath="/notes/Bar.md" currentFileName="Bar.md" />
        );
        expect(await screen.findByText("alpha.md")).toBeInTheDocument();

        // Now the first note's scan finally answers. It has to be dropped.
        await act(async () => {
            resolveFirst([{
                path: "/notes/stale.md",
                name: "stale.md",
                matches: [{ line: 1, text: "[[Foo]]", alias: null }],
            }]);
        });

        expect(screen.queryByText("stale.md")).not.toBeInTheDocument();
        expect(screen.getByText("alpha.md")).toBeInTheDocument();
    });

    it("re-scans after a save and when the window regains focus", async () => {
        mockInvoke.mockResolvedValue([]);
        const { rerender } = render(<BacklinksPanel {...props} refreshKey={0} />);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

        // A save bumps refreshKey: another file in this folder may just have gained
        // (or lost) a link to this note.
        rerender(<BacklinksPanel {...props} refreshKey={1} />);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));

        // Focus: the folder may have changed in another app entirely.
        fireEvent.focus(window);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(3));
    });

    it("asks for nothing at all when the buffer has never been saved", async () => {
        render(
            <BacklinksPanel {...props} currentFilePath={null} currentFileName="Untitled-1.md" />
        );
        await idle();

        // An unsaved buffer has no folder, so there is nothing to scan and no
        // command to send.
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(screen.getByText("No notes link here yet.")).toBeInTheDocument();
    });

    it("closes on Escape", async () => {
        mockInvoke.mockResolvedValue([]);
        render(<BacklinksPanel {...props} />);
        await idle();

        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalled();
    });
});
