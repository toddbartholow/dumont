import { describe, it, expect } from "vitest";
import { SETTING_BY_KEY, coerce, type SettingDef } from "./schema";

const def = (key: string): SettingDef => {
    const d = SETTING_BY_KEY.get(key);
    if (!d) throw new Error(`no such setting: ${key}`);
    return d;
};

describe("defaults", () => {
    /**
     * Version history is the only feature that would write to the user's disk on its
     * own, keeping a second copy of every document they save in a directory they have
     * never heard of. That is theirs to opt into. The History panel has a first-class
     * OFF state that says so and enables it in a click, which is what makes the
     * default defensible; if this ever flips back to true, that reasoning has to flip
     * with it.
     */
    it("keeps version history off until the user asks for it", () => {
        expect(def("files.history").default).toBe(false);
    });

    /**
     * The AI assistant is off too. Dumont is a prose editor first, and the writer who
     * opens a Markdown file has not asked for an assistant. The flag gates the
     * titlebar button, the panel, the palette entries and Alt+J, so off means there is
     * no AI surface in the app at all rather than a dormant one.
     */
    it("keeps the AI assistant off until the user asks for it", () => {
        expect(def("ai.enabled").default).toBe(false);
        // And it opens onto nothing even once enabled, until it is configured.
        expect(def("ai.endpoint").default).toBe("");
        expect(def("ai.model").default).toBe("");
    });

    /**
     * Word wrap is the ONLY boolean on out of the box, and it is the one that changes
     * nothing outside the viewport: no disk, no network, no new UI. This is the
     * tripwire for the next setting somebody adds with `default: true` without meaning
     * it. If a new one belongs here, add it deliberately and say why.
     */
    it("turns on nothing else at all", () => {
        const on = [...SETTING_BY_KEY.values()]
            .filter((d) => d.type === "boolean" && d.default === true)
            .map((d) => d.key)
            .sort();

        expect(on).toEqual(["editor.wordWrap"]);
    });
});

describe("coerce", () => {
    it("clamps a number to its bounds rather than rejecting it", () => {
        expect(coerce(def("files.historyLimit"), 9999)).toBe(500);
        expect(coerce(def("files.historyLimit"), 1)).toBe(5);
    });

    it("falls back to the default for a value of the wrong type", () => {
        expect(coerce(def("files.historyLimit"), "lots")).toBe(50);
        expect(coerce(def("files.historyInterval"), NaN)).toBe(60);
    });

    /**
     * THE test for `integer`. These two values are handed to Rust as a `usize` and a
     * `u64`, and serde REJECTS a float for an integer type: the command fails while
     * deserializing its arguments, so none of our code runs, and the rejection is
     * swallowed by the best-effort catch in recordSnapshot. A `0.5` typed into the
     * JSON editor is inside the 0-3600 bounds, so the linter passes it too. The whole
     * of version history would then be switched on, report nothing wrong, and never
     * record another snapshot for as long as the value sat there.
     */
    it("rounds an integer setting, because a float would silently break the IPC call", () => {
        expect(coerce(def("files.historyInterval"), 0.5)).toBe(1);
        expect(coerce(def("files.historyInterval"), 59.4)).toBe(59);
        expect(coerce(def("files.historyLimit"), 10.6)).toBe(11);

        expect(Number.isInteger(coerce(def("files.historyInterval"), 30.7))).toBe(true);
        expect(Number.isInteger(coerce(def("files.historyLimit"), 22.2))).toBe(true);
    });

    it("rounds after clamping, so a fractional out-of-range value is still an integer", () => {
        const v = coerce(def("files.historyLimit"), 9999.7);
        expect(v).toBe(500);
        expect(Number.isInteger(v)).toBe(true);
    });

    /**
     * Every number setting that crosses IPC into Rust must carry `integer`. This test
     * is the tripwire for the NEXT one somebody adds: it is not enough to know the
     * rule, the schema has to enforce it.
     */
    it("marks every setting that Rust receives as an integer", () => {
        for (const key of ["files.historyLimit", "files.historyInterval"]) {
            expect(def(key).integer, `${key} crosses IPC into a Rust integer`).toBe(true);
        }
    });

    it("leaves a number setting that never reaches Rust unmarked", () => {
        // The font size is consumed entirely in CSS, so a fractional px is harmless and
        // coerce must not force it to a whole number.
        expect(def("appearance.fontSize").integer).toBeUndefined();
        expect(coerce(def("appearance.fontSize"), 15.5)).toBe(15.5);
    });
});
