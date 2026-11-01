import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHTML, prepareExportHtml } from "./exportUtils";
import { MarkdownPreview } from "../components/MarkdownPreview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

afterEach(cleanup);

/** The reader's DOM for `md`, as the export menu captures it. */
async function previewHtml(md: string, ready: string): Promise<string> {
    const { container } = render(
        <MarkdownPreview content={md} fileName="doc.md" fileSize={md.length} onEditClick={() => {}} filePath="/notes/doc.md" onNavigateRelative={() => {}} />,
    );
    const body = container.querySelector(".markdown-body")!;
    await waitFor(() => expect(body.querySelector(ready)).toBeTruthy());
    return body.innerHTML;
}

describe("exported links and attributes", () => {
    it("exports wikilinks as plain text, not dead # links", async () => {
        const html = await previewHtml("See [[Some Note|the note]] and [[Other]].", "a[data-wikilink]");
        const out = await prepareExportHtml(html);
        expect(out).toContain("the note");
        expect(out).toContain("Other");
        expect(out).not.toContain('href="#"');
        expect(out).not.toContain("<a");
        expect(out).not.toContain("wikilink");
    });

    it("keeps relative links working and drops preview-only attributes", async () => {
        const html = await previewHtml("# Title\n\n[other](other.md) and [spec](spec.pdf)\n\n![i](https://x.y/i.png)", "a[data-relative-md]");
        expect(html).toContain("data-source-line"); // the preview does use them
        const out = await prepareExportHtml(html);
        expect(out).toContain('href="other.md"');
        expect(out).toContain('href="spec.pdf"');
        expect(out).not.toMatch(/data-source-line|data-relative-md|data-wikilink|\snode=/);
        expect(out).toContain('id="title"');
    });
});

// Read from disk: vitest stubs CSS imports (even ?raw) to an empty string.
const appCss = readFileSync(resolve(__dirname, "../index.css"), "utf8");

// One task item used to strip the bullet from every item in its list, in the
// reader (ul.contains-task-list { list-style: none }) and in exports.
describe("task list bullets", () => {
    it("hides the bullet on task items only, in the reader", () => {
        expect(appCss).not.toMatch(/ul\.contains-task-list\s*\{[^}]*list-style/);
        expect(appCss).toMatch(/li\.task-list-item\s*\{[^}]*list-style-type:\s*none/);
    });

    it("hides the bullet on task items only, in exports", () => {
        const css = generateHTML("<p>x</p>", "t", "light", "inter", 16, []);
        expect(css).not.toMatch(/contains-task-list\s*\{[^}]*list-style/);
        expect(css).toMatch(/li\.task-list-item\s*\{[^}]*list-style-type:\s*none/);
    });
});
