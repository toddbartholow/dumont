// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { settingsCompletions, settingsLinter } from "./jsonSupport";

/** Complete at the | in the given text. */
function completeAt(withCaret: string, explicit = true) {
    const pos = withCaret.indexOf("|");
    const doc = withCaret.replace("|", "");
    const state = EditorState.create({ doc });
    return settingsCompletions(new CompletionContext(state, pos, explicit));
}

function lint(doc: string) {
    const view = new EditorView({ state: EditorState.create({ doc }) });
    const out = settingsLinter(view);
    view.destroy();
    return out;
}

describe("completion", () => {
    it("offers setting keys where a key belongs", () => {
        const r = completeAt(`{\n  |\n}`);
        const labels = r!.options.map((o) => o.label);
        expect(labels).toContain(`"editor.minimap"`);
        expect(labels).toContain(`"appearance.theme"`);
    });

    it("writes the whole pair, so the user does not have to type the value", () => {
        const r = completeAt(`{\n  |\n}`);
        const minimap = r!.options.find((o) => o.label === `"editor.minimap"`);
        expect(minimap!.apply).toBe(`"editor.minimap": false`);
    });

    it("does not offer a key the file already has", () => {
        const r = completeAt(`{\n  "editor.minimap": true,\n  |\n}`);
        const labels = r!.options.map((o) => o.label);
        expect(labels).not.toContain(`"editor.minimap"`);
        expect(labels).toContain(`"editor.wordWrap"`);
    });

    it("still offers the key currently being retyped", () => {
        // Otherwise editing an existing key completes to nothing, which reads as a
        // broken editor rather than a considered omission.
        const r = completeAt(`{\n  "appearance.th|eme": "dark"\n}`);
        expect(r!.options.map((o) => o.label)).toContain(`"appearance.theme"`);
    });

    it("offers the legal values of an enum, and nothing else", () => {
        const r = completeAt(`{\n  "appearance.theme": "|"\n}`);
        const labels = r!.options.map((o) => o.label);
        expect(labels).toContain(`"vs2017-dark"`);
        expect(labels).toContain(`"dracula"`);
        expect(labels).not.toContain(`"editor.minimap"`); // a key, in a value slot
    });

    it("offers true and false in an EMPTY boolean value slot", () => {
        // There is no value node here for the parse tree to find, so the naive
        // implementation falls through to key completion and offers a list of
        // setting keys in a slot where only a value can go.
        const r = completeAt(`{\n  "editor.minimap": |\n}`);
        expect(r!.options.map((o) => o.label).sort()).toEqual(["false", "true"]);
    });

    it("offers the themes in an EMPTY enum value slot", () => {
        const r = completeAt(`{\n  "appearance.theme": |\n}`);
        const labels = r!.options.map((o) => o.label);
        expect(labels).toContain(`"paper"`);
        expect(labels).not.toContain(`"editor.minimap"`);
    });

    it("offers values for a boolean written in place", () => {
        const r = completeAt(`{\n  "editor.minimap": t|rue\n}`);
        expect(r!.options.map((o) => o.label).sort()).toEqual(["false", "true"]);
    });
});

describe("linting", () => {
    it("passes a good file", () => {
        expect(lint(`{\n  "appearance.theme": "dracula",\n  "editor.minimap": true\n}`)).toEqual([]);
    });

    it("flags an unknown key as a WARNING, not an error", () => {
        // Unknown keys are ignored by the app, not fatal. A setting from a newer
        // version, or a scratch key, must not be presented as a broken file.
        const [d] = lint(`{\n  "editor.nonsense": true\n}`);
        expect(d.severity).toBe("warning");
        expect(d.message).toMatch(/Unknown setting/);
    });

    it("flags a theme that does not exist, and lists the ones that do", () => {
        const [d] = lint(`{\n  "appearance.theme": "chartreuse"\n}`);
        expect(d.message).toContain("vs2017-dark");
    });

    it("flags a font size outside its range", () => {
        const [d] = lint(`{\n  "appearance.fontSize": 900\n}`);
        expect(d.message).toMatch(/between 11 and 32/);
    });

    it("flags the wrong type", () => {
        const [d] = lint(`{\n  "editor.minimap": "yes"\n}`);
        expect(d.message).toMatch(/expects true or false/);
    });

    it("underlines the offending value, not the whole line", () => {
        const doc = `{\n  "appearance.fontSize": 900\n}`;
        const [d] = lint(doc);
        expect(doc.slice(d.from, d.to)).toBe("900");
    });

    it("says nothing about comments or trailing commas", () => {
        expect(lint(`{\n  // mine\n  "editor.minimap": true,\n}`)).toEqual([]);
    });
});
