import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

const bar = (props: Partial<Parameters<typeof StatusBar>[0]> = {}) =>
    render(<StatusBar isSaved lineNumber={3} columnNumber={7} mode="code" wordCount={12} charCount={60} {...props} />);

describe("StatusBar live region (A11Y-05)", () => {
    // The whole footer was role="status", so a screen reader announced Ln/Col and the
    // word count on every keystroke.
    it("announces only the save state, not the caret position or the counts", () => {
        bar();

        const regions = screen.getAllByRole("status");
        expect(regions).toHaveLength(1);
        expect(regions[0].textContent).toBe("Saved");
        expect(regions[0].getAttribute("aria-live")).toBe("polite");
        expect(screen.getByText("Ln 3, Col 7").closest("[role='status'], [aria-live]")).toBeNull();
        expect(screen.getByText("12 words").closest("[role='status'], [aria-live]")).toBeNull();
    });

    it("says Unsaved from the same region", () => {
        bar({ isSaved: false });

        expect(screen.getByRole("status").textContent).toBe("Unsaved");
    });
});

describe("StatusBar counts", () => {
    it("uses the singular for one", () => {
        bar({ wordCount: 1, charCount: 1 });

        const words = screen.getByText("1 word");
        expect(words.getAttribute("title")).toBe("1 character");
    });

    it("pluralizes everything else", () => {
        bar({ wordCount: 0, charCount: 2 });

        expect(screen.getByText("0 words").getAttribute("title")).toBe("2 characters");
    });

    it("pluralizes a selection by its own counts", () => {
        bar({ wordCount: 1, selectionLength: 1, selectionWordCount: 1 });

        const words = screen.getByText("1 / 1 word");
        expect(words.getAttribute("title")).toBe("Selection: 1 word, 1 character");
    });
});
