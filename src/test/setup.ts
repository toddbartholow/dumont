// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.) and
// their TypeScript types. Loaded via vitest.config.ts `setupFiles`.
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Unmount whatever the last test rendered. React Testing Library only registers
// this for you when `globals: true`, and this project runs with explicit imports
// instead, so without this line NOTHING unmounts and every render piles up in the
// same jsdom document.
//
// The suite was not merely untidy because of it, it was passing on luck: with
// `--sequence.shuffle`, seeds 777 and 98765 fail (`AIBubble.test.tsx` finds two
// "Continue" buttons, one of them left behind by an earlier file) while seed 42
// passes. Four files had noticed and were calling `afterEach(cleanup)` themselves;
// the rest had not. Doing it HERE means a new test file cannot forget, which is the
// only version of this fix that stays fixed.
//
// The worst leak was `useAutosave.test.ts`: leaked hooks each holding a live
// debounce timer, under fake timers, in a file asserting exact save counts.
afterEach(cleanup);

// There is no Tauri backend under jsdom. SettingsProvider writes settings.json
// through invoke(), and a component test that toggles a setting must not fail on
// the absence of a filesystem. Individual tests still override these when they
// care about what was invoked.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => { }) }));

// Node >= 22 ships an experimental global `localStorage` that is `undefined`
// unless the process is started with --localstorage-file — and because the
// property already exists on globalThis, it shadows the working implementation
// jsdom would otherwise provide. Every suite that touches persistence
// (ThemeContext, persistence.ts) then crashes with "Cannot read properties of
// undefined". Install a functional in-memory Storage whenever the global is
// broken.
// jsdom implements no layout, so it has no scrollIntoView. Listboxes call it to
// keep the active option in view while arrowing.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => { };
}

// jsdom ships no ResizeObserver; components that watch their own box (the
// minimap, the editor's narrow-pane guard) construct one on mount.
if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
        observe() { }
        unobserve() { }
        disconnect() { }
    } as unknown as typeof ResizeObserver;
}

if (globalThis.localStorage == null) {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
        get length() {
            return store.size;
        },
        clear: () => store.clear(),
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        removeItem: (key: string) => {
            store.delete(key);
        },
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
    };
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
}
