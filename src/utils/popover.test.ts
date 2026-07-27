import { describe, it, expect, afterEach } from "vitest";
import { clippingBounds } from "./popover";

const WINDOW_HEIGHT = 900;

afterEach(() => {
    document.body.innerHTML = "";
});

/** jsdom gives every element a zero rect, so each test states the one it means. */
function withRect(el: HTMLElement, top: number, bottom: number) {
    el.getBoundingClientRect = () =>
        ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

function mount(html: string) {
    document.body.innerHTML = html;
    window.innerHeight = WINDOW_HEIGHT;
}

describe("clippingBounds", () => {
    it("falls back to the viewport when nothing up the chain clips", () => {
        // The gear panel: it hangs off the titlebar with no scrolling ancestor.
        mount(`<div id="panel"><button id="trigger"></button></div>`);

        expect(clippingBounds(document.getElementById("trigger")!)).toEqual({
            top: 0,
            bottom: WINDOW_HEIGHT,
        });
    });

    it("stops at a scrolling ancestor rather than believing the window", () => {
        // The settings modal: a 600px dialog centered in a 900px window puts the
        // bottom of its scrolling pane at 750, not 900. Measuring against the
        // window is how the reader-width list came to open downward into a wall.
        mount(`<div id="pane" style="overflow-y: auto"><button id="trigger"></button></div>`);
        withRect(document.getElementById("pane")!, 150, 750);

        expect(clippingBounds(document.getElementById("trigger")!)).toEqual({
            top: 150,
            bottom: 750,
        });
    });

    // Under jsdom only. A browser expands `overflow` to both axes, so overflowY
    // would have caught this one; jsdom does not, which is the whole reason the
    // shorthand is read at all. See the note in popover.ts.
    it("reads the overflow shorthand, which is what jsdom leaves on the element", () => {
        mount(`<div id="pane" style="overflow: hidden"><button id="trigger"></button></div>`);
        withRect(document.getElementById("pane")!, 100, 400);

        expect(clippingBounds(document.getElementById("trigger")!).bottom).toBe(400);
    });

    it("takes the tighter edge when the nearest clipper is the tighter one", () => {
        // The modal as it is built: an overflow-hidden shell around an
        // overflow-y-auto pane, and the pane is what cuts the list off.
        mount(`
            <div id="shell" style="overflow: hidden">
                <div id="pane" style="overflow-y: auto"><button id="trigger"></button></div>
            </div>
        `);
        withRect(document.getElementById("shell")!, 150, 750);
        withRect(document.getElementById("pane")!, 199, 700);

        expect(clippingBounds(document.getElementById("trigger")!)).toEqual({
            top: 199,
            bottom: 700,
        });
    });

    /**
     * The case that made this an intersection rather than a first-match.
     *
     * A nested scroller can hang below its parent's visible bottom, so the
     * NEAREST clipper reports the more generous edge and the one that actually
     * cuts the popup off is further up. Stopping at the first ancestor answers
     * 700 here and opens a list into a wall at 500.
     */
    it("keeps walking past a clipper that is looser than one above it", () => {
        mount(`
            <div id="shell" style="overflow: hidden">
                <div id="inner" style="overflow-y: auto"><button id="trigger"></button></div>
            </div>
        `);
        withRect(document.getElementById("shell")!, 150, 500);
        withRect(document.getElementById("inner")!, 199, 700);

        expect(clippingBounds(document.getElementById("trigger")!)).toEqual({
            top: 199,
            bottom: 500,
        });
    });

    it("never reports room outside the window", () => {
        // A pane taller than the viewport still cannot show a list below the fold.
        mount(`<div id="pane" style="overflow-y: auto"><button id="trigger"></button></div>`);
        withRect(document.getElementById("pane")!, -200, 1400);

        expect(clippingBounds(document.getElementById("trigger")!)).toEqual({
            top: 0,
            bottom: WINDOW_HEIGHT,
        });
    });
});
