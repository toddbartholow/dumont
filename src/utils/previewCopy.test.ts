import { afterEach, describe, expect, it } from "vitest";
import { selectionFragment, writeCleanSelection } from "./previewCopy";

function mount(html: string) {
    const root = document.createElement("div");
    root.className = "markdown-body";
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}
afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
});

// The shapes MarkdownPreview renders: a heading with its permalink button, and a
// code block with its copy button.
const HEADING = '<h2 id="headline"><span>Headline</span><button type="button"><span class="material-symbols-outlined">link</span></button></h2>';
const CODE = '<div class="md-wide relative group"><button type="button">Copy</button><pre><code>let x = 1;</code></pre></div>';

function transfer() {
    const data = new Map<string, string>();
    return { data, dt: { setData: (t: string, v: string) => data.set(t, v) } as unknown as DataTransfer };
}

function selectContents(node: Node) {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.addRange(range);
    return sel;
}

describe("preview copy", () => {
    it("drops the heading permalink icon and the code copy button, keeping the content", () => {
        const root = mount(HEADING + "<ul><li><strong>Bold.</strong> item</li></ul>" + CODE);
        const range = document.createRange();
        range.setStart(root, 0);
        range.setEnd(root, root.childNodes.length);
        const html = selectionFragment(range, root).innerHTML;
        expect(html).not.toContain("<button");
        expect(html).not.toContain("material-symbols");
        expect(html).not.toMatch(/>link<|>Copy</);
        expect(html).toContain("<h2");
        expect(html).toContain("<strong>Bold.</strong>");
        expect(html).toContain("let x = 1;");
    });

    it("wraps a selection inside one list item in its list", () => {
        const root = mount("<ul><li>alpha beta</li><li>gamma</li></ul>");
        const text = root.querySelector("li")!.firstChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 5);
        expect(selectionFragment(range, root).innerHTML).toBe("<ul><li>alpha</li></ul>");
    });

    it("writes clean HTML and text, and does not modify the document", () => {
        const root = mount(HEADING);
        const { data, dt } = transfer();
        expect(writeCleanSelection(selectContents(root), root, dt)).toBe(true);
        expect(data.get("text/plain")).toBe("Headline");
        expect(data.get("text/html")).toContain("Headline");
        expect(data.get("text/html")).not.toContain("link<");
        // The live heading keeps its button.
        expect(root.querySelector("button")).toBeTruthy();
    });

    it("leaves empty selections and selections outside the preview to the browser", () => {
        const root = mount(HEADING);
        const outside = document.createElement("p");
        outside.textContent = "elsewhere";
        document.body.appendChild(outside);
        const { data, dt } = transfer();

        expect(writeCleanSelection(selectContents(outside), root, dt)).toBe(false);
        window.getSelection()!.removeAllRanges();
        expect(writeCleanSelection(window.getSelection(), root, dt)).toBe(false);
        expect(writeCleanSelection(null, root, dt)).toBe(false);
        expect(data.size).toBe(0);
    });
});
