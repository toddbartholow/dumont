import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { PreviewFindBar } from "./PreviewFindBar";

afterEach(cleanup);

// The reader's bar and the editor's share a focusSignal contract but not a
// lifetime: this one UNMOUNTS when closed, the editor's never does. That makes
// this the half where the signal has to survive a mount rather than just a
// rerender, and it was the untested half.
function mount(focusSignal: number) {
    const root = document.createElement("div");
    root.textContent = "alpha beta alpha";
    document.body.appendChild(root);
    const rootRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
    rootRef.current = root;
    const view = render(
        <PreviewFindBar rootRef={rootRef} onClose={vi.fn()} focusSignal={focusSignal} />,
    );
    return { ...view, root, rootRef };
}

const queryBox = () => screen.getByLabelText("Find in document");

describe("PreviewFindBar focus", () => {
    it("focuses the query box on mount", () => {
        mount(0);
        expect(document.activeElement).toBe(queryBox());
    });

    // Mounting with an already-bumped signal is the real reader-mode path: App
    // sets open and bumps in the same commit, so the bar's very first render
    // already carries the new value and there is no earlier one to compare to.
    it("focuses on mount even when the signal was bumped before it existed", () => {
        mount(7);
        expect(document.activeElement).toBe(queryBox());
    });

    // The case the signal exists for: the bar is already open, focus has moved
    // away, and a repeat Mod+F has to bring it back.
    it("refocuses and selects when the signal changes on an open bar", () => {
        const { rerender, rootRef } = mount(1);
        const input = queryBox() as HTMLInputElement;
        input.value = "alpha";

        const outside = document.createElement("button");
        document.body.appendChild(outside);
        outside.focus();
        expect(document.activeElement).toBe(outside);

        rerender(<PreviewFindBar rootRef={rootRef} onClose={vi.fn()} focusSignal={2} />);
        expect(document.activeElement).toBe(input);
        outside.remove();
    });

    it("leaves focus alone when the signal does not change", () => {
        const { rerender, rootRef } = mount(1);
        const outside = document.createElement("button");
        document.body.appendChild(outside);
        outside.focus();

        rerender(<PreviewFindBar rootRef={rootRef} onClose={vi.fn()} focusSignal={1} />);
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });
});
