/**
 * "Save" in the unsaved-changes dialog: write the tab, then close it.
 *
 * The whole of this file is one guarantee: THE TAB SURVIVES UNLESS ITS CONTENTS REACHED THE
 * DISK. Everything else here is detail.
 *
 * It used to live inline in App as a pair of bare `return` statements inside an async
 * callback, and those two returns were the only thing standing between a cancelled file
 * picker and a destroyed buffer. Turn either one into a fallthrough and every test in the
 * project still passes while the user's work is deleted, because nothing tested it. So the
 * I/O is injected and the decision comes back as a value: now the guarantee is a thing you
 * can assert on.
 */

export interface SaveCloseTarget {
    /** null for an unsaved buffer, which has to be given a home first. */
    filePath: string | null;
    fileName: string;
    content: string;
}

export interface SaveCloseIO {
    /** Ask the user where to put an unsaved buffer. Resolves null if they cancel. */
    pickPath: (defaultName: string) => Promise<string | null>;
    /** Write it. Rejects if the disk says no. */
    save: (path: string, content: string) => Promise<unknown>;
    /** Tell the user why it did not work. */
    onError: (message: string) => void;
}

export type SaveCloseOutcome =
    /** It is on disk. Closing the tab now loses nothing. */
    | { action: "close"; path: string }
    /**
     * It is NOT on disk: the user cancelled the picker, or the write failed. The tab must stay
     * open, and so must the dialog, or the buffer goes in the bin unremarked.
     */
    | { action: "keep-open"; reason: "cancelled" | "save-failed" };

export async function saveThenClose(
    target: SaveCloseTarget,
    io: SaveCloseIO,
): Promise<SaveCloseOutcome> {
    let path = target.filePath;

    if (!path) {
        const picked = await io.pickPath(target.fileName);
        // Cancelled. The user did not say "discard", they said "not now", and those are not
        // the same answer. Closing here would treat the second as the first.
        if (!picked) return { action: "keep-open", reason: "cancelled" };
        path = picked;
    }

    try {
        await io.save(path, target.content);
    } catch (err) {
        // A full disk, a read-only volume, a file someone else has locked. The content is
        // still only in memory, and memory is what we are about to throw away.
        io.onError(err instanceof Error ? err.message : String(err));
        return { action: "keep-open", reason: "save-failed" };
    }

    return { action: "close", path };
}
