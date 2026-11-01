import DOMPurify, { type Config } from "dompurify";

/**
 * The one DOMPurify pass for mermaid's SVG, shared by the reader (MermaidBlock)
 * and every export (prepareExportHtml).
 *
 * mermaid renders with `securityLevel: "strict"`, which already strips scripts
 * and handlers from labels. But its output is the one rendered path that never
 * passes through the Markdown sanitizer: the reader injected it with
 * dangerouslySetInnerHTML, trusting mermaid alone, so a future strict-mode
 * escape would run in the app window next to the Tauri IPC bridge. The export
 * already re-sanitized; the reader now runs the same pass.
 *
 * The config keeps what a real diagram is made of: SVG shapes and filters,
 * the scoped <style> that carries its colors, marker and gradient
 * references, `dominant-baseline`, and <foreignObject>, the HTML integration
 * point mermaid puts htmlLabels in. DOMPurify reaches INTO a foreignObject and
 * sanitizes its XHTML rather than trusting it, so a script or handler in a
 * label is removed while the label itself survives.
 */
export const DIAGRAM_SANITIZE_CONFIG: Config = {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["style", "foreignobject"],
    ADD_ATTR: ["dominant-baseline"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
};

export function sanitizeDiagramSvg(svg: string): string {
    return DOMPurify.sanitize(svg, DIAGRAM_SANITIZE_CONFIG) as string;
}
