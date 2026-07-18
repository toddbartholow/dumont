// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect } from "vitest";
import { recentPathFromMenuId } from "./menuActions";

describe("Open Recent menu ids", () => {
    it("carries the path, so opening it needs no lookup", () => {
        expect(recentPathFromMenuId("file.recent:/Users/x/notes/todo.md")).toBe("/Users/x/notes/todo.md");
    });

    it("does not mistake the menu's OWN items for a file", () => {
        // The near-miss: a check for "file.recent" without the colon matches these
        // too, and the app would try to open a file called "" or ".clear".
        expect(recentPathFromMenuId("file.recent.clear")).toBeNull();
        expect(recentPathFromMenuId("file.recent.none")).toBeNull();
        expect(recentPathFromMenuId("file.recent:")).toBeNull();
    });

    it("ignores unrelated menu ids", () => {
        expect(recentPathFromMenuId("file.open")).toBeNull();
        expect(recentPathFromMenuId("view.palette")).toBeNull();
    });
});
