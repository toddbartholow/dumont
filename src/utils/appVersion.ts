/**
 * The app's version, for display in Settings → About.
 *
 * Two sources, deliberately. BUILD_VERSION is inlined from package.json at
 * build time (see vite.config.ts) and is therefore always available — including
 * in a browser dev session or a jsdom test, where the Tauri IPC bridge does not
 * exist. getAppVersion() prefers Tauri's runtime value, which reports the
 * version of the binary that is actually running: after an auto-update those
 * two can differ, and the running one is the honest answer.
 */

/** Inlined from package.json at build time. Never empty. */
export const BUILD_VERSION: string = __APP_VERSION__;

/** The running app's version; falls back to the build-time constant outside Tauri. */
export async function getAppVersion(): Promise<string> {
    try {
        const { getVersion } = await import("@tauri-apps/api/app");
        return await getVersion();
    } catch {
        return BUILD_VERSION;
    }
}
