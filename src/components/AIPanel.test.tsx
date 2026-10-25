import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { AIConfig } from "../utils/aiAssist";

// streamChat is the slow part, so it is the part held open: each test decides when
// the reply arrives, and changes what the panel is looking at in the meantime.
// parseEdits and the message builders stay real.
let reply!: (text: string) => void;
vi.mock("../utils/aiChat", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/aiChat")>()),
    streamChat: vi.fn(() => new Promise<string>((resolve) => { reply = resolve; })),
}));

const { AIPanel } = await import("./AIPanel");

const cfg: AIConfig = { endpoint: "https://api.test/v1/chat/completions", model: "m" };
const block = (s: string, r: string) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

type Props = Parameters<typeof AIPanel>[0];
let onProposeEdit: ReturnType<typeof vi.fn<NonNullable<Props["onProposeEdit"]>>>;
const props = (over: Partial<Props>): Props => ({
    isOpen: true,
    onClose: () => {},
    note: "",
    fileName: "a.md",
    selectionText: "",
    aiConfig: cfg,
    onProposeEdit,
    ...over,
});

beforeEach(() => {
    onProposeEdit = vi.fn(() => true);
});
afterEach(cleanup);

/** Ask for an edit in Agent mode, through the panel's own controls. */
function askForEdit() {
    fireEvent.click(screen.getByRole("button", { name: "agent" }));
    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), { target: { value: "fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("AIPanel proposals belong to the document they were asked about", () => {
    it("does not propose edits made for one tab over another", async () => {
        const { rerender } = render(<AIPanel {...props({ documentId: "a", note: "A text\n" })} />);
        askForEdit();

        rerender(<AIPanel {...props({ documentId: "b", note: "B text\n" })} />);
        await act(async () => reply(block("A text", "A edited")));

        expect(onProposeEdit).not.toHaveBeenCalled();
        expect(await screen.findByText(/switched documents/i)).toBeTruthy();
    });

    // Applying the blocks to the text as it was when asked would build a review that
    // lacks everything typed since, and accepting it would undo those edits.
    it("applies the edits to the document as it is now, keeping what was typed meanwhile", async () => {
        const { rerender } = render(<AIPanel {...props({ documentId: "a", note: "Hello world.\n" })} />);
        askForEdit();

        rerender(<AIPanel {...props({ documentId: "a", note: "Hello world.\nTyped while waiting.\n" })} />);
        await act(async () => reply(block("Hello world.", "Hello, brave new world!")));

        await waitFor(() => expect(onProposeEdit).toHaveBeenCalledTimes(1));
        expect(onProposeEdit).toHaveBeenCalledWith("Hello, brave new world!\nTyped while waiting.\n", {
            documentId: "a",
            base: "Hello world.\nTyped while waiting.\n",
        });
    });

    it("says so when the app refuses the proposal", async () => {
        onProposeEdit = vi.fn(() => false);
        render(<AIPanel {...props({ documentId: "a", note: "Hello world.\n" })} />);
        askForEdit();

        await act(async () => reply(block("Hello world.", "Bye.")));

        expect(await screen.findByText(/switched documents/i)).toBeTruthy();
        expect(screen.queryByText(/Review and Accept/i)).toBeNull();
    });
});
