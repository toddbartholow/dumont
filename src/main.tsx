// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { revealMainWindow } from "./utils/appWindow";
import { SettingsProvider } from "./settings/SettingsProvider";
import { readSettings } from "./settings/store";
import { defaultSettings, setKnownThemeIds } from "./settings/schema";
import { BUILTIN_THEMES } from "./themes";
import { loadUserThemes } from "./themes/userThemes";
// Bundled fonts — load BEFORE index.css so @font-face declarations are
// registered before any rule that references the family names. Without this
// import the app falls back to system fonts when there is no network.
import "./fonts";
import "./index.css";

/**
 * Settings are read from disk BEFORE the first render, not in an effect.
 *
 * Reading them afterwards would mount the whole tree against defaults and then
 * jump: light theme to dark, one font to another, one size to another, in front
 * of the user. The window is created hidden and revealed once painted (#98), so
 * awaiting a single file read here costs nothing visible; it just means the first
 * paint is already correct.
 *
 * Nothing here may throw. A settings file we cannot read is a reason to run on
 * defaults, never a reason to fail to start.
 */
async function boot() {
    // The user's themes are loaded FIRST, because settings are coerced against the
    // list of themes that exist: read them in the other order and a settings.json
    // naming a perfectly good user theme is "corrected" to dark on every launch.
    try {
        const { themes } = await loadUserThemes();
        setKnownThemeIds([...BUILTIN_THEMES.map((t) => t.id), ...themes.map((t) => t.id)]);
    } catch (e) {
        console.error("could not read the themes directory; using the built-in themes", e);
    }

    let initial = {
        values: defaultSettings(),
        present: new Set<string>() as ReadonlySet<string>,
        text: "",
        error: null as string | null,
    };
    try {
        initial = await readSettings();
    } catch (e) {
        console.error("could not read settings.json; running on defaults", e);
    }

    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
        <React.StrictMode>
            <ErrorBoundary>
                <SettingsProvider initial={initial}>
                    <App />
                </SettingsProvider>
            </ErrorBoundary>
        </React.StrictMode>,
    );
}

void boot();

// Failsafe: the window is created hidden and normally revealed from App's mount
// effect. If mount hangs or crashes before that runs, this still shows the
// window so the app can never end up running invisibly (#98). Safe to fire late
// since the inline script in index.html already painted the themed background.
setTimeout(() => {
    revealMainWindow();
}, 3000);
