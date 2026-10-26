// The rehype-sanitize schema for the preview and every export. MarkdownPreview
// explains where it sits in the plugin order and why it is not optional.
import { defaultSchema } from "rehype-sanitize";

// The schema is GitHub's defaultSchema plus two narrow additions:
//  - `math`/`math-inline`/`math-display` classes on span/div, so remark-math's
//    markers survive sanitize and rehype-katex (which runs after) can find them;
//  - the `wikilink:` href protocol, so our internal links aren't stripped.
// Its own module so the security regression test drives the REAL schema, not a
// copy of it (src/security/xssSanitize.test.tsx). A copy would pass while this
// drifts.
export const SANITIZE_SCHEMA = {
    ...defaultSchema,
    // remark-rehype already prefixes every footnote id AND its matching href
    // with `user-content-`; sanitize's default clobber pass would prefix the
    // id a SECOND time (ids are on its clobber list, fragment hrefs are not),
    // so footnote refs and back-arrows pointed at ids that don't exist — in
    // the app and in every export. Markdown-generated ids stay clobber-safe
    // via the remark prefix. The cost: ids on raw HTML are no longer
    // rewritten; acceptable since the schema allows none of the elements
    // DOM-clobbering needs (form/iframe/object/embed) and the bundled app
    // never reads bare window globals an id could shadow.
    clobberPrefix: "",
    // `mark` is not in GitHub's default allowlist; the ==highlight== syntax
    // (remark-flexible-markers) emits it, so it must survive sanitize. `sup`,
    // `sub`, `dl`, `dt` and `dd` are already in defaultSchema.tagNames. SYNTAX-01.
    tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
    attributes: {
        ...defaultSchema.attributes,
        span: [...(defaultSchema.attributes?.span ?? []), ["className", "math", "math-inline", "math-display"]],
        div: [...(defaultSchema.attributes?.div ?? []), ["className", "math", "math-inline", "math-display"]],
    },
    protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href ?? []), "wikilink"],
    },
} as typeof defaultSchema;
