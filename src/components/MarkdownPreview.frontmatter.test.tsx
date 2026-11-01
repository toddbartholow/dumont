// The Properties card writes back through updateFrontmatter, so an edit made in
// the card changes only that key's line and keeps the user's comments, quoting
// and blank lines. It used to re-serialize the whole block.
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async () => null),
    convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

afterEach(cleanup);

it("rewrites only the edited key's line, keeping comments and quoting", () => {
    const content = [
        "---",
        "# Post metadata",
        'title: "Hello"  # shown in the tab',
        "",
        "draft: true",
        "tags: [a, b]",
        "---",
        "Body text.",
    ].join("\n");
    const onContentChange = vi.fn();
    render(
        <MarkdownPreview
            content={content}
            fileName="test.md"
            fileSize={content.length}
            onEditClick={() => {}}
            onContentChange={onContentChange}
        />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove a" }));

    expect(onContentChange).toHaveBeenCalledWith(content.replace("tags: [a, b]", "tags: [b]"));
});
