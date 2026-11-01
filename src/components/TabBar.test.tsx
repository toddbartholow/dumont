import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar, type TabBarItem } from "./TabBar";

const item = (id: string, name: string, dirty = false): TabBarItem => ({ id, name, label: name, dirty });

function setup(tabs: TabBarItem[] = [item("a", "a.md"), item("b", "b.md")]) {
    const props = {
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onNewTab: vi.fn(),
        onPointerActivate: vi.fn(),
    };
    render(<TabBar tabs={tabs} activeId={tabs[0].id} {...props} />);
    const tab = (name: string) => screen.getAllByRole("tab").find((t) => t.getAttribute("title") === name)!;
    return { ...props, tab };
}

describe("TabBar focus (FOCUS-01)", () => {
    it("asks the app to focus the document after a mouse click activates a tab", () => {
        const { tab, onSelect, onPointerActivate } = setup();

        fireEvent.mouseDown(tab("b.md"), { button: 0 });

        expect(onSelect).toHaveBeenCalledWith("b");
        expect(onPointerActivate).toHaveBeenCalledWith("b");
    });

    it("keeps focus on the strip when the keyboard moves along it", () => {
        const { tab, onSelect, onPointerActivate } = setup();
        tab("a.md").focus();

        fireEvent.keyDown(tab("a.md"), { key: "ArrowRight" });

        expect(onSelect).toHaveBeenCalledWith("b");
        expect(onPointerActivate).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(tab("b.md"));
    });

    it("does not close a tab on Backspace", () => {
        const { tab, onClose } = setup();

        fireEvent.keyDown(tab("a.md"), { key: "Backspace" });

        expect(onClose).not.toHaveBeenCalled();
    });

    it("still closes the focused tab on Delete", () => {
        const { tab, onClose } = setup();

        fireEvent.keyDown(tab("a.md"), { key: "Delete" });

        expect(onClose).toHaveBeenCalledWith("a");
    });
});

describe("TabBar unsaved indicator (#178)", () => {
    it("names a dirty tab as unsaved and marks it with a visible bullet", () => {
        const { tab } = setup([item("a", "notes.md", true), item("b", "other.md")]);

        expect(screen.getByRole("tab", { name: "notes.md (unsaved changes)" })).toBe(tab("notes.md"));
        expect(screen.getByRole("tab", { name: "other.md" })).toBe(tab("other.md"));

        const bullet = (name: string) => [...tab(name).querySelectorAll("span")].find((s) => s.textContent === "• ")!;
        expect(bullet("notes.md").className).not.toContain("invisible");
        // A clean tab keeps the slot, hidden, so it is the same width either way.
        expect(bullet("other.md").className).toContain("invisible");
    });

    it("shows one unsaved indicator, not a second dot in the close slot", () => {
        const { tab } = setup([item("a", "notes.md", true)]);

        expect(tab("notes.md").querySelector(".rounded-full")).toBeNull();
        expect(screen.getByRole("button", { name: "Close notes.md" })).toBeTruthy();
    });

    it("uses the disambiguated label in the accessible name", () => {
        setup([{ id: "a", name: "README.md", label: "README.md (docs)", dirty: true }]);

        expect(screen.getByRole("tab", { name: "README.md (docs) (unsaved changes)" })).toBeTruthy();
    });
});
