// The palette's rows had the same defect as the settings Selects: hovering a row
// scrolled it "into view", which moved it out from under the press, and since the
// command hung off the row's click — and a click only fires when pointerdown and
// pointerup land on the same element — WebView2 dropped it. macOS never showed
// it, because WKWebView is forgiving about the same sequence.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

afterEach(cleanup);

const COMMANDS: PaletteCommand[] = [
    { id: "open", label: "Open File", section: "File", run: vi.fn() },
    { id: "save", label: "Save File", section: "File", run: vi.fn() },
    { id: "theme", label: "Change Theme", section: "View", run: vi.fn() },
];

const setup = (items = COMMANDS) => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen items={items} onClose={onClose} />);
    return { onClose, rows: () => screen.getAllByRole("option") };
};

describe("CommandPalette", () => {
    it("runs the command released on, even if the press began on another row", () => {
        const run = vi.fn();
        const { rows } = setup([...COMMANDS.slice(0, 2), { id: "x", label: "Export", section: "File", run }]);
        fireEvent.pointerDown(rows()[0]);
        fireEvent.pointerUp(rows()[2]);
        expect(run).toHaveBeenCalled();
    });

    // pointerup fires for every mouse button; click fired for none but the
    // primary. Without the guard, middle-clicking a row ran its command.
    it("runs a command on the primary button only", () => {
        const run = vi.fn();
        const { rows } = setup([...COMMANDS.slice(0, 2), { id: "x", label: "Export", section: "File", run }]);
        for (const button of [1, 2]) {   // middle, secondary
            fireEvent.pointerDown(rows()[2], { button });
            fireEvent.pointerUp(rows()[2], { button });
        }
        expect(run).not.toHaveBeenCalled();
    });

    // A press stamped by a gesture that ended elsewhere reads like a fresh one, so
    // the next release over a row would run a command nobody pressed.
    it("does not run a command from a press that began outside the list", () => {
        const run = vi.fn();
        const { rows } = setup([...COMMANDS.slice(0, 2), { id: "x", label: "Export", section: "File", run }]);
        const input = screen.getByLabelText("Search commands");

        fireEvent.pointerDown(rows()[0]);   // a press on a row...
        fireEvent.pointerUp(input);         // ...abandoned off the list
        expect(run).not.toHaveBeenCalled();

        fireEvent.pointerDown(input);       // the next press starts outside it
        fireEvent.pointerUp(rows()[2]);
        expect(run).not.toHaveBeenCalled();
    });

    it("scrolls the list for the keyboard cursor but never for the pointer", () => {
        const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
        const { rows } = setup();
        scrollIntoView.mockClear();   // the first row scrolls into view on open

        fireEvent.pointerEnter(rows()[2]);
        expect(scrollIntoView).not.toHaveBeenCalled();

        // On the input, which is where the trap puts focus — the palette's keydown
        // handler is on the inner panel, not the overlay that carries role=dialog.
        fireEvent.keyDown(screen.getByLabelText("Search commands"), { key: "ArrowDown" });
        expect(scrollIntoView).toHaveBeenCalled();
        scrollIntoView.mockRestore();
    });

    it("does not run a command when the list scrolled under the press", () => {
        const run = vi.fn();
        const { rows } = setup([...COMMANDS.slice(0, 2), { id: "x", label: "Export", section: "File", run }]);

        // jsdom has no layout, so scrollTop is a constant 0. Fake the scroll.
        let scrollTop = 0;
        Object.defineProperty(screen.getByRole("listbox"), "scrollTop", {
            get: () => scrollTop,
            configurable: true,
        });

        fireEvent.pointerDown(rows()[2], { pointerType: "touch" });
        scrollTop = 40;   // the finger dragged the list
        fireEvent.pointerUp(rows()[2]);
        expect(run).not.toHaveBeenCalled();
    });

    // DOM focus never leaves the search input, so aria-activedescendant is the only
    // thing that can tell a screen reader which row the arrow keys are on. Without
    // it, arrowing the results announced nothing and Enter ran a command the user
    // had never been told about.
    it("points the search box at the row the cursor is on", () => {
        const { rows } = setup();
        const input = screen.getByLabelText("Search commands");
        expect(input).toHaveAttribute("role", "combobox");
        expect(input).toHaveAttribute("aria-activedescendant", rows()[0].id);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input).toHaveAttribute("aria-activedescendant", rows()[1].id);
        expect(rows()[1]).toHaveAttribute("aria-selected", "true");

        // And it controls the list it is describing.
        expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    });

    // A listbox may own only options and groups. The rows sat under <li> wrappers,
    // so they were not the listbox's children at all, and every row computed its
    // position among a wrapper holding exactly one option: "1 of 1", every time.
    it("owns its options directly, through the section groups", () => {
        setup();
        const listbox = screen.getByRole("listbox");
        expect(screen.queryAllByRole("listitem")).toHaveLength(0);

        const groups = within(listbox).getAllByRole("group");
        expect(groups).toHaveLength(2);
        expect(groups[0]).toHaveAccessibleName("File");
        expect(groups[1]).toHaveAccessibleName("View");
        expect(within(groups[0]).getAllByRole("option")).toHaveLength(2);
    });

    // Set position is otherwise computed among same-role siblings under the same
    // accessibility parent, and that parent is the section group. So a row would
    // announce "1 of 2" while the footer said 3 results. The cursor is a flat index
    // over the ranked list, and the count has to agree with it.
    it("counts its options across the whole list, not per section", () => {
        const { rows } = setup();
        expect(rows().map((r) => r.getAttribute("aria-posinset"))).toEqual(["1", "2", "3"]);
        expect(rows().map((r) => r.getAttribute("aria-setsize"))).toEqual(["3", "3", "3"]);
    });

    it("announces an empty result set instead of going silent", () => {
        setup();
        fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "zzzz" } });
        expect(screen.getByRole("status")).toHaveTextContent("No results");
        expect(screen.getByLabelText("Search commands")).toHaveAttribute("aria-expanded", "false");
        // And the empty state is NOT inside the listbox, which may own only options
        // and groups.
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    // The rows are reachable by pointer and by AT, never by Tab. DOM focus has to
    // stay in the search input, because that is what carries aria-activedescendant.
    // Let Tab land on a row and the models come apart: the reader tracks the button
    // (which has no activedescendant), so the next ArrowDown moves the cursor and
    // the highlight while announcing nothing, and Enter runs a row the user was
    // never told about.
    it("keeps the rows out of the tab order", () => {
        const { rows } = setup();
        expect(rows().map((r) => r.tabIndex)).toEqual([-1, -1, -1]);
    });

    // Assistive technology emits no pointer events: it activates through the
    // platform a11y API, which dispatches a simulated click, and that does not need
    // the row to be focusable. A simulated click carries detail 0; the pointer's
    // carries a count and is ignored, because pointerup already ran the command.
    it("activates from a simulated click without double-running the pointer's command", () => {
        const run = vi.fn();
        const { rows } = setup([...COMMANDS.slice(0, 2), { id: "x", label: "Export", section: "File", run }]);

        fireEvent.click(rows()[2], { detail: 0 });   // Space on a focused row
        expect(run).toHaveBeenCalledTimes(1);

        // A full mouse press: pointerup runs it, the trailing click must not.
        fireEvent.pointerDown(rows()[2]);
        fireEvent.pointerUp(rows()[2]);
        fireEvent.click(rows()[2], { detail: 1 });
        expect(run).toHaveBeenCalledTimes(2);
    });
});
