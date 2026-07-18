// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readSettings, writeSetting, writeSettingsText } from "./store";
import { defaultSettings } from "./schema";

const mockInvoke = vi.mocked(invoke);

/** Stand in for the file on disk. */
let file: string | null = null;

beforeEach(() => {
    localStorage.clear();
    file = null;
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_settings") return file;
        if (cmd === "write_settings") {
            file = args!.text as string;
            return null;
        }
        return null;
    });
});

describe("reading settings.json", () => {
    it("falls back to defaults when the file does not exist", async () => {
        const { values, present, error } = await readSettings();
        expect(error).toBeNull();
        expect(values).toEqual(defaultSettings());
        expect(present.size).toBe(0);
    });

    it("distinguishes a key that is ABSENT from one set to its default", async () => {
        // This is not pedantry. The app follows the OS light/dark setting for as
        // long as the theme key is absent. If absence and default were the same
        // thing, everyone would be pinned to dark forever.
        file = `{ "editor.minimap": false }`;
        const { present } = await readSettings();
        expect(present.has("editor.minimap")).toBe(true);   // set, and happens to equal the default
        expect(present.has("appearance.theme")).toBe(false); // no opinion
    });

    it("coerces nonsense to the default without discarding the rest of the file", async () => {
        file = `{
          "appearance.theme": "chartreuse",
          "appearance.fontSize": 9000,
          "editor.wordWrap": "yes please",
          "editor.minimap": true
        }`;
        const { values, error } = await readSettings();
        expect(error).toBeNull();
        // The theme id is KEPT, not silently rewritten. It may name a theme in the
        // user's themes folder that has not been read yet, and coerce cannot tell
        // that apart from a typo without discarding the good case too. An id that
        // resolves to nothing falls back to the base theme's colors when painted,
        // and the JSON editor reports it. See schema.ts.
        expect(values["appearance.theme"]).toBe("chartreuse");
        expect(values["appearance.fontSize"]).toBe(32);    // clamped, not rejected
        expect(values["editor.wordWrap"]).toBe(true);      // wrong type -> default
        expect(values["editor.minimap"]).toBe(true);       // the valid key still lands
    });

    it("reports a parse error and runs on defaults, WITHOUT touching the file", async () => {
        const broken = `{ "editor.minimap": true,, }`;
        file = broken;

        const { values, error } = await readSettings();
        expect(error).toMatch(/line 1/);
        expect(values).toEqual(defaultSettings());
        // The file is the user's settings with a typo in it. Overwriting it with
        // defaults would be destroying their work to fix a comma.
        expect(file).toBe(broken);
        expect(mockInvoke).not.toHaveBeenCalledWith("write_settings", expect.anything());
    });

    it("accepts comments and trailing commas, like VS Code", async () => {
        file = `{
          // the theme I use at night
          "appearance.theme": "dracula",
          "editor.minimap": true,
        }`;
        const { values, error } = await readSettings();
        expect(error).toBeNull();
        expect(values["appearance.theme"]).toBe("dracula");
        expect(values["editor.minimap"]).toBe(true);
    });
});

describe("writing a setting", () => {
    it("preserves comments, key order and formatting", async () => {
        // THE property this whole module exists for. Parse-mutate-stringify would
        // pass every other test in this file and silently delete the comment.
        const original = `{
  // I like this one
  "appearance.theme": "paper",

  "editor.minimap": false
}`;
        const next = await writeSetting(original, "editor.minimap", true);

        expect(next).toContain("// I like this one");
        expect(next).toContain(`"appearance.theme": "paper"`);
        expect(next).toContain(`"editor.minimap": true`);
        // theme still comes first: the user's ordering is theirs, not ours
        expect(next.indexOf("appearance.theme")).toBeLessThan(next.indexOf("editor.minimap"));
    });

    it("adds a key that was not in the file", async () => {
        const next = await writeSetting(`{}`, "editor.wordWrap", false);
        expect(JSON.parse(next)["editor.wordWrap"]).toBe(false);
    });

    it("refuses to persist raw text that does not parse", async () => {
        await expect(writeSettingsText(`{ "editor.minimap": }`)).rejects.toThrow();
        expect(file).toBeNull(); // nothing written
    });
});

describe("a file that parses but is not a settings object", () => {
    it("is reported, not silently accepted", async () => {
        // `[]` is valid JSON. It is not settings. It used to come back error: null,
        // so no banner appeared, and the next toggle threw from inside jsonc-parser.
        file = `[]`;
        const { error, values } = await readSettings();
        expect(error).toMatch(/JSON object/);
        expect(values).toEqual(defaultSettings());
        expect(file).toBe(`[]`); // and, being an error, it is never written over
    });

    it("treats a bare number the same way", async () => {
        file = `42`;
        expect((await readSettings()).error).toMatch(/JSON object/);
    });
});
