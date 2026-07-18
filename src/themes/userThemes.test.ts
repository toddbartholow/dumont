// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect } from "vitest";
import { parseUserTheme } from "./userThemes";
import { resolveTheme } from "./index";

/** The exact file used to test this by hand, comment and all. */
const SOLARIZED = `{
  // Solarized Dark, written by hand, dropped in a folder.
  "name": "Solarized Dark",
  "type": "dark",
  "extends": "dark",
  "tokens": {
    "--bg-primary": "#002b36",
    "--bg-editor": "#002b36",
    "--text-primary": "#eee8d5",
    "--accent": "#268bd2"
  }
}`;

describe("a theme file the user wrote", () => {
    it("parses, comment and all", () => {
        const { theme, problems } = parseUserTheme({ id: "solarized", text: SOLARIZED });
        expect(problems).toEqual([]);
        expect(theme).toBeDefined();
        expect(theme!.id).toBe("solarized");
        expect(theme!.name).toBe("Solarized Dark");
        expect(theme!.extends).toBe("dark");
        expect(theme!.tokens["--bg-primary"]).toBe("#002b36");
    });

    it("actually paints: resolving it gives its colors, not the base theme's", () => {
        // The bug this catches: the theme loads, the registry finds it, and every
        // token still comes back as the base theme's, so the app looks untouched.
        const { theme } = parseUserTheme({ id: "solarized", text: SOLARIZED });
        const tokens = resolveTheme("solarized", [theme!]);

        expect(tokens["--bg-primary"]).toBe("#002b36");
        expect(tokens["--accent"]).toBe("#268bd2");
        // Inherited from `extends: "dark"`, not invented.
        expect(tokens["--bg-secondary"]).toBeDefined();
        // And it is the FULL token set, so nothing is left unstyled.
        expect(Object.keys(tokens).length).toBeGreaterThan(30);
    });
});

describe("a settings.json naming a user theme", () => {
    it("keeps the id, even before the themes directory has been read", async () => {
        // THE bug that made this feature look broken end to end. coerce() runs at
        // boot, before the themes directory is read, so at that moment "solarized"
        // names nothing the app knows about. A closed enum called that a typo and
        // rewrote it to "dark" in memory, permanently for the session: the theme
        // loaded correctly a moment later and could never be selected. The file on
        // disk was right, Rust served it, the registry resolved it, and the app
        // still painted itself black.
        const { normalize, setKnownThemeIds } = await import("../settings/schema");

        setKnownThemeIds(["dark", "light"]); // the themes directory has not answered yet
        expect(normalize({ "appearance.theme": "solarized" })["appearance.theme"]).toBe("solarized");
    });

    it("still reports an id that names no theme, rather than discarding it", async () => {
        // The typo is caught where a typo should be caught: in the editor, next to
        // the typo, once the list of themes is actually known.
        const { settingsLinter } = await import("../settings/jsonSupport");
        const { setKnownThemeIds } = await import("../settings/schema");
        const { EditorState } = await import("@codemirror/state");
        const { EditorView } = await import("@codemirror/view");

        setKnownThemeIds(["dark", "light", "solarized"]);
        const view = new EditorView({
            state: EditorState.create({ doc: `{ "appearance.theme": "solarised" }` }),
        });
        const problems = settingsLinter(view);
        view.destroy();

        expect(problems).toHaveLength(1);
        expect(problems[0].message).toContain("solarized"); // and it lists the real ones
    });
});
