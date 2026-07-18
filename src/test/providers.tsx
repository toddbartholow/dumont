// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The provider stack a component sees in the real app, for tests.
 *
 * ThemeProvider reads the theme, font and size from settings.json through
 * SettingsProvider, so a component that consumes the theme cannot be rendered
 * without both. Tests pass settings in directly rather than reaching for the
 * file: there is no Tauri backend under jsdom, and a test that wanted a specific
 * font should say so rather than depend on what happens to be on disk.
 */
import type { ReactNode } from "react";
import { SettingsProvider } from "../settings/SettingsProvider";
import { ThemeProvider } from "../context/ThemeContext";
import { defaultSettings, type Settings } from "../settings/schema";

interface Props {
    children: ReactNode;
    /** Overrides on top of the defaults, e.g. { "editor.minimap": true }. */
    settings?: Partial<Settings>;
}

export function TestProviders({ children, settings }: Props) {
    // `as Settings`: the spread of a Partial widens every value to `| undefined`
    // at the type level, but defaultSettings() supplies every key, so the result is
    // in fact a complete Settings. The overrides only replace present keys.
    const values = { ...defaultSettings(), ...settings } as Settings;
    return (
        <SettingsProvider
            initial={{
                values,
                // Every key counts as explicitly set: a test that asks for a theme
                // wants that theme, not the OS's opinion of one.
                present: new Set(Object.keys(values)),
                text: JSON.stringify(values, null, 2),
                error: null,
            }}
        >
            <ThemeProvider>{children}</ThemeProvider>
        </SettingsProvider>
    );
}
