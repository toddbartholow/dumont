/**
 * What a click on a link in the reader should do.
 *
 * The webview IS the app: any link click that is not prevented navigates the
 * whole window away from Dumont, and the unsaved document with it. The reader
 * used to prevent only http(s), mailto, wikilinks, in-page anchors and
 * relative .md links, so `[spec](spec.pdf)` or `[img](diagram.png)` replaced
 * the app with tauri.localhost/spec.pdf. Every kind below is handled without
 * letting the webview navigate.
 */
export type LinkKind =
    /** `#section`: scroll within the document. */
    | "anchor"
    /** `wikilink:Target`, the preview's internal scheme for [[Target]]. */
    | "wikilink"
    /** http(s) and mailto: hand to the OS. */
    | "external"
    /** A relative `.md`/`.markdown` link: open in Dumont. */
    | "relative-md"
    /** Any other relative path: a file next to the document. */
    | "relative-file"
    /** Empty, protocol-relative, or any other scheme (file:, javascript:, ...): do nothing. */
    | "blocked";

export function classifyHref(href: string | null | undefined): LinkKind {
    const h = (href ?? "").trim();
    if (h === "") return "blocked";
    if (h.startsWith("#")) return "anchor";
    if (h.startsWith("wikilink:")) return "wikilink";
    if (/^(https?:|mailto:)/i.test(h)) return "external";
    // `//host/path` would load another site into the app window.
    if (h.startsWith("//") || h.startsWith("\\\\")) return "blocked";
    // Any other scheme. A Windows drive path (`C:\x`) lands here too, which is
    // right: links are resolved relative to the document, never absolute.
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return "blocked";
    if (/\.(md|markdown)(#.*)?$/i.test(h)) return "relative-md";
    return "relative-file";
}

/** The path part of a relative href: query and fragment dropped. */
export function relativeLinkPath(href: string): string {
    return href.replace(/[?#].*$/, "");
}
