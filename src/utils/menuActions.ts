// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/** The prefix an Open Recent menu item carries, with the file's path after it. */
const RECENT_PREFIX = "file.recent:";

/**
 * The path behind an Open Recent menu id, or null if the id is not one.
 *
 * The colon is load-bearing. The File menu also contains "file.recent.clear" and
 * "file.recent.none", so a check for "file.recent" (no colon) matches all three
 * and hands the file loader an empty path to open, or the string ".clear".
 */
export function recentPathFromMenuId(id: string): string | null {
    if (!id.startsWith(RECENT_PREFIX)) return null;
    const path = id.slice(RECENT_PREFIX.length);
    return path.length > 0 ? path : null;
}
