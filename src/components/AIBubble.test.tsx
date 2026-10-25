import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { AIBubble } from "./AIBubble";
import { runAIAction } from "../utils/aiAssist";

vi.mock("../utils/aiAssist", () => ({ runAIAction: vi.fn() }));
const mockRun = vi.mocked(runAIAction);

// Vitest globals are off, so testing-library's auto-cleanup isn't registered.
afterEach(cleanup);

const cfg = { endpoint: "https://x/v1/chat/completions", model: "m" };
const noop = () => {};

describe("AIBubble", () => {
    it("renders nothing without an anchor", () => {
        const { container } = render(
            <AIBubble anchor={null} selectedText="x" config={cfg} onReplace={noop} onInsert={noop} onClose={noop} />
        );
        expect(container.firstChild).toBeNull();
    });

    it("shows only selection-free actions when nothing is selected", () => {
        render(
            <AIBubble anchor={{ x: 0, y: 0 }} selectedText="" config={cfg} onReplace={noop} onInsert={noop} onClose={noop} />
        );
        expect(screen.getByText("Continue")).toBeInTheDocument();
        expect(screen.queryByText("Rewrite")).toBeNull();
    });

    it("shows selection actions when text is selected", () => {
        render(
            <AIBubble anchor={{ x: 0, y: 0 }} selectedText="hello" config={cfg} onReplace={noop} onInsert={noop} onClose={noop} />
        );
        expect(screen.getByText("Rewrite")).toBeInTheDocument();
        expect(screen.getByText("Shorten")).toBeInTheDocument();
        expect(screen.getByText("Expand")).toBeInTheDocument();
    });
});

/**
 * The request outlives the bubble's own state: it can be closed, reopened and asked again
 * while an earlier request is still out. Each request here is held open, so the order the
 * answers land in is the test's to choose.
 */
describe("AIBubble requests", () => {
    type Held = { signal: AbortSignal; resolve: (s: string) => void; reject: (e: unknown) => void };
    let held: Held[] = [];
    beforeEach(() => {
        held = [];
        mockRun.mockReset().mockImplementation(
            (_action, _text, _cfg, signal) =>
                new Promise<string>((resolve, reject) => held.push({ signal: signal!, resolve, reject }))
        );
    });
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    const bubble = (anchor: { x: number; y: number } | null) => (
        <AIBubble anchor={anchor} selectedText="hello" config={cfg} onReplace={noop} onInsert={noop} onClose={noop} />
    );
    const rewrite = () => screen.getByRole("button", { name: /Rewrite/ });

    it("aborts the request when the bubble is hidden", async () => {
        const { rerender } = render(bubble({ x: 0, y: 0 }));
        fireEvent.click(rewrite());
        rerender(bubble(null));
        expect(held[0].signal.aborted).toBe(true);
    });

    it("aborts the request when the bubble is unmounted", async () => {
        const { unmount } = render(bubble({ x: 0, y: 0 }));
        fireEvent.click(rewrite());
        unmount();
        expect(held[0].signal.aborted).toBe(true);
    });

    it("an aborted request settling late does not end the one that replaced it", async () => {
        const { rerender } = render(bubble({ x: 0, y: 0 }));
        fireEvent.click(rewrite());
        rerender(bubble(null));
        rerender(bubble({ x: 10, y: 10 }));
        fireEvent.click(rewrite());
        expect(held).toHaveLength(2);

        await act(async () => held[0].reject(abortError()));

        // Still busy with the second request: its button spins and the others stay off.
        expect(rewrite()).toBeDisabled();
        expect(rewrite().textContent).toMatch(/progress_activity/);

        await act(async () => held[1].resolve("second answer"));
        expect(screen.getByText("second answer")).toBeInTheDocument();
        expect(rewrite()).not.toBeDisabled();
    });

    it("does not show a result that arrives after its request was aborted", async () => {
        const { rerender } = render(bubble({ x: 0, y: 0 }));
        fireEvent.click(rewrite());
        rerender(bubble(null));
        rerender(bubble({ x: 10, y: 10 }));

        // A transport that ignored the signal and answered anyway.
        await act(async () => held[0].resolve("stale answer"));

        expect(screen.queryByText("stale answer")).toBeNull();
    });
});
