// The minimap is opt-in chrome mounted inside CodeEditor. These cover the wiring
// that a canvas screenshot can't: that it appears only when enabled, that it
// reserves its column out of the editor (rather than overlaying the text), and
// that it disappears again when switched off.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { CodeEditor } from "./CodeEditor";
import { MINIMAP_WIDTH, wordRuns, rowsForLine, rowHeight, sliderRect, mapOffset } from "./Minimap";
import { TestProviders } from "../test/providers";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";

beforeAll(installCodeMirrorDomPolyfills);
afterEach(cleanup);

function mount(minimap: boolean) {
    return render(
        <TestProviders>
            <CodeEditor content={"# Title\n\ntext\n"} onChange={() => { }} minimap={minimap} />
        </TestProviders>,
    );
}

const findMinimap = (c: HTMLElement) => c.querySelector("canvas");

describe("minimap", () => {
    it("is absent unless enabled", async () => {
        const { container } = mount(false);
        await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
        expect(findMinimap(container)).toBeNull();
    });

    it("mounts once the editor view exists when enabled", async () => {
        const { container } = mount(true);
        await waitFor(() => expect(findMinimap(container)).toBeTruthy());
    });

    it("reserves a column instead of overlaying the text", async () => {
        const { container } = mount(true);
        await waitFor(() => expect(findMinimap(container)).toBeTruthy());
        // The CodeMirror host is pulled in from the right edge by exactly the
        // minimap's width; without this the overview would sit on top of the text.
        const host = container.querySelector(".cm-editor")?.parentElement as HTMLElement;
        expect(host.style.right).toBe(`${MINIMAP_WIDTH}px`);
    });

    it("gives the editor the full width when the minimap is off", async () => {
        const { container } = mount(false);
        await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
        const host = container.querySelector(".cm-editor")?.parentElement as HTMLElement;
        expect(host.style.right).toBe("0px");
    });
});

// The overview used to paint one slab per line, whose only information was the
// line's length: no word gaps, and every line flush left because the leading
// whitespace was discarded. These pin the two properties that make it legible.
describe("minimap geometry", () => {
    const COLUMN = 800;   // minimap column height, px
    const COLS = 80;      // characters across the editor before it wraps

    // THE regression, three times over. The map used to take its layout from
    // CodeMirror — contentHeight for the scale, lineBlockAt().top/.height for each
    // bar. Those are ESTIMATES for lines it hasn't rendered, revised as they
    // scroll into view. So the map re-laid itself out under the slider as you
    // scrolled: bars moved, resized, and the words inside them redistributed.
    // NOTHING the map draws may depend on CodeMirror's measurement state — which
    // is why these functions take text and columns, and not a view.
    it("gives a line the same rows no matter what the editor has measured", () => {
        expect(rowsForLine(240, COLS)).toBe(3);
        expect(rowsForLine(240, COLS)).toBe(rowsForLine(240, COLS));   // pure
        expect(rowsForLine(1, COLS)).toBe(1);
        expect(rowsForLine(0, COLS)).toBe(1);                          // blank line
    });

    it("gives every line one row when wrap is off", () => {
        expect(rowsForLine(5000, Infinity)).toBe(1);
    });

    it("keeps a row a fixed 2px until the document outgrows the canvas", () => {
        expect(rowHeight(100)).toBe(2);
        expect(rowHeight(6000)).toBe(2);
        // Only past the canvas ceiling does it compress — and then exactly to fit.
        expect(rowHeight(12000)).toBeLessThan(2);
        expect(12000 * rowHeight(12000)).toBeCloseTo(12000, 5);
        expect(rowHeight(0)).toBe(0);   // empty document: no divide by zero
    });

    it("slides the map so the end of the document shows the end of the map", () => {
        const mapH = 2000;                                  // taller than the column
        expect(mapOffset(mapH, COLUMN, 0)).toBe(0);         // top of doc: top of map
        expect(mapOffset(mapH, COLUMN, 1)).toBe(mapH - COLUMN); // end: end
        expect(mapOffset(mapH, COLUMN, 0.5)).toBeCloseTo((mapH - COLUMN) / 2, 5);
    });

    it("does not slide a map that already fits the column", () => {
        expect(mapOffset(300, COLUMN, 1)).toBe(0);
    });

    it("puts the slider at the very bottom when the editor is scrolled to the end", () => {
        const mapH = 2000;
        const { top, height } = sliderRect(mapH, COLUMN, 1, 600 / 20000);
        expect(top + height).toBeCloseTo(COLUMN, 5);
    });

    it("puts the slider at the very top at the very top", () => {
        expect(sliderRect(2000, COLUMN, 0, 0.3).top).toBe(0);
    });

    it("frames the visible portion of the document", () => {
        // A third of the document on screen -> a third of the map.
        const { height } = sliderRect(600, COLUMN, 0, 1 / 3);
        expect(height).toBeCloseTo(200, 5);
    });

    it("never inverts or leaves the column, at any scroll fraction", () => {
        for (const mapH of [50, 300, 800, 2000, 12000]) {
            for (const f of [-1, 0, 0.001, 0.5, 0.999, 1, 2]) {
                const { top, height } = sliderRect(mapH, COLUMN, f, 0.25);
                expect(top).toBeGreaterThanOrEqual(0);
                expect(height).toBeGreaterThan(0);
                expect(top + height).toBeLessThanOrEqual(COLUMN + 0.001);
                expect(mapOffset(mapH, COLUMN, f)).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

describe("wordRuns", () => {
    it("splits a line into its words, as column spans", () => {
        expect(wordRuns("the cat sat", 110)).toEqual([
            { start: 0, end: 3 },
            { start: 4, end: 7 },
            { start: 8, end: 11 },
        ]);
    });

    it("preserves indentation — a run starts at its real column", () => {
        expect(wordRuns("    indented", 110)).toEqual([{ start: 4, end: 12 }]);
        // Same word, different indent → different x. This is the whole point.
        expect(wordRuns("indented", 110)[0].start).toBe(0);
    });

    it("counts a tab as a tab stop, not one character", () => {
        expect(wordRuns("\tx", 110)).toEqual([{ start: 4, end: 5 }]);
        // A tab advances to the NEXT stop, so it isn't always 4 columns.
        expect(wordRuns("ab\tx", 110)).toEqual([
            { start: 0, end: 2 },
            { start: 4, end: 5 },
        ]);
    });

    it("collapses runs of whitespace and ignores blank lines", () => {
        expect(wordRuns("a     b", 110)).toEqual([
            { start: 0, end: 1 },
            { start: 6, end: 7 },
        ]);
        expect(wordRuns("", 110)).toEqual([]);
        expect(wordRuns("      ", 110)).toEqual([]);
    });

    it("clips at the column limit rather than squeezing", () => {
        const runs = wordRuns("x".repeat(50) + " " + "y".repeat(50), 60);
        expect(runs).toEqual([{ start: 0, end: 50 }, { start: 51, end: 60 }]);
        // Nothing may be painted past the limit, or words would overflow the column.
        for (const r of runs) expect(r.end).toBeLessThanOrEqual(60);
    });
});
