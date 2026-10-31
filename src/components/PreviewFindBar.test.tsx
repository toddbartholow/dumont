import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
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

// Match case and Regex, which this bar lacked while the editor's had both, so
// Find behaved differently depending on which view you were in.
describe("PreviewFindBar options", () => {
    afterEach(() => vi.useRealTimers());

    function setup(text: string) {
        vi.useFakeTimers();
        const root = document.createElement("div");
        root.innerHTML = text;
        document.body.appendChild(root);
        const rootRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
        rootRef.current = root;
        render(<PreviewFindBar rootRef={rootRef} onClose={vi.fn()} focusSignal={0} />);
        return root;
    }

    const type = (value: string) => {
        fireEvent.change(queryBox(), { target: { value } });
        act(() => { vi.advanceTimersByTime(200); });
    };
    const label = () => screen.getByRole("search").textContent ?? "";

    it("ignores case by default and honours Match case when pressed", () => {
        setup("<p>Alpha alpha ALPHA</p>");
        type("alpha");
        expect(label()).toContain("1 of 3");

        fireEvent.click(screen.getByRole("button", { name: "Match case" }));
        act(() => { vi.advanceTimersByTime(200); });
        expect(screen.getByRole("button", { name: "Match case" }).getAttribute("aria-pressed")).toBe("true");
        expect(label()).toContain("1 of 1");
    });

    it("treats the query as a pattern when Regex is pressed", () => {
        setup("<p>a1 b22 <strong>c3</strong></p>");
        type("\\d+");
        expect(label()).toContain("No results");

        fireEvent.click(screen.getByRole("button", { name: "Regex" }));
        act(() => { vi.advanceTimersByTime(200); });
        // One hit per run of digits, including the one inside <strong> and the
        // one that ends its text node (the matchLength end-of-text case).
        expect(label()).toContain("1 of 3");
    });

    it("says Invalid pattern for a regex that does not compile", () => {
        setup("<p>alpha</p>");
        fireEvent.click(screen.getByRole("button", { name: "Regex" }));
        type("(");
        expect(label()).toContain("Invalid pattern");
    });
});

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
