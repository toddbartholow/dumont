import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface UseExternalChangeWatcherOptions {
  /** Path of the open file, or null. Read live via ref (listener mounts once). */
  filePathRef: RefObject<string | null>;
  /** Live editor content. */
  contentRef: RefObject<string>;
  /** Last-persisted content. */
  originalContentRef: RefObject<string>;
  /** Known on-disk mtime (ms). Updated in place when a newer mtime is seen. */
  knownMtimeRef: RefObject<number>;
  /** True while an AI review is pending — don't reload over a proposed diff. */
  isReviewActiveRef: RefObject<boolean>;
  /** Reload the file from disk (used when the buffer is clean). `stillWanted` is asked once
   *  the read is back; the reload must drop its result if it answers false. Resolves to
   *  whether the file was reloaded. */
  reload: (path: string, stillWanted: () => boolean) => Promise<boolean>;
  /** Called after a silent reload of a clean buffer. */
  onReloaded: () => void;
  /** Called when the file changed on disk but the buffer is dirty. */
  onConflict: () => void;
}

/**
 * Detect the open file changing underneath us (sync tools, another editor). On
 * window focus, stat the file: if it's newer than what we last wrote and the
 * buffer is clean, reload silently; if the buffer is dirty, warn that saving will
 * overwrite. EXT-01.
 *
 * `reload`/`onReloaded`/`onConflict` should be stable (useCallback); everything
 * else is read through refs so the focus listener mounts once.
 */
export function useExternalChangeWatcher({
  filePathRef,
  contentRef,
  originalContentRef,
  knownMtimeRef,
  isReviewActiveRef,
  reload,
  onReloaded,
  onConflict,
}: UseExternalChangeWatcherOptions): void {
  useEffect(() => {
    let checking = false;
    const checkExternalChange = async () => {
      const path = filePathRef.current;
      // Bail before claiming the `checking` slot so an early return can never
      // strand it set (that would silently kill detection for the session).
      if (!path || checking || isReviewActiveRef.current) return;
      checking = true;
      try {
        const info = await invoke<{ modified: number }>("get_file_info", { path });
        // Every ref below describes the ACTIVE document, and the user can switch during the
        // stat. Carry on and this file's mtime is compared with another file's, the other
        // file's known mtime is overwritten, and a reload of this one can be pushed in front
        // of the tab they just chose. EXT-02.
        if (filePathRef.current !== path) return;
        const known = knownMtimeRef.current ?? 0;
        if (known > 0 && info.modified > known) {
          // Update first so a failed/declined reload doesn't re-toast forever.
          knownMtimeRef.current = info.modified;
          if (contentRef.current === originalContentRef.current) {
            // Clean now, but the read takes time too. If the user types or switches
            // during it, the reload is dropped rather than installed over their edits,
            // and a buffer that has since gone dirty gets the conflict warning instead.
            const judged = contentRef.current;
            const reloaded = await reload(
              path,
              () => filePathRef.current === path && contentRef.current === judged
            );
            if (reloaded) onReloaded();
            else if (filePathRef.current === path && contentRef.current !== originalContentRef.current) onConflict();
          } else {
            onConflict();
          }
        }
      } catch {
        /* file gone or stat failed — the save path will surface it */
      } finally {
        checking = false;
      }
    };
    window.addEventListener("focus", checkExternalChange);
    return () => window.removeEventListener("focus", checkExternalChange);
  }, [filePathRef, contentRef, originalContentRef, knownMtimeRef, isReviewActiveRef, reload, onReloaded, onConflict]);
}
