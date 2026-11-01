/**
 * Heading slugs, shared by everything that names a heading: the preview's
 * heading ids (and so the permalink copy and exported HTML, which capture that
 * DOM), the outline panel, and the command palette's heading list.
 *
 * GitHub-style: lowercase, punctuation dropped, whitespace runs become one
 * hyphen. Letters, digits and combining marks from ANY script are kept. The
 * class used to be ASCII-only (`[^\w\s-]`), so every CJK, Cyrillic or Greek
 * heading slugified to the empty string, fell back to "section", and a
 * document in Japanese had headings #section, #section-1, #section-2... that
 * no hand-written `[link](#見出し)` could ever reach. The underscore stays
 * because `\w` kept it, so ASCII headings slug exactly as before.
 */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

/** The id a heading gets when its text slugs to nothing at all. */
export const EMPTY_SLUG = "section";

/**
 * Hands out unique heading ids in document order, the way the preview assigns
 * them: the first "Setup" is `setup`, the second `setup-1`. A heading with an
 * explicit `{#custom-id}` reserves that id, and a repeat of it is suffixed the
 * same way, so the DOM never carries two elements with one id.
 */
export function createSlugger(): { slug(text: string): string; reserve(id: string): string } {
    const seen = new Map<string, number>();
    const take = (base: string): string => {
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}-${count}`;
    };
    return {
        slug: (text) => take(slugify(text) || EMPTY_SLUG),
        reserve: (id) => take(id),
    };
}
