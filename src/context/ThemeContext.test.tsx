// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * ThemeProvider is the write side of the anti-flash contract.
 *
 * index.html paints the last theme's background before React mounts, so the webview
 * does not flash white (or the wrong color) on a launch or reload. It can only read
 * localStorage synchronously at that instant, because the real theme
 * (appearance.theme in settings.json) is behind async Tauri IPC that is not up yet.
 * So ThemeProvider MUST mirror the resolved background into localStorage on every
 * apply. This test guards that it does.
 *
 * The bug this replaced: the mirror key stopped being written when the theme moved
 * into settings.json, so the pre-paint read a key nothing wrote and silently fell
 * back to the OS light/dark default for every theme. Caching the resolved color
 * (not a theme id looked up in a hardcoded map) is what keeps it right for user
 * themes and drift-proof when a built-in theme is added.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TestProviders } from "../test/providers";
import { resolveTheme, BUILTIN_THEMES } from "../themes";

afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-type");
});

describe("ThemeProvider mirrors the theme for the anti-flash pre-paint", () => {
    it("caches the id, the light/dark type, and the resolved background of a dark theme", () => {
        render(<TestProviders settings={{ "appearance.theme": "nord" }}><div /></TestProviders>);
        expect(localStorage.getItem("dumont-theme")).toBe("nord");
        expect(localStorage.getItem("dumont-theme-type")).toBe("dark");
        expect(localStorage.getItem("dumont-theme-bg")).toBe(resolveTheme("nord")["--bg-primary"]);
        expect(document.documentElement.getAttribute("data-theme")).toBe("nord");
        expect(document.documentElement.getAttribute("data-theme-type")).toBe("dark");
    });

    it("caches a light theme with type 'light', so the pre-paint does not paint it dark", () => {
        render(<TestProviders settings={{ "appearance.theme": "solarized-light" }}><div /></TestProviders>);
        expect(localStorage.getItem("dumont-theme-type")).toBe("light");
        expect(localStorage.getItem("dumont-theme-bg")).toBe(resolveTheme("solarized-light")["--bg-primary"]);
    });

    // Every shipped theme, driven off the registry so a newly added theme is covered
    // automatically. If the cached background is always the theme's own --bg-primary,
    // adding a theme can never reintroduce the flash the old 4-entry map allowed.
    it.each(BUILTIN_THEMES.map((t) => t.id))(
        "caches %s's own background rather than a value from a map that can go stale",
        (id) => {
            render(<TestProviders settings={{ "appearance.theme": id }}><div /></TestProviders>);
            expect(localStorage.getItem("dumont-theme-bg")).toBe(resolveTheme(id)["--bg-primary"]);
        },
    );
});
