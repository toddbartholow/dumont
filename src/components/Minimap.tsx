import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView } from "@codemirror/view";
import { useTheme } from "../context/ThemeContext";

/** Width of the minimap column, px. Mirrored by the width the editor container
 *  reserves in CodeEditor.tsx — keep the two in step. */
export const MINIMAP_WIDTH = 80;

const PAD_X = 4;
/** Columns that fit across the overview. Text past this is clipped rather than
 *  squeezed, so the character width stays constant and indentation still reads. */
const MAX_LINE_CHARS = 110;
/** Height of one visual row in the overview, px — VS Code's minimap at
 *  `scale: 1`. See minimapScale(). */
const MINIMAP_ROW_H = 2;
/** Ceiling on the canvas we paint the whole document into, px. Only documents
 *  past ~6000 visual rows get compressed below MINIMAP_ROW_H to fit it. */
const MAX_MAP_H = 12000;
/** Floor for the slider, so it stays grabbable on a very long document. */
const MIN_SLIDER_H = 8;
/** Never paint a run thinner than this, so a one-character word is still visible. */
const MIN_RUN_W = 1;
/** Never paint a row shorter than this. */
const MIN_BAR_H = 1;
/** Upper bound on geometry lookups per repaint — see the sampling note in draw(). */
const MAX_SAMPLED_LINES = 4000;
/** A tab occupies this many columns when measuring indentation. */
const TAB_COLUMNS = 4;

interface MinimapProps {
    view: EditorView;
    /** The current document. Not read directly — it's the redraw signal, since
     *  the canvas has to repaint whenever the text changes. */
    content: string;
    /** Whether the editor wraps long lines. Decides how many rows a line occupies
     *  in the overview, so the map has to be repainted when it changes. */
    wordWrap: boolean;
}

type Kind = "heading" | "code" | "quote" | "list" | "text";

/** Classify a line from its markdown prefix. A regex, not a Lezer walk: the
 *  minimap only needs a color per line, and this runs over the whole document
 *  on every redraw. */
function classify(text: string): Kind {
    const t = text.trimStart();
    if (t === "") return "text";
    if (t.startsWith("#")) return "heading";
    if (t.startsWith("```") || t.startsWith("~~~") || /^ {4,}\S/.test(text)) return "code";
    if (t.startsWith(">")) return "quote";
    if (/^([-*+]|\d+[.)])\s/.test(t)) return "list";
    return "text";
}

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

/**
 * A VS Code-style document overview down the editor's right margin.
 *
 * Deliberately NOT a CodeMirror extension — it only needs to read the view's
 * geometry, and staying outside CM's internals keeps it clear of the height
 * map, the merge view's compartment, and the facet system. It's a canvas plus a
 * viewport indicator, positioned by the editor's own layout.
 *
 * Two things it must never do:
 *  - count logical lines. Word wrap is ON by default and this is a prose
 *    editor, so one markdown paragraph is routinely one logical line and twenty
 *    visual rows. All geometry comes from view.lineBlockAt() / contentHeight,
 *    which are wrap-aware.
 *  - cache its colors across a theme switch. Themes here flip a `data-theme`
 *    attribute on <html> rather than touching the editor's DOM, so the redraw
 *    is keyed off the theme from context.
 */
export function Minimap({ view, content, wordWrap }: MinimapProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [indicator, setIndicator] = useState({ top: 0, height: 0 });
    /** How far the map is slid within the column. Applied as a transform, so
     *  scrolling never touches the canvas. */
    const [offset, setOffset] = useState(0);
    /** Height of the whole map, px — the canvas is this tall, not the column. */
    const [mapHeight, setMapHeight] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [hovering, setHovering] = useState(false);
    // Identity, not value: CodeMirror dedupes measure requests carrying the same
    // key, so a burst of edits collapses into one repaint per cycle.
    const measureKeyRef = useRef({});
    /** The map's own height, read by the scroll handler without re-subscribing. */
    const mapHeightRef = useRef(0);

    // Theme changes the colors the canvas is painted with; font and size change
    // the editor's character width, which changes where lines wrap and therefore
    // how many rows each occupies.
    const { theme, font, fontSize } = useTheme();

    /** Columns across the editor — how many characters fit before it wraps.
     *  Depends only on the font and the pane width, never on scrolling. */
    const columnsPerRow = useCallback((): number => {
        if (!wordWrap) return Infinity;
        const charW = view.defaultCharacterWidth || 8;
        const contentW = view.contentDOM.clientWidth || view.scrollDOM.clientWidth;
        if (!contentW || !charW) return Infinity;
        return Math.max(20, Math.floor(contentW / charW));
    }, [view, wordWrap]);

    /** Move the map and its slider. Runs on every scroll frame and does NOT
     *  repaint: the canvas holds the whole document, so scrolling only translates
     *  it. Driven by the scroll FRACTION, so CodeMirror revising its height
     *  estimates can nudge the slide but can never re-lay-out the map. */
    const syncIndicator = useCallback(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const scroller = view.scrollDOM;
        const columnH = wrap.clientHeight;
        const scrollH = scroller.scrollHeight;
        const viewportH = scroller.clientHeight;
        // Hidden (reader mode) or not laid out yet — nothing to divide by.
        if (!columnH || !viewportH || !scrollH) return;

        const mapH = mapHeightRef.current;
        if (!mapH) return;

        const maxScroll = Math.max(1, scrollH - viewportH);
        const scrollFraction = scroller.scrollTop / maxScroll;
        const visibleFraction = viewportH / scrollH;

        setIndicator(sliderRect(mapH, columnH, scrollFraction, visibleFraction));
        setOffset(mapOffset(mapH, columnH, scrollFraction));
    }, [view]);

    /** Repaint the document overview — the WHOLE document, onto a canvas as tall
     *  as the map needs to be. Scrolling only slides it. */
    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return;

        const cssW = MINIMAP_WIDTH - PAD_X * 2;
        const columnH = wrap.clientHeight;
        // display:none (reader mode) or nothing laid out yet: bail before dividing.
        if (!columnH) return;

        const doc = view.state.doc;
        const cols = columnsPerRow();

        // Lay the map out ourselves, from the text. Deliberately NOT from
        // view.lineBlockAt(): those positions and heights are CodeMirror's
        // ESTIMATES for lines it has not rendered, revised as they scroll into
        // view — so taking the layout from them meant the map re-laid itself out
        // under the slider as you scrolled, bars moving and their words
        // redistributing. This model depends only on the text and the character
        // width, and so holds perfectly still.
        const step = Math.max(1, Math.ceil(doc.lines / MAX_SAMPLED_LINES));
        const rows: { row: number; span: number; text: string; kind: Kind }[] = [];
        let totalRows = 0;
        for (let n = 1; n <= doc.lines; n += step) {
            const line = doc.line(n);
            const span = rowsForLine(line.length, cols);
            if (line.length > 0) {
                rows.push({ row: totalRows, span, text: line.text, kind: classify(line.text) });
            }
            totalRows += span;
        }
        if (!totalRows) return;

        const rowH = rowHeight(totalRows);
        const cssH = Math.max(1, Math.ceil(totalRows * rowH));
        setMapHeight(cssH);
        mapHeightRef.current = cssH;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const css = getComputedStyle(document.documentElement);
        const colors: Record<Kind, string> = {
            heading: css.getPropertyValue("--syntax-h1").trim() || "#888",
            code: css.getPropertyValue("--syntax-code").trim() || "#888",
            quote: css.getPropertyValue("--syntax-quote").trim() || "#888",
            list: css.getPropertyValue("--syntax-list").trim() || "#888",
            // NOT --text-secondary. That token is bound by a contrast floor (it
            // labels real UI), and raising it for AA made the overview brighter
            // than the document it summarizes. The minimap is decorative and
            // aria-hidden, so no contrast rule applies to it — it should read as
            // a faint shadow of the text, never compete with it.
            text: css.getPropertyValue("--text-muted").trim() || "#888",
        };

        // Fixed column width, so a word always lands at its real indent — the
        // overview reads like text rather than like a bar chart of line lengths.
        const colW = cssW / MAX_LINE_CHARS;
        const barH = Math.max(MIN_BAR_H, rowH);

        for (const { row, span, text, kind } of rows) {
            // Solid bars carry far more ink than the thin antialiased glyphs they
            // stand for, so at full strength the overview reads BRIGHTER than the
            // document. Held well back: prose recedes, structure stays picked out.
            ctx.globalAlpha = kind === "text" ? 0.42 : 0.6;
            ctx.fillStyle = colors[kind];

            // A wrapped paragraph is ONE logical line across many rows. Paint each
            // row, or it smears into a single tall block and the texture is lost.
            const perRow = Math.ceil(text.length / span);
            for (let r = 0; r < span; r++) {
                const slice = span === 1 ? text : text.slice(r * perRow, (r + 1) * perRow);
                if (!slice) continue;
                const y = (row + r) * rowH;

                for (const run of wordRuns(slice, MAX_LINE_CHARS)) {
                    const x = run.start * colW;
                    const w = Math.max(MIN_RUN_W, (run.end - run.start) * colW);
                    ctx.fillRect(x, y, w, barH);
                }
            }
        }
        ctx.globalAlpha = 1;
    }, [view, columnsPerRow]);

    /**
     * Queue a repaint through CodeMirror's own measure cycle rather than a bare
     * requestAnimationFrame.
     *
     * Two reasons, both bugs we'd otherwise own. CodeMirror re-measures its
     * height map in a frame it schedules itself, and React runs child effects
     * before parent ones — so a raw rAF booked here fires BEFORE the editor has
     * re-measured after a font or size change, and the canvas would be scaled
     * from a stale contentHeight until the next keystroke. A `read` handler is
     * run inside CM's measure pass, after the layout it depends on is settled.
     *
     * It also removes the frame-handle bookkeeping (a cancelled handle left
     * behind would have latched the "already scheduled" guard on forever, and
     * StrictMode's mount→cleanup→remount does exactly that). `key` dedupes
     * repeated requests within a cycle, so a burst of keystrokes still paints
     * once, and CM drops the request outright if the view is destroyed first.
     */
    const scheduleDraw = useCallback(() => {
        view.requestMeasure({
            key: measureKeyRef.current,
            read: () => {
                draw();
                syncIndicator();
            },
        });
    }, [view, draw, syncIndicator]);

    // Scrolling NEVER repaints — it only slides the canvas and moves the slider.
    // That is the whole point of laying the map out from the text rather than from
    // CodeMirror's height map: there is nothing left for a scroll to invalidate.
    // Resizing does repaint, because the pane width decides where lines wrap.
    useEffect(() => {
        const scroller = view.scrollDOM;
        const onScroll = () => syncIndicator();
        scroller.addEventListener("scroll", onScroll, { passive: true });

        const ro = new ResizeObserver(scheduleDraw);
        ro.observe(scroller);
        if (wrapRef.current) ro.observe(wrapRef.current);

        scheduleDraw();
        return () => {
            scroller.removeEventListener("scroll", onScroll);
            ro.disconnect();
        };
    }, [view, scheduleDraw, syncIndicator]);

    // Repaint when the text changes, when the theme changes the colors, and when
    // the font, size or wrap mode changes where lines break.
    useEffect(() => {
        scheduleDraw();
    }, [content, theme, font, fontSize, wordWrap, scheduleDraw]);

    /** Scroll the document so the clicked point sits mid-viewport. Inverts exactly
     *  the same slide offset the canvas is drawn with, or a click would land
     *  wherever the map happened to be slid to. */
    const scrollToY = useCallback((clientY: number) => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const scroller = view.scrollDOM;
        const mapH = mapHeightRef.current;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (!mapH || !maxScroll) return;

        const slid = mapOffset(mapH, rect.height, scroller.scrollTop / maxScroll);
        // Where in the map you clicked, as a fraction of the document.
        const fraction = Math.min(1, Math.max(0, (clientY - rect.top + slid) / mapH));
        const target = fraction * scroller.scrollHeight - scroller.clientHeight / 2;
        scroller.scrollTop = Math.max(0, Math.min(maxScroll, target));
    }, [view]);

    // Pointer events cover mouse, trackpad and touch in one path. Capture means
    // a drag that leaves the minimap keeps scrolling until release.
    const onPointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setDragging(true);
        scrollToY(e.clientY);
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (dragging) scrollToY(e.clientY);
    };
    const endDrag = (e: React.PointerEvent) => {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        setDragging(false);
    };

    // Forward the wheel to the document, so the strip doesn't feel like a dead zone.
    const onWheel = (e: React.WheelEvent) => {
        view.scrollDOM.scrollTop += e.deltaY;
    };

    // VS Code's slider: a flat translucent band across the overview, square, no
    // border. It only reads as a "box" if its height is wrong — with the row
    // height capped it now frames exactly the lines on screen. Alphas are VS
    // Code's own: subtle at rest, brighter on hover, brightest while dragged.
    const sliderAlpha = dragging ? 30 : hovering ? 20 : 10;

    return (
        <div
            ref={wrapRef}
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerEnter={() => setHovering(true)}
            onPointerLeave={() => setHovering(false)}
            onWheel={onWheel}
            style={{ width: MINIMAP_WIDTH }}
            className="absolute inset-y-0 right-0 z-10 cursor-pointer select-none overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-gutter)]"
        >
            {/* The canvas holds the WHOLE document and is taller than the column
                when the map is at full density; the column clips it and this
                transform slides it. Scrolling therefore never repaints and never
                rescales — it only moves. */}
            <canvas
                ref={canvasRef}
                className="absolute top-0 will-change-transform"
                style={{
                    left: PAD_X,
                    height: mapHeight || undefined,
                    transform: `translateY(${-offset}px)`,
                }}
            />
            <div
                className="absolute left-0 right-0 pointer-events-none transition-[background-color] duration-100"
                style={{
                    top: indicator.top,
                    height: indicator.height,
                    backgroundColor: `color-mix(in srgb, var(--text-primary) ${sliderAlpha}%, transparent)`,
                }}
            />
        </div>
    );
}
