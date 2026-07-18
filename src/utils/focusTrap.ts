/**
 * Focus trap helper — when active, Tab/Shift+Tab cycles within the container
 * instead of escaping. Used by sidebar panels and dialogs.
 */

// tabindex="-1" has to be excluded on EVERY branch, not just the bare [tabindex]
// one. A <button tabindex="-1"> is focusable by script but not by Tab, and it
// still matched `button:not([disabled])` — so the trap took an unreachable
// element for its `last`, never saw Tab arrive there, declined to wrap, and let
// focus walk straight out of the dialog. The command palette's option rows are
// exactly that: buttons the pointer and AT can reach and Tab must not.
const NOT_TABBABLE = ':not([tabindex="-1"])';
const FOCUSABLE = [
    `button:not([disabled])${NOT_TABBABLE}`,
    `[href]${NOT_TABBABLE}`,
    `input:not([disabled])${NOT_TABBABLE}`,
    `select:not([disabled])${NOT_TABBABLE}`,
    `textarea:not([disabled])${NOT_TABBABLE}`,
    '[tabindex]:not([tabindex="-1"])',
].join(",");

export function attachFocusTrap(container: HTMLElement | null): () => void {
    if (!container) return () => { };

    // Remember what had focus before the trap engaged so we can return focus
    // there on detach — keyboard/screen-reader users land back on the control
    // that opened the dialog instead of at the top of the document. Call this
    // BEFORE moving focus into the dialog so we capture the trigger, not the
    // dialog's own first field. UX-01.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handler = (e: KeyboardEvent) => {
        if (e.key !== "Tab") return;
        const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };

    container.addEventListener("keydown", handler);
    return () => {
        container.removeEventListener("keydown", handler);
        if (
            previouslyFocused &&
            typeof previouslyFocused.focus === "function" &&
            document.contains(previouslyFocused)
        ) {
            previouslyFocused.focus();
        }
    };
}
