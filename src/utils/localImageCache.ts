/**
 * Local preview images as object URLs, keyed by document folder + relative
 * path and revalidated against the file's mtime.
 *
 * Without a cache, a document that references one image 50 times reads the
 * file 50 times and makes 50 object URLs. The cache used to be keyed by path
 * alone, so an image rewritten on disk (a regenerated diagram, an edited
 * screenshot) kept showing its first version until the app restarted. Each
 * lookup now stats the file first; a changed mtime revokes the stale URL and
 * reads the file again.
 *
 * Concurrent lookups of one image share a single in-flight lookup. Every
 * reference re-checks on window focus, so without sharing, 50 references sent
 * 50 stats at once, and after a change on disk all 50 missed together: 50
 * reads, and 49 object URLs overwritten in the map without being revoked.
 *
 * LRU eviction at `cap` entries: the Map keeps insertion order, so a hit is
 * re-inserted (moved to the end) and the front is evicted when full. Evicted
 * URLs are revoked so the image data can be garbage collected.
 */
export interface LocalImageCacheDeps {
    /** mtime (ms) of the file at this absolute path, or null when it can't be stat'ed. */
    stat: (path: string) => Promise<number | null>;
    /** Read the image through the validated backend command. */
    read: (baseDir: string, relPath: string) => Promise<ArrayBuffer>;
    createUrl: (blob: Blob) => string;
    revokeUrl: (url: string) => void;
    cap?: number;
}

export type LocalImageLookup = (baseDir: string, relPath: string, mimeType: string) => Promise<string>;

/** Join a document folder and a validated relative path for the stat call. */
export function joinImagePath(baseDir: string, relPath: string): string {
    return `${baseDir.replace(/[/\\]+$/, "")}/${relPath}`;
}

export function createLocalImageCache({ stat, read, createUrl, revokeUrl, cap = 100 }: LocalImageCacheDeps): LocalImageLookup {
    const entries = new Map<string, { url: string; mtime: number | null }>();
    const inFlight = new Map<string, Promise<string>>();

    async function lookUp(key: string, baseDir: string, relPath: string, mimeType: string): Promise<string> {
        const mtime = await stat(joinImagePath(baseDir, relPath));
        const hit = entries.get(key);
        if (hit !== undefined) {
            entries.delete(key);
            // An unknown mtime (the stat failed) keeps the cached copy rather
            // than re-reading on every render; a real read error surfaces on
            // the next miss.
            if (mtime === null || hit.mtime === mtime) {
                entries.set(key, hit);
                return hit.url;
            }
            revokeUrl(hit.url);
        }
        const buf = await read(baseDir, relPath);
        const url = createUrl(new Blob([buf], { type: mimeType }));
        entries.set(key, { url, mtime });
        if (entries.size > cap) {
            const oldestKey = entries.keys().next().value;
            if (oldestKey !== undefined) {
                revokeUrl(entries.get(oldestKey)!.url);
                entries.delete(oldestKey);
            }
        }
        return url;
    }

    return function getLocalImageUrl(baseDir, relPath, mimeType) {
        const key = `${baseDir}\u0000${relPath}`;
        const running = inFlight.get(key);
        if (running) return running;
        const lookup = lookUp(key, baseDir, relPath, mimeType).finally(() => inFlight.delete(key));
        inFlight.set(key, lookup);
        return lookup;
    };
}
