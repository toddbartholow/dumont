import { describe, expect, it } from "vitest";
import { sanitizeDiagramSvg } from "./diagramSanitize";

// The shape of a real mermaid strict-mode render: root svg with id/viewBox, a
// scoped <style>, defs with a marker and a gradient, plain paths, and an
// htmlLabels <foreignObject> carrying XHTML labels.
const MERMAID_LIKE_SVG = `<svg id="mmd1z" xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
<style>#mmd1z { font-family: var(--font-body); } #mmd1z .label { fill: #333; }</style>
<defs>
  <marker id="mmd1z_flowpoint" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="marker"/></marker>
  <linearGradient id="mmd1z_grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#eee"/><stop offset="100%" stop-color="#ccc"/></linearGradient>
</defs>
<g transform="translate(10 10)" dominant-baseline="central">
  <rect class="node" width="100" height="40" fill="url(#mmd1z_grad)" stroke="#999"/>
  <path d="M 0 40 C 20 60, 40 60, 60 40" marker-end="url(#mmd1z_flowpoint)"/>
  <text x="5" y="15">Native</text>
  <foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="display:table-cell"><span class="nodeLabel"><p>Hello</p></span></div></foreignObject>
</g>
</svg>`;

describe("sanitizeDiagramSvg", () => {
    it("keeps mermaid's structural output intact", () => {
        const out = sanitizeDiagramSvg(MERMAID_LIKE_SVG);
        expect(out).toContain('<svg id="mmd1z"');
        expect(out).toContain("#mmd1z .label"); // scoped <style> survives
        expect(out).toContain("mmd1z_flowpoint"); // marker refs survive
        expect(out).toContain("linearGradient");
        expect(out).toContain("Native"); // native <text> labels
        expect(out).toContain("<foreignObject"); // htmlLabels integration point
        expect(out).toContain("Hello"); // and the XHTML label in it
        expect(out).toContain("dominant-baseline");
        expect(out).toContain('d="M 0 40');
    });

    it("removes script-capable content from a compromised render", () => {
        const hostile = MERMAID_LIKE_SVG
            .replace("</defs>", '</defs><script>alert("xss")</script>')
            .replace("<g transform=", '<g onclick="alert(1)" onload="alert(2)" transform=')
            .replace("<text x=", '<a href="javascript:alert(4)"><text>x</text></a><text x=')
            .replace("<p>Hello</p>", '<p onclick="alert(3)">Hello</p><iframe src="https://evil.example"></iframe><img src="x" onerror="alert(5)">');
        const out = sanitizeDiagramSvg(hostile);
        expect(out).not.toContain("<script");
        expect(out).not.toContain("alert(");
        expect(out.toLowerCase()).not.toContain("onclick");
        expect(out.toLowerCase()).not.toContain("onerror");
        expect(out.toLowerCase()).not.toContain("javascript:");
        expect(out).not.toContain("<iframe");
        // The diagram itself still renders.
        expect(out).toContain("<foreignObject");
        expect(out).toContain("Hello");
    });
});
