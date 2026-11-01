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
