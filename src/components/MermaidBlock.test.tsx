import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

// A compromised render: what a mermaid strict-mode escape would hand back.
const HOSTILE_SVG = [
    '<svg id="m" xmlns="http://www.w3.org/2000/svg"><style>.n{fill:#123456}</style>',
    '<script>window.__pwned = 1</script>',
    '<g class="n" onclick="window.__pwned = 2"><rect width="10" height="10"></rect><text>Start</text></g>',
    '<foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml">',
    '<span>Label</span><img src="x" onerror="window.__pwned = 3"></div></foreignObject>',
    "</svg>",
].join("");

vi.mock("mermaid", () => ({
    default: {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg: HOSTILE_SVG })),
    },
}));
vi.mock("../context/useTheme", () => ({
    useTheme: () => ({ theme: "dark", userThemes: [] }),
}));

import { MermaidBlock } from "./MermaidBlock";

afterEach(cleanup);

describe("MermaidBlock", () => {
    it("sanitizes mermaid's SVG before it reaches the DOM", async () => {
        const { container } = render(<MermaidBlock code="graph TD; A-->B" />);
        const box = await waitFor(() => {
            const el = container.querySelector(".mermaid-rendered");
            expect(el).toBeTruthy();
            return el!;
        });
        const html = box.innerHTML.toLowerCase();
        expect(html).not.toContain("<script");
        expect(html).not.toContain("onclick");
        expect(html).not.toContain("onerror");
        expect(html).not.toContain("__pwned");
        // The diagram itself survives: shapes, colors, both kinds of label.
        expect(box.querySelector("rect")).toBeTruthy();
        expect(box.innerHTML).toContain("#123456");
        expect(box.textContent).toContain("Start");
        expect(box.textContent).toContain("Label");
    });
});
