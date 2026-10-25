import { useEffect, useRef, useState } from "react";
import { isConflictError, saveDocument } from "../utils/saveDocument";
import { recordAutosaveFailure, type AutosaveFailure } from "../utils/autosaveRetry";

export interface UseAutosaveOptions {
  /** Master toggle (Settings → Editor). */
  enabled: boolean;
  /** Path of the open file, or null for an unsaved Untitled buffer. */
  filePath: string | null;
  /** Live editor content. */
  content: string;
  /** Last-persisted content; autosave is a no-op while it equals `content`. */
  originalContent: string;
  /**
   * True while an AI review is pending. `content` then reflects only the chunks
   * accepted so far, and a later "Reject all" would otherwise leave disk holding
   * edits the user explicitly rejected, so autosave must stay parked. AI-01.
   */
  isReviewActive: boolean;
  /** Which open document this is (the tab id). Handed back to `onSaved` because a write can
   *  finish after the user has switched tabs, and the result belongs to this one. */
  documentId?: string | null;
  /** Called after a successful write with the new mtime, the saved content, and the
   *  `documentId` the save was made for. */
  onSaved: (mtime: number, content: string, documentId: string | null) => void;
  /** Called when a write fails (already throttled to at most once per 30s). */
  onError: (message: string) => void;
  /**
   * The mtime the document was last read or saved at, read when the save fires. Passed to
   * `save_file`, which refuses rather than write over a file someone else has changed since:
   * an autosave is the one write the user never chose, so it must never be the one that
   * silently destroys another program's edit. EXT-03.
   */
  getKnownMtime?: () => number;
  /** The file changed on disk and the user has not yet said whose version wins. Autosave
   *  stays parked until they do. */
  isConflicted?: boolean;
  /** Called, instead of `onError`, when the save was refused for that reason. */
  onConflict?: (documentId: string | null) => void;
}

/** Debounce before persisting after the last edit. */
const AUTOSAVE_DELAY_MS = 1500;

/**
 * Autosave: once enabled, persist the buffer a moment after the user stops
 * typing. Silent on success (the status dot already flips to "Saved"); failures
 * surface through `onError`, throttled so a broken disk keeps reminding the user
 * without spamming on every debounce tick. A failed write is retried with a
 * backoff even if nothing is typed (see autosaveRetry). SAVE-03. A successful
 * save clears both.
 *
 * `onSaved`/`onError` must be stable (wrap in useCallback) — they're effect deps,
 * so a fresh identity each render would reset the debounce timer continuously and
 * autosave would never fire.
 */
export function useAutosave({
  enabled,
  filePath,
  content,
  originalContent,
  isReviewActive,
  documentId = null,
  onSaved,
  onError,
  getKnownMtime,
  isConflicted = false,
  onConflict,
}: UseAutosaveOptions): void {
  const failureRef = useRef<AutosaveFailure | undefined>(undefined);
  // Bumped after a failed write, so the effect runs again and schedules the retry: nothing
  // else would re-run it until the text changed.
  const [retryTick, setRetryTick] = useState(0);

  // Another document's failures say nothing about this one's, and must not mute its toast.
  useEffect(() => {
    failureRef.current = undefined;
  }, [documentId, filePath]);

  useEffect(() => {
    if (!enabled || !filePath || content === originalContent || isReviewActive || isConflicted) return;
    // After a failure, wait out the backoff; typing does not hurry a disk that is refusing.
    const retryAt = failureRef.current?.retryAt ?? 0;
    const delay = Math.max(AUTOSAVE_DELAY_MS, retryAt - Date.now());
    const id = window.setTimeout(async () => {
      try {
        // Through saveDocument, so an autosave is snapshotted like any other save.
        // This is also the save that makes coalescing non-negotiable: at one write
        // per 1.5 s of typing, an un-coalesced history would hold the last ninety
        // seconds of the document and nothing else. See src-tauri/src/history.rs.
        const mtime = await saveDocument(filePath, content, { expectedMtime: getKnownMtime?.() });
        failureRef.current = undefined;
        onSaved(mtime, content, documentId);
      } catch (err) {
        if (onConflict && isConflictError(err)) {
          onConflict(documentId);
          return;
        }
        const { failure, notify } = recordAutosaveFailure(failureRef.current, Date.now());
        failureRef.current = failure;
        if (notify) {
          const msg = typeof err === "string" ? err : (err as { message?: string })?.message;
          onError(msg || "Autosave failed");
        }
        setRetryTick((n) => n + 1);
      }
    }, delay);
    return () => window.clearTimeout(id);
  }, [enabled, filePath, content, originalContent, isReviewActive, isConflicted, documentId, onSaved, onError, getKnownMtime, onConflict, retryTick]);
}
