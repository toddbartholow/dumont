// Accessibility regressions on the quick-settings controls. Each of these was a
// real defect found in review, and each is invisible to a mouse user — which is
// exactly why they need tests rather than a glance at the UI.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Select, type SelectOption } from "./Select";
import { FontSizeField } from "./FontSizeField";
import { SettingsMenu } from "./SettingsMenu";
import { TestProviders } from "../test/providers";
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from "../utils/typeScale";

afterEach(cleanup);

type Fruit = "apple" | "banana" | "cherry";
const OPTIONS: SelectOption<Fruit>[] = [
    { value: "apple", label: "Apple", hint: "Pome" },
    { value: "banana", label: "Banana" },
    { value: "cherry", label: "Cherry" },
];

describe("Select", () => {
    it("names the trigger with its label AND its current value", () => {
        // A combobox that isn't an <input> exposes no value to VoiceOver, and
        // aria-labelledby suppresses name-from-content — so naming it by the
        // label alone announced a bare "Fruit", never which fruit.
        render(<Select label="Fruit" value="banana" options={OPTIONS} onChange={() => { }} />);
        expect(screen.getByRole("combobox")).toHaveAccessibleName(/Fruit.*Banana/s);
    });

    it("keeps the icon ligature out of the accessible name", () => {
        // Material Symbols renders "expand_more" as a glyph, but the text node is
        // still there for the name computation.
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={() => { }} />);
        expect(screen.getByRole("combobox").getAttribute("aria-label")).toBeNull();
        expect(screen.getByRole("combobox")).not.toHaveAccessibleName(/expand_more/);
    });

    it("marks the active option distinctly from the selected one while previewing", () => {
        // With previewOnActive, `value` follows the option being arrowed over. If
        // aria-selected were driven from it, every option would announce as
        // "selected" in turn and the check mark would travel with the cursor,
        // leaving nothing to say what was set when the list opened.
        const onChange = vi.fn();
        const onPreview = vi.fn();
        const { rerender } = render(
            <Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} onPreview={onPreview} previewOnActive />,
        );
        const trigger = screen.getByRole("combobox");
        fireEvent.click(trigger);
        fireEvent.keyDown(trigger, { key: "ArrowDown" });

        expect(onPreview).toHaveBeenCalledWith("banana");
        rerender(
            <Select label="Fruit" value="banana" options={OPTIONS} onChange={onChange} onPreview={onPreview} previewOnActive />,
        );

        // "Selected" still points at what was committed before opening.
        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "true");   // apple, committed
        expect(options[1]).toHaveAttribute("aria-selected", "false");  // banana, merely active
        expect(options[1]).toHaveAttribute("data-active", "true");
    });

    // The important one. Previewing through onChange persisted every option the
    // pointer merely passed over — and for the theme that wrote localStorage,
    // which permanently opted the user out of OS light/dark following from an
    // interaction they cancelled.
    it("never commits a value that was only previewed", () => {
        const onChange = vi.fn();
        const onPreview = vi.fn();
        const { rerender } = render(
            <Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} onPreview={onPreview} previewOnActive />,
        );
        const trigger = screen.getByRole("combobox");
        fireEvent.click(trigger);

        fireEvent.keyDown(trigger, { key: "ArrowDown" });      // arrow previews
        rerender(<Select label="Fruit" value="banana" options={OPTIONS} onChange={onChange} onPreview={onPreview} previewOnActive />);
        fireEvent.pointerEnter(screen.getAllByRole("option")[2]); // hover previews
        fireEvent.keyDown(trigger, { key: "Escape" });          // and cancel

        expect(onPreview).toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();  // nothing was ever committed
        expect(onPreview).toHaveBeenLastCalledWith("apple"); // reverted to the original
    });

    it("commits only on an explicit choice", () => {
        const onChange = vi.fn();
        const onPreview = vi.fn();
        render(
            <Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} onPreview={onPreview} previewOnActive />,
        );
        fireEvent.click(screen.getByRole("combobox"));
        const cherry = screen.getAllByRole("option")[2];
        fireEvent.pointerDown(cherry);
        fireEvent.pointerUp(cherry);
        expect(onChange).toHaveBeenCalledWith("cherry");
    });

    // The Windows bug. Selection hung off the <li>'s click, and a click only
    // fires when pointerdown and pointerup land on the same element. Let the row
    // move between the two and WebView2 synthesised the click on the <ul> instead
    // — no handler there, so the option silently did not take. Committing on
    // pointerup means the row the user released on is the row they get.
    it("commits the option released on, even if the press began on another", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        fireEvent.click(screen.getByRole("combobox"));
        const options = screen.getAllByRole("option");
        fireEvent.pointerDown(options[1]);
        fireEvent.pointerUp(options[2]);
        expect(onChange).toHaveBeenCalledWith("cherry");
    });

    // pointerup fires for every mouse button; click fired for none but the
    // primary. Committing on pointerup without this guard turned a right-click or
    // a middle-click on an option into a selection.
    it("commits on the primary button only", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        fireEvent.click(screen.getByRole("combobox"));
        const cherry = screen.getAllByRole("option")[2];

        for (const button of [1, 2]) {   // middle, secondary
            fireEvent.pointerDown(cherry, { button });
            fireEvent.pointerUp(cherry, { button });
        }
        expect(onChange).not.toHaveBeenCalled();
    });

    // The press is stamped on the list, and cleared whenever it ends anywhere. A
    // stamp left behind by a gesture that ended outside the list reads exactly
    // like a fresh one, so the NEXT release over an option committed an option the
    // user never pressed: press the trigger to dismiss the list, slip a few pixels
    // onto the first option as you release, and the theme changed.
    it("does not commit a press that began outside the list", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        const trigger = screen.getByRole("combobox");
        fireEvent.click(trigger);

        // A press on an option, abandoned by releasing off the list.
        fireEvent.pointerDown(screen.getAllByRole("option")[2]);
        fireEvent.pointerUp(trigger);
        expect(onChange).not.toHaveBeenCalled();

        // The stamp is gone, so this release cannot borrow it.
        fireEvent.pointerDown(trigger);
        fireEvent.pointerUp(screen.getAllByRole("option")[0]);
        expect(onChange).not.toHaveBeenCalled();
    });

    // Assistive technology emits no pointer events: it activates through the
    // platform a11y API, which dispatches a SIMULATED click. VoiceOver's VO+Space,
    // browse-mode Enter in NVDA/JAWS and "click Cherry" in Voice Control all land
    // here and nowhere else, so committing only on pointerup left them unable to
    // choose an option. A simulated click carries detail 0; a real one counts up.
    it("commits when assistive technology activates the option", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        fireEvent.click(screen.getByRole("combobox"));
        fireEvent.click(screen.getAllByRole("option")[2], { detail: 0 });
        expect(onChange).toHaveBeenCalledWith("cherry");
    });

    it("does not commit twice when a real pointer click follows its own pointerup", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        fireEvent.click(screen.getByRole("combobox"));
        const cherry = screen.getAllByRole("option")[2];
        fireEvent.pointerDown(cherry);
        fireEvent.pointerUp(cherry);
        fireEvent.click(cherry, { detail: 1 });   // the trailing real click
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    // The other half of the same bug: hover used to scrollIntoView, which is what
    // moved the row out from under the press in the first place. An option the
    // pointer is on is visible by definition — only the keyboard cursor may scroll.
    it("scrolls the list for the keyboard cursor but never for the pointer", () => {
        const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={() => { }} />);
        const trigger = screen.getByRole("combobox");
        fireEvent.click(trigger);
        scrollIntoView.mockClear();   // opening scrolls to the selected option

        fireEvent.pointerEnter(screen.getAllByRole("option")[2]);
        expect(scrollIntoView).not.toHaveBeenCalled();

        fireEvent.keyDown(trigger, { key: "ArrowUp" });
        expect(scrollIntoView).toHaveBeenCalled();
        scrollIntoView.mockRestore();
    });

    // Touch: dragging the list to scroll it ends in a pointerup over whatever row
    // happens to be under the finger. That is a scroll, not a choice.
    it("does not commit when the list scrolled under the press", () => {
        const onChange = vi.fn();
        render(<Select label="Fruit" value="apple" options={OPTIONS} onChange={onChange} />);
        fireEvent.click(screen.getByRole("combobox"));

        // jsdom has no layout, so scrollTop is a constant 0. Fake the scroll.
        let scrollTop = 0;
        Object.defineProperty(screen.getByRole("listbox"), "scrollTop", {
            get: () => scrollTop,
            configurable: true,
        });

        const cherry = screen.getAllByRole("option")[2];
        fireEvent.pointerDown(cherry, { pointerType: "touch" });
        scrollTop = 40;   // the finger dragged the list
        fireEvent.pointerUp(cherry);

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole("listbox")).toBeInTheDocument();  // and stays open
    });
});

describe("FontSizeField", () => {
    const setup = (value = 16) => {
        const onChange = vi.fn();
        render(<FontSizeField value={value} onChange={onChange} />);
        return { input: screen.getByRole("combobox"), onChange };
    };

    it("flags an out-of-range number instead of silently clamping it", () => {
        // `999` used to pass validation (it IS a number), then got quietly
        // rewritten to 32 on blur — no error, nothing announced.
        const { input } = setup();
        fireEvent.change(input, { target: { value: "999" } });
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(screen.getByRole("alert")).toHaveTextContent(
            new RegExp(`${MIN_FONT_SIZE}.*${MAX_FONT_SIZE}`),
        );
    });

    it("does not cry wolf on a digit that can still become valid", () => {
        // The minimum is 11 — two digits — so a naive range check fires on the
        // "2" of "24", flashing an error and firing an assertive alert mid-word
        // on the happy path.
        const { input } = setup();
        fireEvent.change(input, { target: { value: "2" } });
        expect(input).not.toHaveAttribute("aria-invalid");
        expect(screen.getByRole("alert")).toHaveTextContent("");

        fireEvent.change(input, { target: { value: "24" } });
        expect(input).not.toHaveAttribute("aria-invalid");
    });

    it("keeps a typed size when the preset list happens to be open", () => {
        // Enter used to route to the highlighted PRESET, discarding the draft: at
        // 17px (not a preset, so the active index fell back to 0) typing "22" and
        // pressing Enter applied 12px.
        const { input, onChange } = setup(17);
        fireEvent.keyDown(input, { key: "ArrowDown", altKey: true }); // open the list
        fireEvent.change(input, { target: { value: "22" } });          // then type
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onChange).toHaveBeenCalledWith(22);
        expect(onChange).not.toHaveBeenCalledWith(12);
    });

    it("announces the error through a live region, not just a description", () => {
        // The field already has focus while you type, and descriptions are only
        // announced on focus — so aria-describedby alone said nothing.
        const { input } = setup();
        fireEvent.change(input, { target: { value: "abc" } });
        expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("exposes the allowed range before you get it wrong", () => {
        const { input } = setup();
        expect(input).toHaveAccessibleDescription(
            new RegExp(`${MIN_FONT_SIZE}.*${MAX_FONT_SIZE}`),
        );
    });

    it("lets Escape through when there is no edit to abandon", () => {
        // Swallowing Escape unconditionally meant the surrounding panel and the
        // settings modal could never be closed from this field.
        const onEscape = vi.fn();
        const onChange = vi.fn();
        render(
            <div onKeyDown={(e) => { if (e.key === "Escape") onEscape(); }}>
                <FontSizeField value={16} onChange={onChange} />
            </div>,
        );
        const input = screen.getByRole("combobox");

        fireEvent.keyDown(input, { key: "Escape" });
        expect(onEscape).toHaveBeenCalledTimes(1); // nothing to cancel -> bubbles

        fireEvent.change(input, { target: { value: "24" } });
        fireEvent.keyDown(input, { key: "Escape" });
        expect(onEscape).toHaveBeenCalledTimes(1); // dirty -> consumed, edit reverted
        expect(input).toHaveValue("16");
    });

    it("closes the preset list on Tab instead of stranding it open", () => {
        const { input } = setup();
        fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
        expect(screen.getByRole("listbox")).toBeInTheDocument();

        fireEvent.keyDown(input, { key: "Tab" });
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("commits a typed size only on Enter, not on every keystroke", () => {
        const { input, onChange } = setup();
        fireEvent.change(input, { target: { value: "2" } });
        fireEvent.change(input, { target: { value: "24" } });
        // "2" would have clamped to the minimum and relaid out the document.
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onChange).toHaveBeenCalledWith(24);
    });
});

describe("SettingsMenu", () => {
    const openPanel = () => {
        render(<TestProviders><SettingsMenu /></TestProviders>);
        fireEvent.click(screen.getByRole("button", { name: /quick settings/i }));
        return screen.getByRole("dialog", { name: /quick settings/i });
    };

    it("is not a menu — it owns comboboxes, not menu items", () => {
        // role="menu" has required owned elements (menuitem and friends) and this
        // panel owns none of them. Claiming it drops screen readers into menu
        // mode, and the roving Arrow/Home/End handler it justified was stealing
        // Home/End from the font-size text field.
        const panel = openPanel();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(panel).toBeInTheDocument();
        // aria-haspopup must name what actually opens.
        expect(screen.getByRole("button", { name: /quick settings/i }))
            .toHaveAttribute("aria-haspopup", "dialog");
    });

    it("leaves Home and End to the font-size field", () => {
        const panel = openPanel();
        const size = within(panel).getByRole("combobox", { name: /size/i });
        size.focus();
        fireEvent.keyDown(size, { key: "Home" });

        // Focus must still be in the input — the panel used to yank it away, so
        // Home moved focus instead of the caret.
        expect(document.activeElement).toBe(size);
    });
});
