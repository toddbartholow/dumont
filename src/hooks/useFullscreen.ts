import { useState, useRef, useCallback, useEffect } from "react";
import { Window } from "@tauri-apps/api/window";
import { IS_MAC, fullscreenShortcut } from "../utils/platform";

// Fullscreen-transition timing. The cover fades IN over FS_FADE_IN_MS (kept in
// sync with the cover's Tailwind duration class) and we wait that long before
// resizing the window, so the resize is fully masked. After the resize calls
// resolve we hold FS_SETTLE_MS for the OS to finish painting, then fade out.
const FS_FADE_IN_MS = 150;
const FS_SETTLE_MS = 200;

export interface FullscreenControls {
  /** True when the window is in OS fullscreen. */
  isFullscreen: boolean;
  /** True while the masking cover is faded in over a resize transition. */
  fsTransition: boolean;
  /** Toggle OS fullscreen (F11), masking the resize behind a fade. */
  toggleFullscreen: () => Promise<void>;
}

/**
 * Toggle OS fullscreen (F11). The custom title bar deliberately stays visible so
 * there's always an obvious way back (its square button turns into "exit
 * fullscreen", plus F11 again); a one-time hint reinforces it.
 *
 * Two Windows-specific footguns, both worked around here. (1) On a frameless
 * (decorations:false) window, entering fullscreen while MAXIMIZED leaves a black
 * bar where the taskbar was / overflows the right edge — a known tao bug. So we
 * drop maximize first and restore it on exit. (2) isFullscreen() returns
 * unreliable values for frameless windows, so F11 "wouldn't exit"; we track the
 * state ourselves instead of querying it. FULLSCREEN-01.
 *
 * Tracking it ourselves only sees the toggles that come through here, though,
 * and on macOS fullscreen has a route that does not: the native View menu's
 * Toggle Full Screen (⌃⌘F) calls AppKit directly. That left the title bar
 * offering "Maximize" on a fullscreen window. So on macOS the window's own
 * state wins: every resize (and entering or leaving fullscreen is one) re-reads
 * isFullscreen(). tao keeps that value current there, from the NSWindow
 * delegate's will-enter and did-exit callbacks. Tauri 2 has no
 * fullscreen-changed event, which is why it is resize.
 *
 * macOS only. Windows keeps pure self-tracking for the reason above, and on
 * Linux tao's fullscreen() returns a value only set_fullscreen writes (a change
 * made by the window manager goes to a flag it never reads), so a read there
 * could never see an outside change anyway.
 *
 * @param notify shows the "press <key> to exit" hint when entering fullscreen.
 * @param syncFromWindow follow the window's real state; tests pass it.
 */
export function useFullscreen(
  notify: (message: string) => void,
  { syncFromWindow = IS_MAC }: { syncFromWindow?: boolean } = {},
): FullscreenControls {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreenRef = useRef(false);
  const wasMaximizedRef = useRef(false);
  // How many toggleFullscreen calls are mid-flight. The window resizes more than
  // once during its own transition (unmaximize, then fullscreen), and a read
  // taken between the two would flip the state back and forth; the toggle sets
  // the final value itself when it is done. A count, not a flag: with two
  // toggles overlapping, the first one's finally would clear a flag while the
  // second is still resizing the window.
  const togglesInFlightRef = useRef(0);
  // Drops an opaque cover over the webview while the window resizes. The
  // unmaximize→fullscreen step (and its reverse) physically resizes the window
  // twice, so the content visibly reflows mid-transition — a jarring "snap".
  // We fade the cover IN to full opacity, hold while the OS settles behind it,
  // then fade it OUT, so the change reads as a smooth dip rather than a hard
  // cut. Crucially we wait for the fade-in to finish before touching the window,
  // so the resize is masked from its very first frame (a single rAF wasn't
  // reliably enough — early reflow frames leaked through). FULLSCREEN-01.
  const [fsTransition, setFsTransition] = useState(false);

  const toggleFullscreen = useCallback(async () => {
    togglesInFlightRef.current += 1;
    try {
      const w = Window.getCurrent();
      const next = !isFullscreenRef.current;
      // Fade the cover in, then wait for it to reach full opacity before the
      // window starts resizing underneath it. FS_FADE_IN_MS must stay in sync
      // with the cover's fade-in duration class.
      setFsTransition(true);
      await new Promise((r) => window.setTimeout(r, FS_FADE_IN_MS));
      if (next) {
        wasMaximizedRef.current = await w.isMaximized();
        if (wasMaximizedRef.current) await w.unmaximize();
        await w.setFullscreen(true);
        notify(`Fullscreen on. Press ${fullscreenShortcut()} to exit`);
      } else {
        await w.setFullscreen(false);
        if (wasMaximizedRef.current) await w.maximize();
      }
      isFullscreenRef.current = next;
      setIsFullscreen(next);
    } catch {
      /* browser dev mode — no Tauri window */
    } finally {
      togglesInFlightRef.current -= 1;
      // Let the resize settle behind the fully-opaque cover, then fade out.
      window.setTimeout(() => setFsTransition(false), FS_SETTLE_MS);
    }
  }, [notify]);

  useEffect(() => {
    if (!syncFromWindow) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      const w = Window.getCurrent();
      w.onResized(async () => {
        if (togglesInFlightRef.current > 0) return;
        try {
          const fs = await w.isFullscreen();
          if (cancelled || togglesInFlightRef.current > 0) return;
          // Changed behind the hook's back. Whatever wasMaximizedRef remembers
          // belongs to an older transition: left set, exiting through the hook
          // would maximize a window that was never maximized.
          if (fs !== isFullscreenRef.current) wasMaximizedRef.current = false;
          isFullscreenRef.current = fs;
          setIsFullscreen(fs);
        } catch {
          /* window gone mid-read */
        }
      })
        .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
        .catch(() => {});
    } catch {
      /* browser dev mode, no Tauri window */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [syncFromWindow]);

  return { isFullscreen, fsTransition, toggleFullscreen };
}
