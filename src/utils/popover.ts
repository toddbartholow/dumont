/**
 * Where an absolutely positioned popup is actually allowed to be.
 *
 * A listbox that opens downward has to know whether there is room below its
 * trigger. The obvious test is against `window.innerHeight`, and it is wrong
 * whenever the control sits inside a scroll container: an absolutely positioned
 * child is clipped by the nearest ancestor whose overflow is not `visible`, and
 * that ancestor's bottom edge can be far above the bottom of the window.
 *
 * The settings modal is exactly that case. It is 600px tall and centered, so in
 * a 900px window its scrolling pane ends at y=750 while `innerHeight` says 900.
 * A trigger at y=600 measured against the window believes it has 300px of room,
 * opens downward, and has its list cut off by the pane it lives in. The reader
 * width control at the foot of the Appearance pane was the one that hit it.
 *
 * Falls back to the viewport when nothing up the chain clips, which is the case
 * for the gear panel: it hangs off the titlebar with no scrolling ancestor.
 */
export interface ClipBounds {
    readonly top: number;
    readonly bottom: number;
}

/**
 * True when a computed overflow value establishes a clipping box.
 *
 * The empty-string case is not padding. jsdom leaves the property it was not
 * given as `""`, and a detached element reads `""` for everything, so without
 * this guard every element in a test would look like a clipping ancestor.
 */
function clips(value: string): boolean {
    return value !== "visible" && value !== "";
}

/**
 * The top and bottom of the box that will clip a popup anchored at `el`, in
 * viewport coordinates.
 *
 * INTERSECTS every clipping ancestor rather than stopping at the first. The
 * nearest clipper is not always the tightest: a scroll container whose own box
 * hangs below its parent's visible bottom reports an optimistic edge, and the
 * thing that actually cuts the popup off is further up. Returning early gets
 * that case wrong, and this pane already has the geometry for it (the theme
 * grid is a scroller inside the settings pane), so the only reason it does not
 * bite today is that no combobox sits inside a nested scroller.
 *
 * Clamped to the viewport at both ends: a container taller than the window
 * still cannot show a popup below the fold.
 *
 * Scoped to a popup that is absolutely positioned inside its anchor's own
 * positioned parent, which is how both callers build theirs. CSS only lets an
 * overflow box clip an absolutely positioned element when it is an ancestor of
 * that element's CONTAINING BLOCK, so a caller whose containing block sits
 * higher up (or who uses `position: fixed`, which escapes untransformed
 * clippers entirely) would get an answer that is too pessimistic.
 */
export function clippingBounds(el: Element): ClipBounds {
    const viewport = typeof window === "undefined" ? 0 : window.innerHeight;
    let top = 0;
    let bottom = viewport;

    for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        // The shorthand read is for jsdom, NOT for a browser. A browser will not
        // let one axis compute to `visible` while the other clips (it forces the
        // `visible` one to `auto`), so `overflow: hidden` already reads as
        // `hidden` on overflowY there, and `clip` is a legal overflowY value the
        // first check catches. jsdom does not expand the shorthand, so under test
        // `overflow: hidden` reads as overflowY `visible` and would slip past.
        if (clips(style.overflowY) || clips(style.overflow)) {
            const rect = node.getBoundingClientRect();
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
        }
    }

    return { top, bottom };
}
