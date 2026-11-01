import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHTML } from "./exportUtils";

// Read from disk: vitest stubs CSS imports (even ?raw) to an empty string.
const appCss = readFileSync(resolve(__dirname, "../index.css"), "utf8");

// One task item used to strip the bullet from every item in its list, in the
// reader (ul.contains-task-list { list-style: none }) and in exports.
describe("task list bullets", () => {
    it("hides the bullet on task items only, in the reader", () => {
        expect(appCss).not.toMatch(/ul\.contains-task-list\s*\{[^}]*list-style/);
        expect(appCss).toMatch(/li\.task-list-item\s*\{[^}]*list-style-type:\s*none/);
    });

    it("hides the bullet on task items only, in exports", () => {
        const css = generateHTML("<p>x</p>", "t", "light", "inter", 16, []);
        expect(css).not.toMatch(/contains-task-list\s*\{[^}]*list-style/);
        expect(css).toMatch(/li\.task-list-item\s*\{[^}]*list-style-type:\s*none/);
    });
});
