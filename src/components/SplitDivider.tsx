import { useCallback, useEffect, useRef } from "react";

interface SplitDividerProps {
    onDrag: (ratio: number) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
}

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

/**
 * The container's CONTENT box, in viewport coordinates.
 *
 * The split ratio must be measured against this and not against
 * `getBoundingClientRect()`, which is the BORDER box and therefore includes
 * padding. The two are the same rectangle right up until the container has any,
 * and this container has plenty: it reserves `padding-left` for whichever left
 * sidebar panel is open and `padding-right` for the AI panel. The panes size
 * themselves with `flexBasis: <ratio>%`, and a percentage basis resolves against
 * the content box, so measuring the pointer against the border box mixes two
 * different coordinate systems.
 *
 * A right pad alone only scales the answer, which is wrong but stays monotonic. A
 * LEFT pad also shifts the origin, so the divider can never sit under the cursor:
 * grab it dead centre with a 288px panel open and it jumps ~100px away on the
 * first pixel of movement, and the arrow keys drive it the wrong way.
 *
 * `getComputedStyle` reports the USED value here, so the `min(288px, 90vw)` in the
 * style prop arrives already resolved to pixels.
 */
function contentBox(c: HTMLElement): { left: number; width: number } {
    const rect = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    return { left: rect.left + padLeft, width: rect.width - padLeft - padRight };
}

export function SplitDivider({ onDrag, containerRef }: SplitDividerProps) {
    const draggingRef = useRef(false);

    const computeRatio = useCallback((clientX: number) => {
        const c = containerRef.current;
        if (!c) return 0.5;
        const { left, width } = contentBox(c);
        if (width <= 0) return 0.5;
        const r = (clientX - left) / width;
        return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
    }, [containerRef]);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        draggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        onDrag(computeRatio(e.clientX));
    }, [computeRatio, onDrag]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        draggingRef.current = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    }, []);

    // Keyboard accessibility: arrow keys nudge the divider.
    //
    // The base ratio is read back off the live layout, so it has to divide by the
    // CONTENT width for the same reason computeRatio does. Dividing the left pane by
    // the border-box width understates the ratio whenever a panel is open, and it
    // understates it by enough to invert the control: with a left panel open,
    // ArrowRight computed a "current + 0.02" that was still smaller than the ratio
    // actually on screen, so pressing right made the editor NARROWER, and both arrows
    // walked it down to the minimum.
    const nudge = useCallback((delta: number) => {
        const c = containerRef.current;
        if (!c) return;
        const { width } = contentBox(c);
        if (width <= 0) return;
        const current = (c.querySelector("[data-split-left]") as HTMLElement)
            ?.getBoundingClientRect().width ?? 0;
        const r = current / width + delta;
        onDrag(Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)));
    }, [containerRef, onDrag]);

    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudge(-0.02);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            nudge(0.02);
        }
    }, [nudge]);

    useEffect(() => {
        return () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, []);

    return (
        <div
            role="separator"
            aria-label="Resize editor and preview panes"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={onKeyDown}
            className="w-1 shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] active:bg-[var(--accent)] cursor-col-resize transition-colors relative group"
        >
            <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-[var(--accent)]/10" />
        </div>
    );
}
