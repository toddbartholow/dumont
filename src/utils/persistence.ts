/**
 * localStorage-backed persistence for app STATE across sessions: open tabs, the
 * recent-file list, the last file, the view mode, the split ratio.
 *
 * SETTINGS do not live here. They are in settings.json (see src/settings/), which
 * the user can read, edit and keep in version control. What is left here is the
 * stuff that would be noise in a config file and meaningless on another machine.
 *
 * There is no migration from an earlier key prefix, and no migration into
 * settings.json: Dumont starts from a clean slate, with no installed base to
 * carry forward.
 */

const KEY_RECENT_FILES = "dumont:recentFiles";
const KEY_LAST_FILE = "dumont:lastFile";
const KEY_VIEW_MODE = "dumont:viewMode";
const KEY_SPLIT_RATIO = "dumont:splitRatio";

// Multi-file/tab workflows make 10 feel tight; 25 keeps the palette's recents
// useful without unbounded growth.
const MAX_RECENT = 25;

const safeGet = <T>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
};

const safeSet = (key: string, value: unknown): void => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {/* storage may be full / disabled */}
};

export interface RecentFile {
    path: string;
    name: string;
    openedAt: number;
}

export const getRecentFiles = (): RecentFile[] => safeGet<RecentFile[]>(KEY_RECENT_FILES, []);

export const addRecentFile = (path: string, name: string): RecentFile[] => {
    const list = getRecentFiles().filter((f) => f.path !== path);
    list.unshift({ path, name, openedAt: Date.now() });
    const trimmed = list.slice(0, MAX_RECENT);
    safeSet(KEY_RECENT_FILES, trimmed);
    return trimmed;
};

export const removeRecentFile = (path: string): RecentFile[] => {
    const list = getRecentFiles().filter((f) => f.path !== path);
    safeSet(KEY_RECENT_FILES, list);
    return list;
};

export const clearRecentFiles = (): void => safeSet(KEY_RECENT_FILES, []);

export const getLastFile = (): string | null => safeGet<string | null>(KEY_LAST_FILE, null);
export const setLastFile = (path: string | null): void => safeSet(KEY_LAST_FILE, path);

// Full multi-tab session, so a relaunch reopens every tab the user had — not
// just the single last file. Only files with a path are stored (untitled
// buffers have no content persisted here); `activeIndex` points into `tabs`.
// getLastFile stays as a migration fallback for sessions saved before this. TABS-07.
const KEY_SESSION = "dumont:session";
export interface SessionTab {
    path: string;
    /** 1-based caret/scroll line to restore. */
    cursorLine?: number;
}
export interface SessionState {
    tabs: SessionTab[];
    activeIndex: number;
}
export const getSession = (): SessionState | null => {
    const s = safeGet<SessionState | null>(KEY_SESSION, null);
    if (!s || !Array.isArray(s.tabs)) return null;
    // Defend against a malformed/hand-edited value.
    const tabs = s.tabs.filter((t): t is SessionTab => !!t && typeof t.path === "string");
    if (tabs.length === 0) return null;
    const activeIndex = Number.isInteger(s.activeIndex) ? Math.min(Math.max(0, s.activeIndex), tabs.length - 1) : 0;
    return { tabs, activeIndex };
};
export const setSession = (s: SessionState | null): void => safeSet(KEY_SESSION, s);

export const getSavedViewMode = (): "preview" | "code" | "split" =>
    safeGet<"preview" | "code" | "split">(KEY_VIEW_MODE, "preview");
export const setSavedViewMode = (m: "preview" | "code" | "split"): void => safeSet(KEY_VIEW_MODE, m);

export const getSplitRatio = (): number => {
    const r = safeGet<number>(KEY_SPLIT_RATIO, 0.5);
    return Number.isFinite(r) && r > 0.15 && r < 0.85 ? r : 0.5;
};
export const setSplitRatio = (r: number): void => safeSet(KEY_SPLIT_RATIO, r);

// The SETTINGS that used to live here (typewriter mode, the toolbar, word wrap,
// spell check, the minimap, autosave, open-in-reader, the AI switch) are in
// settings.json now. See src/settings/. Their accessors are gone rather than
// left as a second way in: two ways to read a preference is one too many, and
// the stale one wins by accident. The editor toolbar's AI sparkle did exactly
// that for a while, reading a value here that nothing wrote any more.

// Version the user chose to skip in the update popup, so we don't nag about
// it on every launch. A newer release has a different version string and
// prompts again.
const KEY_SKIPPED_UPDATE = "dumont:skippedUpdateVersion";
export const getSkippedUpdateVersion = (): string | null =>
    safeGet<string | null>(KEY_SKIPPED_UPDATE, null);
export const setSkippedUpdateVersion = (v: string): void => safeSet(KEY_SKIPPED_UPDATE, v);

const KEY_AI_API_KEY = "dumont:aiApiKey";

// The AI API key lives ONLY in the OS keychain (SECURITY-01), reached through the
// set_ai_key / ai_key_present Tauri commands. The value is never pulled back into
// the webview: Rust reads it itself when it makes an AI request, so an XSS in the
// preview has nothing to steal. That is why there is no getAIKey() any more, and
// why nothing here caches the key in a module variable or in localStorage.
//
// The endpoint and the model, by contrast, ARE settings and live in settings.json
// (see src/settings/). A credential does not belong in a plaintext config file, so
// the key does not travel with them.

/**
 * One-time migration off the legacy plaintext localStorage key. Early builds kept
 * the key at `dumont:aiApiKey`; move any such value into the keychain and delete
 * the plaintext copy. After this runs, localStorage never holds the key. It does
 * NOT hydrate any cache: the value stays in Rust's hands.
 */
export async function initAIKey(): Promise<void> {
    const legacy = safeGet<string>(KEY_AI_API_KEY, "");
    if (!legacy) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_ai_key", { key: legacy });
        localStorage.removeItem(KEY_AI_API_KEY);
    } catch {
        // Keychain unavailable right now, so leave the localStorage copy: a later
        // launch can try again rather than silently dropping the user's key.
    }
}

/**
 * Save (or, with an empty string, clear) the API key in the OS keychain. Writes
 * only through Rust; the value is never mirrored into the webview or localStorage.
 * Any stale legacy plaintext copy is removed on the way through.
 */
export const setAIKey = async (key: string): Promise<void> => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_ai_key", { key });
    } catch {
        // Keychain unavailable, and by design nothing else stores the key.
    }
    // Never leave a plaintext copy behind, whether we just wrote or cleared. The
    // promise resolves only after the write is attempted, so a caller can re-read
    // aiKeyPresent() afterward and see the result of this write, not the state
    // before it.
    try { localStorage.removeItem(KEY_AI_API_KEY); } catch {/* ignore */}
};

/**
 * Whether a key is saved, WITHOUT revealing it. The AI surfaces only need to know
 * one exists (to prompt the user when it does not); the value stays in the
 * keychain. Returns false on any error so the UI degrades safely.
 */
export async function aiKeyPresent(): Promise<boolean> {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<boolean>("ai_key_present");
    } catch {
        return false;
    }
}
