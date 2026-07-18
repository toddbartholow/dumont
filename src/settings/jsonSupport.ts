// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * What makes settings.json editable by hand rather than merely writable by hand:
 * completion of the keys, and a linter that tells you what you got wrong before
 * you save it.
 *
 * Both read schema.ts. Add a setting there and it gains autocomplete, a
 * description on hover, value completion, and range checking, with nothing to
 * register here. The alternative -- a second list of keys living in the editor --
 * is the exact duplication that let the theme list drift into three copies.
 */
import { parseTree, findNodeAtOffset, type Node } from "jsonc-parser";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { SETTINGS, SETTING_BY_KEY, type SettingDef } from "./schema";

/** The literal text a setting's value takes when freshly inserted. */
function sampleValue(def: SettingDef): string {
    switch (def.type) {
        case "boolean":
            return String(def.default);
        case "number":
            return String(def.default);
        default:
            return JSON.stringify(def.default);
    }
}

/** Keys already written in the document, so completion does not offer them twice. */
function existingKeys(text: string): Set<string> {
    const root = parseTree(text);
    const out = new Set<string>();
    if (root?.type === "object") {
        for (const prop of root.children ?? []) {
            const name = prop.children?.[0]?.value;
            if (typeof name === "string") out.add(name);
        }
    }
    return out;
}

/** The value options for one setting, or null if it has none worth offering. */
function valueOptions(def: SettingDef) {
    const enumValues = def.known?.() ?? def.options;
    if (def.type === "enum" && enumValues) {
        return enumValues.map((o) => ({
            label: JSON.stringify(o),
            type: "enum",
            detail: o === def.default ? "default" : undefined,
        }));
    }
    if (def.type === "boolean") {
        return [
            { label: "true", type: "keyword" },
            { label: "false", type: "keyword" },
        ];
    }
    return null;
}

/**
 * The setting whose value slot is empty and waiting at `pos`, as in
 * `"editor.minimap": |`.
 *
 * There is no value NODE to find in that case, so the tree cannot answer this and
 * the text has to. Without it the caret falls through to key completion and the
 * editor offers a list of SETTING KEYS in a slot where only a value can go, which
 * is worse than offering nothing at all.
 */
function keyAwaitingValue(text: string, pos: number): SettingDef | undefined {
    let i = pos - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (text[i] !== ":") return undefined;
    i--;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (text[i] !== '"') return undefined;

    const end = i;
    i--;
    while (i >= 0 && text[i] !== '"') i--;
    if (i < 0) return undefined;

    return SETTING_BY_KEY.get(text.slice(i + 1, end));
}

/**
 * Complete setting keys, and the values of enum and boolean settings.
 *
 * The position matters: inside a string that is a property NAME we offer keys,
 * and in the value slot of a known key we offer that key's legal values. Getting
 * this wrong would offer theme names where a key belongs, which is worse than
 * offering nothing.
 */
export function settingsCompletions(ctx: CompletionContext): CompletionResult | null {
    const text = ctx.state.doc.toString();
    const root = parseTree(text);
    if (!root) return null;

    // An empty value slot, before anything has been typed into it.
    const awaiting = keyAwaitingValue(text, ctx.pos);
    if (awaiting) {
        const options = valueOptions(awaiting);
        return options ? { from: ctx.pos, to: ctx.pos, options } : null;
    }

    const node = findNodeAtOffset(root, ctx.pos, true);
    const parent = node?.parent;

    // In the value slot of "some.key": <here>
    if (node && parent?.type === "property" && parent.children?.[1] === node) {
        const key = parent.children?.[0]?.value;
        const def = typeof key === "string" ? SETTING_BY_KEY.get(key) : undefined;
        if (!def) return null;

        const options = valueOptions(def);
        return options
            ? { from: node.offset, to: node.offset + node.length, options }
            : null;
    }

    // A property NAME, or an empty slot where one could go.
    const keyNode =
        node && node.type === "string" && parent?.type === "property" && parent.children?.[0] === node
            ? node
            : null;
    const word = ctx.matchBefore(/"[^"]*"?|\w*/);
    if (!keyNode && !ctx.explicit && (!word || word.from === word.to)) return null;

    const taken = existingKeys(text);
    const inKeyString = keyNode !== null;
    const from = keyNode ? keyNode.offset : (word?.from ?? ctx.pos);
    const to = keyNode ? keyNode.offset + keyNode.length : ctx.pos;

    // A key already in the file is not offered again, EXCEPT the one being retyped:
    // completing "appearance.th" back to itself must not come up empty.
    const options = SETTINGS.filter((s) => !taken.has(s.key) || keyNode?.value === s.key).map(
        (s) => ({
            label: JSON.stringify(s.key),
            type: "property",
            detail: s.type,
            info: s.description,
            // Inside an existing string, replace just the string. On a bare line,
            // write the whole pair so the user does not have to type `": value`.
            apply: inKeyString ? JSON.stringify(s.key) : `${JSON.stringify(s.key)}: ${sampleValue(s)}`,
        }),
    );
    return options.length ? { from, to, options } : null;
}

/**
 * Report what is wrong with the file, in the file, where it is wrong.
 *
 * Three classes of problem, deliberately at two severities:
 *  - it does not parse. An error: nothing can be saved.
 *  - a key the app does not know. A WARNING, not an error. Unknown keys are
 *    ignored, not fatal, and flagging them as errors would punish a user for a
 *    setting from a newer version or a comment-like scratch key.
 *  - a value of the wrong type, outside its range, or not one of the legal enum
 *    values. A warning too: the app falls back to the default for that one key and
 *    keeps running, so the file is usable, just not doing what its author thinks.
 */
export function settingsLinter(view: EditorView): Diagnostic[] {
    const text = view.state.doc.toString();
    const out: Diagnostic[] = [];

    const root = parseTree(text, [], { allowTrailingComma: true });
    if (!root || root.type !== "object") {
        if (text.trim()) {
            out.push({ from: 0, to: Math.min(text.length, 1), severity: "error", message: "Settings must be a JSON object." });
        }
        return out;
    }

    for (const prop of root.children ?? []) {
        const keyNode = prop.children?.[0];
        const valueNode = prop.children?.[1];
        const key = keyNode?.value;
        if (typeof key !== "string" || !keyNode) continue;

        const def = SETTING_BY_KEY.get(key);
        if (!def) {
            out.push({
                from: keyNode.offset,
                to: keyNode.offset + keyNode.length,
                severity: "warning",
                message: `Unknown setting "${key}". It will be ignored.`,
            });
            continue;
        }
        if (!valueNode) continue;

        const problem = valueProblem(def, valueNode);
        if (problem) {
            out.push({
                from: valueNode.offset,
                to: valueNode.offset + valueNode.length,
                severity: "warning",
                message: problem,
            });
        }
    }
    return out;
}

/** The complaint about one value, or null if it is fine. */
function valueProblem(def: SettingDef, node: Node): string | null {
    const v = node.value;
    switch (def.type) {
        case "boolean":
            return typeof v === "boolean" ? null : `"${def.key}" expects true or false. Using ${def.default}.`;
        case "number": {
            if (typeof v !== "number") return `"${def.key}" expects a number. Using ${def.default}.`;
            const lo = def.min ?? -Infinity;
            const hi = def.max ?? Infinity;
            if (v < lo || v > hi) return `"${def.key}" must be between ${lo} and ${hi}. It will be clamped.`;
            if (def.integer && !Number.isInteger(v)) {
                return `"${def.key}" must be a whole number. It will be rounded to ${Math.round(v)}.`;
            }
            return null;
        }
        case "enum": {
            if (typeof v !== "string") return `"${def.key}" expects a string. Using "${def.default}".`;
            if (!v.trim()) return `"${def.key}" cannot be empty. Using "${def.default}".`;
            // An open enum with a RUNTIME list (the theme) is still validated: an id
            // that names no theme paints nothing, so it is a real mistake. The list
            // is the built-ins plus whatever loaded from the themes directory.
            if (def.known) {
                const known = def.known();
                return known.includes(v)
                    ? null
                    : `"${v}" is not a theme. Available: ${known.join(", ")}.`;
            }
            // An open enum with no list (the font) accepts anything installed on the
            // machine, so an unfamiliar value is not a mistake.
            if (def.open) return null;
            if (!def.options?.includes(v)) {
                return `"${def.key}" must be one of: ${def.options?.join(", ")}. Using "${def.default}".`;
            }
            return null;
        }
        case "string":
            return typeof v === "string" ? null : `"${def.key}" expects a string. Using "${def.default}".`;
    }
}
