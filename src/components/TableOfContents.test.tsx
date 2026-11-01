import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TableOfContents } from "./TableOfContents";

afterEach(cleanup);

const DOC = ["# One", "text", "## Two", "text", "## Three", "text", "# Four"].join("\n");

describe("TableOfContents", () => {
    // Closed, the panel is only translated off screen, so it stayed in the
    // accessibility tree and in the tab order: a screen reader user browsing the
    // document found landmarks that are nowhere on screen, heard the outline read
    // out, and could Tab to a Close button they could not see.
    it("is not reachable at all when it is closed", () => {
        const { rerender } = render(
            <TableOfContents isOpen={false} content={DOC} onClose={() => { }} />,
        );
        expect(screen.queryByRole("button", { name: /close outline/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

        rerender(<TableOfContents isOpen content={DOC} onClose={() => { }} />);
        expect(screen.getByRole("button", { name: /close outline/i })).toBeInTheDocument();
    });

    it("keeps the active heading in view as the document scrolls", () => {
        const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
        const { rerender } = render(
            <TableOfContents isOpen content={DOC} onClose={() => { }} activeLine={1} />,
        );
        scrollIntoView.mockClear();

        rerender(<TableOfContents isOpen content={DOC} onClose={() => { }} activeLine={7} />);
        expect(scrollIntoView).toHaveBeenCalled();
        scrollIntoView.mockRestore();
    });

    // Clicking a heading dispatches goto-line, which the preview answers with a
    // SMOOTH scroll. activeLine tracks the top of the viewport, so it keeps
    // changing all through that animation and this panel scrolls itself to follow.
    // Press a second heading while that is still running and the row was sliding
    // out from under the press: pointerdown and pointerup landed on different
    // elements and WebView2 dropped the click, so the second heading did nothing.
    it("does not scroll itself out from under a press", () => {
        const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
        const goto = vi.fn();
        window.addEventListener("dumont:goto-line", goto);

        const { rerender } = render(
            <TableOfContents isOpen content={DOC} onClose={() => { }} activeLine={1} />,
        );
        scrollIntoView.mockClear();

        const four = screen.getByRole("button", { name: /Go to heading: Four/ });
        fireEvent.pointerDown(four);

        // The in-flight smooth scroll from an earlier jump moves the active line.
        rerender(<TableOfContents isOpen content={DOC} onClose={() => { }} activeLine={5} />);
        expect(scrollIntoView).not.toHaveBeenCalled();   // the row stays put

        // So the press lands, and the click it synthesises reaches the row.
        fireEvent.pointerUp(four);
        fireEvent.click(four);
        expect(goto).toHaveBeenCalled();

        // The press is over, so the panel follows the document again.
        rerender(<TableOfContents isOpen content={DOC} onClose={() => { }} activeLine={3} />);
        expect(scrollIntoView).toHaveBeenCalled();

        window.removeEventListener("dumont:goto-line", goto);
        scrollIntoView.mockRestore();
    });
});

describe("TableOfContents headings", () => {
    // The panel used to match `#` lines anywhere: a bash comment in a fence and a
    // YAML key in frontmatter both showed up, titles carried raw markdown, and a
    // setext heading (text over ===) was missing.
    it("lists real headings only, as display text", () => {
        const doc = [
            "---", "# not a heading: frontmatter", "---",
            "# **Bold** [link](x.md)",
            "```bash", "# a comment", "```",
            "Setext", "======",
        ].join("\n");
        render(<TableOfContents isOpen content={doc} onClose={() => { }} />);
        const rows = screen.getAllByRole("button", { name: /^Go to heading:/ });
        expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
            "Go to heading: Bold link",
            "Go to heading: Setext",
        ]);
    });

    it("jumps to the setext heading's source line", () => {
        const goto = vi.fn();
        window.addEventListener("dumont:goto-line", goto);
        render(<TableOfContents isOpen content={"intro\n\nTitle\n---"} onClose={() => { }} />);
        fireEvent.click(screen.getByRole("button", { name: "Go to heading: Title" }));
        expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ line: 3 });
        window.removeEventListener("dumont:goto-line", goto);
    });
});
