// The minimap's layout arithmetic, kept apart from the canvas component so it can
// be tested on its own. See components/Minimap.tsx for how it is drawn.

/** Height of one visual row in the overview, px — VS Code's minimap at
 *  `scale: 1`. See minimapScale(). */
const MINIMAP_ROW_H = 2;
/** Ceiling on the canvas we paint the whole document into, px. Only documents
 *  past ~6000 visual rows get compressed below MINIMAP_ROW_H to fit it. */
const MAX_MAP_H = 12000;
/** Floor for the slider, so it stays grabbable on a very long document. */
const MIN_SLIDER_H = 8;
/** A tab occupies this many columns when measuring indentation. */
const TAB_COLUMNS = 4;

/**
 * How many rows a line occupies in the overview.
 *
 * This is the crux. The map used to take every line's position and height from
 * CodeMirror — `lineBlockAt().top` and `.height` — which are ESTIMATES for lines
 * it has not rendered, revised as they scroll into view. So the map re-laid
 * itself out under the slider as you scrolled: bars moved, changed height, and
 * the words inside them redistributed. Nothing the overview draws may depend on
 * CodeMirror's measurement state.
 *
 * So model the wrap here instead, from the text and a column count that only
 * changes when the font or the pane width does. It is an approximation of where
 * CodeMirror actually breaks the line — but it is a STABLE one, and stability is
 * what a document overview is for. Nobody reads a minimap for its exact wrap
 * points; they read it for the shape of the document, and the shape must hold
 * still.
 */
export function rowsForLine(length: number, cols: number): number {
    if (!Number.isFinite(cols) || cols <= 0) return 1;   // wrap off: one row
    return Math.max(1, Math.ceil(length / cols));
}

/** Height of one overview row, px. A fixed 2px — VS Code's `minimap.scale: 1` —
 *  compressed only when a document is too tall for a sane canvas. */
export function rowHeight(totalRows: number): number {
    if (!totalRows) return 0;
    return Math.min(MINIMAP_ROW_H, MAX_MAP_H / totalRows);
}

/**
 * How far the map is slid within its column, px.
 *
 * At full density the map is usually TALLER than the column, so — like VS Code —
 * it slides: the top of the document shows the top of the map, the end shows the
 * end, proportionally in between. A map that already fits never moves.
 *
 * Driven by the scroll FRACTION, not by editor pixels, so CodeMirror revising its
 * height estimates nudges the offset smoothly instead of relaying out the map.
 */
export function mapOffset(mapH: number, columnH: number, scrollFraction: number): number {
    const overflow = mapH - columnH;
    if (overflow <= 0) return 0;
    return overflow * Math.min(1, Math.max(0, scrollFraction));
}

/**
 * Where the viewport slider sits within the COLUMN, px.
 *
 * At fraction 0 it is flush with the top; at fraction 1, flush with the bottom of
 * whichever is shorter, the map or the column. It therefore always frames what
 * the editor is showing, and always reaches the end when the editor does.
 */
export function sliderRect(
    mapH: number,
    columnH: number,
    scrollFraction: number,
    visibleFraction: number,
): { top: number; height: number } {
    // Never taller than the column, and never taller than the map — the slider
    // frames what is on screen, and it has to fit in what it frames.
    const height = Math.min(
        Math.max(MIN_SLIDER_H, Math.min(1, visibleFraction) * mapH),
        Math.min(mapH, columnH),
    );
    const travel = Math.max(0, Math.min(mapH, columnH) - height);
    const offset = mapOffset(mapH, columnH, scrollFraction);
    const top = Math.min(1, Math.max(0, scrollFraction)) * Math.max(0, mapH - height) - offset;
    return { top: Math.min(travel, Math.max(0, top)), height };
}

/** A run of non-whitespace, as a column span: [start, end) in characters. */
export interface Run {
    start: number;
    end: number;
}

/**
 * Split a line into its whitespace-separated runs, in COLUMN space (tabs count
 * as TAB_COLUMNS, not one character).
 *
 * This is what makes the overview legible. Painting one bar per line — the whole
 * line as a single slab whose only information was its length — gave a barcode:
 * no word gaps, no texture, and every line flush to the left edge because the
 * leading whitespace was thrown away. Drawing the runs at their true columns
 * restores both the word shapes and the indentation, which is what the eye
 * actually reads a minimap by.
 */
export function wordRuns(text: string, maxCols: number): Run[] {
    const runs: Run[] = [];
    let col = 0;
    let start = -1;

    for (let i = 0; i < text.length && col < maxCols; i++) {
        const ch = text[i];
        if (ch === " " || ch === "\t") {
            if (start >= 0) {
                runs.push({ start, end: col });
                start = -1;
            }
            col += ch === "\t" ? TAB_COLUMNS - (col % TAB_COLUMNS) : 1;
        } else {
            if (start < 0) start = col;
            col += 1;
        }
    }
    if (start >= 0) runs.push({ start, end: Math.min(col, maxCols) });
    return runs;
}
