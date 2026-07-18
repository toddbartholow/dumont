/**
 * The one way this app writes a document to disk.
 *
 * There were seven `invoke("save_file")` call sites: Ctrl+S, Save As, autosave,
 * the background-tab autosave, the two close-with-unsaved-changes dialogs, and
 * "create the note this link points at". Anything that has to happen on EVERY save
 * (a version-history snapshot, say) would have had to be remembered seven times,
 * and the eighth call site would forget it. So they all come through here.
 *
 * The one deliberate exception is `offerCreateNote`, which writes an empty
 * brand-new file. A snapshot of nothing, taken before the document exists, is not
 * history; it is a spurious first entry in every new note's list. That one still
 * calls `save_file` directly, and says why.
 */
import { invoke } from "@tauri-apps/api/core";
import { recordSnapshot } from "./history";

/**
 * Write `content` to `path` and record a history snapshot. Returns the new mtime,
 * exactly as `save_file` does, so this is a drop-in for the invoke it replaces.
 *
 * The snapshot is FIRE AND FORGET, on purpose. It is not awaited, so it cannot add
 * its IPC round trip to the latency of a Ctrl+S; it swallows its own errors, so a
 * broken history store cannot fail a save that in fact succeeded; and it never
 * raises a toast. The document is what the user cares about. History is a service
 * to it, and a service that can take the thing it serves down with it is worse than
 * no service at all.
 *
 * `awaitSnapshot` is the one exception, for the save-and-close-WINDOW path. There,
 * the very next statement tears the process down, and an un-awaited snapshot is
 * simply lost: the final version of a file, the one saved on the way out through the
 * unsaved-changes dialog, would be the one version reliably missing from its own
 * history. Nothing is racing the user for latency at that point, because the app is
 * quitting, so it is worth the round trip. It still cannot fail the save.
 */
export async function saveDocument(
    path: string,
    content: string,
    awaitSnapshot = false
): Promise<number> {
    const mtime = await invoke<number>("save_file", { path, content });
    const snapshot = recordSnapshot(path, content);
    if (awaitSnapshot) await snapshot;
    return mtime;
}
