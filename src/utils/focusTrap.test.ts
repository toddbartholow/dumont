import { describe, it, expect, afterEach } from "vitest";
import { attachFocusTrap } from "./focusTrap";

let detach: (() => void) | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
    detach?.();
    container?.remove();
    detach = container = undefined;
});

const mount = (html: string) => {
    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    detach = attachFocusTrap(container);
    return container;
};

/** Tab, as the trap sees it. Returns whether the trap took the key. */
const pressTab = (from: Element, shift = false) => {
    const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
    from.dispatchEvent(e);
    return e.defaultPrevented;
};

describe("attachFocusTrap", () => {
    it("wraps Tab from the last tabbable element back to the first", () => {
        const c = mount(`<button id="a">A</button><button id="b">B</button>`);
        const [a, b] = [c.querySelector<HTMLElement>("#a")!, c.querySelector<HTMLElement>("#b")!];

        b.focus();
        expect(pressTab(b)).toBe(true);
        expect(document.activeElement).toBe(a);

        a.focus();
        expect(pressTab(a, true)).toBe(true);
        expect(document.activeElement).toBe(b);
    });

    // A tabindex="-1" button is focusable by script and by assistive technology,
    // but NOT by Tab. It still matched `button:not([disabled])`, so the trap took
    // an element Tab can never reach as its `last`, never saw Tab arrive there,
    // declined to wrap, and let focus walk straight out of the dialog. That is the
    // shape of the command palette: a search input followed by option rows that the
    // pointer and AT can reach and Tab must not.
    it("ignores elements Tab cannot reach, so focus cannot escape past them", () => {
        const c = mount(`
            <input id="q" />
            <button id="r1" tabindex="-1">Row 1</button>
            <button id="r2" tabindex="-1">Row 2</button>
        `);
        const input = c.querySelector<HTMLElement>("#q")!;

        input.focus();
        // The input is the only tabbable thing in here, so it is both first and
        // last: Tab has to wrap to itself rather than escape.
        expect(pressTab(input)).toBe(true);
        expect(document.activeElement).toBe(input);
    });

    it("returns focus to whatever had it before the trap engaged", () => {
        const trigger = document.createElement("button");
        document.body.appendChild(trigger);
        trigger.focus();

        const c = mount(`<button id="a">A</button>`);
        c.querySelector<HTMLElement>("#a")!.focus();
        expect(document.activeElement).not.toBe(trigger);

        detach?.();
        detach = undefined;
        expect(document.activeElement).toBe(trigger);
        trigger.remove();
    });
});
