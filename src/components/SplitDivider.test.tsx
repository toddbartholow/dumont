import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { SplitDivider } from "./SplitDivider";

afterEach(cleanup);

beforeAll(() => {
    // jsdom has no pointer capture, and SplitDivider calls both on down/up.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
});

const WIDTH = 1000;
const PANEL = 288; // the left sidebar panels are w-72

/**
 * A split container laid out like the real one: a border box `WIDTH` wide, with
 * `padLeft` reserved for whichever left panel is open and `padRight` for the AI
 * panel. The left pane fills `ratio` of the CONTENT box, which is what a
 * `flexBasis: <ratio>%` actually does.
 */
function makeContainer(ratio: number, padLeft: number, padRight: number) {
    const container = document.createElement("div");
    container.style.paddingLeft = `${padLeft}px`;
    container.style.paddingRight = `${padRight}px`;
    const contentWidth = WIDTH - padLeft - padRight;

    const leftPane = document.createElement("div");
    leftPane.setAttribute("data-split-left", "");
    leftPane.getBoundingClientRect = () =>
        ({ width: contentWidth * ratio, left: padLeft }) as DOMRect;
    container.appendChild(leftPane);

    container.getBoundingClientRect = () =>
        ({ left: 0, width: WIDTH, right: WIDTH }) as DOMRect;

    document.body.appendChild(container);
    const ref = createRef<HTMLDivElement>();
    (ref as { current: HTMLDivElement }).current = container;

    // Where the divider actually sits on screen, in viewport coords.
    const dividerX = padLeft + contentWidth * ratio;
    return { ref, dividerX };
}

const drag = (clientX: number) => {
    const d = screen.getByRole("separator");
    fireEvent.pointerDown(d, { pointerId: 1, clientX });
    fireEvent.pointerMove(d, { pointerId: 1, clientX });
};

describe("SplitDivider", () => {
    it("maps the pointer to the ratio when there is no padding", () => {
        const onDrag = vi.fn();
        const { ref } = makeContainer(0.5, 0, 0);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        drag(600);

        expect(onDrag).toHaveBeenLastCalledWith(0.6);
    });

    /**
     * THE test. `getBoundingClientRect()` is the BORDER box and includes padding;
     * a pane's `flexBasis: N%` resolves against the CONTENT box and does not. With
     * a left panel open the two differ by 288px, and a left pad shifts the ORIGIN
     * rather than merely scaling, so the divider can never sit under the cursor:
     * grab it where it is drawn and it leaps away on the first pixel of movement.
     */
    it("grabbing the divider where it is drawn does not move it, with a left panel open", () => {
        const onDrag = vi.fn();
        const { ref, dividerX } = makeContainer(0.5, PANEL, 0);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        drag(dividerX);

        // Measuring against the border box would report 644/1000 = 0.644 here, and
        // the divider would jump ~100px out from under the pointer.
        expect(onDrag).toHaveBeenLastCalledWith(0.5);
    });

    it("accounts for the AI panel's padding on the right too", () => {
        const onDrag = vi.fn();
        const { ref, dividerX } = makeContainer(0.5, 0, 400);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        drag(dividerX);

        expect(onDrag).toHaveBeenLastCalledWith(0.5);
    });

    it("accounts for both panels being open at once", () => {
        const onDrag = vi.fn();
        const { ref, dividerX } = makeContainer(0.35, PANEL, 400);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        drag(dividerX);

        expect(onDrag).toHaveBeenLastCalledWith(expect.closeTo(0.35, 5));
    });

    /**
     * The arrow keys read the ratio back off the live layout, so they had the same
     * border-box error, and it INVERTED the control: with a left panel open the base
     * ratio read low enough that "current + 0.02" was still under the ratio actually
     * on screen, so ArrowRight made the editor narrower and both arrows walked it
     * down to the 20% floor.
     */
    it("ArrowRight widens the editor with a left panel open, rather than shrinking it", () => {
        const onDrag = vi.fn();
        const { ref } = makeContainer(0.5, PANEL, 0);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });

        const next = onDrag.mock.lastCall![0] as number;
        expect(next).toBeGreaterThan(0.5); // it must not go the wrong way
        expect(next).toBeCloseTo(0.52, 5);
    });

    it("ArrowLeft narrows the editor with a left panel open", () => {
        const onDrag = vi.fn();
        const { ref } = makeContainer(0.5, PANEL, 0);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });

        expect(onDrag.mock.lastCall![0]).toBeCloseTo(0.48, 5);
    });

    it("clamps to the 20/80 bounds", () => {
        const onDrag = vi.fn();
        const { ref } = makeContainer(0.5, PANEL, 0);
        render(<SplitDivider onDrag={onDrag} containerRef={ref} />);

        drag(0);
        expect(onDrag).toHaveBeenLastCalledWith(0.2);

        drag(WIDTH);
        expect(onDrag).toHaveBeenLastCalledWith(0.8);
    });
});
