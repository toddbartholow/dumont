import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TitleBar, type TitleBarProps } from "./TitleBar";

// The title bar drives real window controls; the find button is all this file
// is about, so the window API and the two menus it embeds are stubbed out.
vi.mock("@tauri-apps/api/window", () => ({
    Window: { getCurrent: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }) },
}));
vi.mock("./SettingsMenu", () => ({ SettingsMenu: () => null }));
vi.mock("./ExportMenu", () => ({ ExportMenu: () => null }));

afterEach(cleanup);

// Typed, not an untyped literal. Spreading a VARIABLE into JSX skips excess
// property checking, so an untyped `base` would let a typo like `onOpenfile`
// through and the button cluster would silently vanish from every test here.
const base: Partial<TitleBarProps> = { fileName: "notes.md", onOpenFile: vi.fn() };

describe("TitleBar find button", () => {
    it("calls onFind when clicked", () => {
        const onFind = vi.fn();
        render(<TitleBar {...base} viewMode="preview" onFind={onFind} />);
        fireEvent.click(screen.getByRole("button", { name: "Find in page" }));
        expect(onFind).toHaveBeenCalledTimes(1);
    });

    // The button is one control with two destinations, so its name tracks the
    // view. It says "Find in editor", NOT "Find and replace", because it opens
    // that bar in find mode and "Find and replace" is the bar's own dialog name.
    it("names the reader bar in preview mode", () => {
        render(<TitleBar {...base} viewMode="preview" onFind={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Find in page" })).toBeTruthy();
    });

    it("names the editor bar in code mode", () => {
        render(<TitleBar {...base} viewMode="code" onFind={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Find in editor" })).toBeTruthy();
    });

    it("treats split mode as the editor, where the caret is", () => {
        render(<TitleBar {...base} viewMode="split" onFind={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Find in editor" })).toBeTruthy();
    });

    // Its name must not collide with the dialog it opens, which is the editor
    // bar's "Find and replace" (FindReplaceBar).
    it("does not take the find bar's own dialog name", () => {
        render(<TitleBar {...base} viewMode="code" onFind={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Find and replace" })).toBeNull();
    });

    // It toggles, so it has to say so: without aria-pressed a screen reader
    // user gets no signal that the second click closed the bar.
    it("is not pressed while the find bar is closed", () => {
        render(<TitleBar {...base} viewMode="preview" onFind={vi.fn()} findActive={false} />);
        expect(screen.getByRole("button", { name: "Find in page" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("is pressed while the find bar is open", () => {
        render(<TitleBar {...base} viewMode="preview" onFind={vi.fn()} findActive />);
        expect(screen.getByRole("button", { name: "Find in page" }).getAttribute("aria-pressed")).toBe("true");
    });

    // A toggle with no state passed is still a toggle, not a plain button.
    it("carries aria-pressed even when findActive is omitted", () => {
        render(<TitleBar {...base} viewMode="preview" onFind={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Find in page" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("renders no find button when onFind is absent", () => {
        render(<TitleBar {...base} viewMode="preview" />);
        expect(screen.queryByRole("button", { name: /^Find/ })).toBeNull();
    });

    // The cluster only exists once a document is open; on the welcome screen
    // there is nothing to search, and the reader find bar has no root to walk.
    // fileName is dropped on its own here, leaving onOpenFile in place, so this
    // isolates the file condition instead of passing for either half of the gate.
    it("renders no find button before a file is open", () => {
        render(<TitleBar {...base} fileName={undefined} viewMode="preview" onFind={vi.fn()} />);
        expect(screen.queryByRole("button", { name: /^Find/ })).toBeNull();
    });
});

// SAVE-04: off macOS there is no File menu, so these are the only visible way to save.
describe("TitleBar save buttons", () => {
    it("calls onSaveFile and onSaveAs", () => {
        const onSaveFile = vi.fn();
        const onSaveAs = vi.fn();
        render(<TitleBar {...base} viewMode="preview" onSaveFile={onSaveFile} onSaveAs={onSaveAs} />);
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        fireEvent.click(screen.getByRole("button", { name: "Save As" }));
        expect(onSaveFile).toHaveBeenCalledTimes(1);
        expect(onSaveAs).toHaveBeenCalledTimes(1);
    });

    // The tooltip is where a mouse user learns the shortcut.
    it("names the shortcut in the tooltip", () => {
        render(<TitleBar {...base} viewMode="preview" onSaveFile={vi.fn()} onSaveAs={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("title")).toMatch(/^Save \((Ctrl\+S|⌘S)\)$/);
        expect(screen.getByRole("button", { name: "Save As" }).getAttribute("title")).toMatch(/^Save As \((Ctrl\+Shift\+S|⇧⌘S)\)$/);
    });

    // Real buttons, so Tab reaches them and Enter or Space presses them.
    it("are buttons in the tab order", () => {
        render(<TitleBar {...base} viewMode="preview" onSaveFile={vi.fn()} onSaveAs={vi.fn()} />);
        for (const name of ["Save", "Save As"]) {
            const b = screen.getByRole("button", { name });
            expect(b.tagName).toBe("BUTTON");
            expect(b.getAttribute("tabindex")).not.toBe("-1");
        }
    });

    // The welcome screen has nothing to save, the same gate New and Open already follow.
    it("renders no save buttons before a file is open", () => {
        render(<TitleBar {...base} fileName={undefined} viewMode="preview" onSaveFile={vi.fn()} onSaveAs={vi.fn()} />);
        expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    });
});
