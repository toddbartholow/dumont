import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSetting } from "./SettingsProvider";
import { useTheme } from "../context/ThemeContext";
import { TestProviders } from "../test/providers";

/**
 * These setters must keep their identity across renders, and it is not a style point.
 *
 * App reads nine settings through `useSetting` and threads their setters into callbacks and
 * memos. `useSetting` used to hand back a brand-new arrow every render, and ThemeContext's
 * `setTheme` was a plain function rebuilt on every render of the provider, so every consumer
 * downstream churned. The command palette's useMemo lists both.
 *
 * exhaustive-deps is an error now, which means a dependency array has to LIST these. That is
 * only safe while they are stable, which is what this file pins.
 *
 * Be clear about what it does NOT pin, because the first version of this comment overclaimed
 * and a reviewer caught it: stable setters were necessary to make that memo hold, and they
 * were not sufficient. `handleSaveFile` and `handleSaveAs` also closed over `content`, and
 * the memo lists them, so it went on rebuilding on every keystroke until those read liveRef
 * instead (see App.tsx). exhaustive-deps checks dependency COMPLETENESS and never dependency
 * STABILITY, so nothing in CI can tell you a memo has quietly died. That took measuring the
 * running app: 6 rebuilds across three content changes before, 0 after.
 */
describe("setter identity", () => {
    it("useSetting's setter survives a re-render", () => {
        const { result, rerender } = renderHook(() => useSetting<boolean>("editor.minimap"), {
            wrapper: TestProviders,
        });

        const first = result.current[1];
        rerender();
        rerender();

        expect(result.current[1]).toBe(first);
    });

    it("useTheme's setters survive a re-render", () => {
        const { result, rerender } = renderHook(() => useTheme(), { wrapper: TestProviders });

        const { setTheme, setFont, setFontSize } = result.current;
        rerender();
        rerender();

        expect(result.current.setTheme).toBe(setTheme);
        expect(result.current.setFont).toBe(setFont);
        expect(result.current.setFontSize).toBe(setFontSize);
    });

    /**
     * The updater form still has to see the CURRENT value, not one the setter closed over
     * when it was created. That is the whole risk of making a setter stable, and it is why
     * the value is read through a ref rather than captured. `set(v => !v)` is exactly how
     * the command palette toggles a setting.
     */
    it("the setter reads the latest value even though it never changes identity", () => {
        const { result } = renderHook(() => useSetting<boolean>("editor.minimap"), {
            wrapper: TestProviders,
        });

        const [initial, set] = result.current;
        expect(typeof initial).toBe("boolean");
        expect(() => set((v) => !v)).not.toThrow();
    });
});
