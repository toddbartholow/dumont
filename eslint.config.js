// The project shipped without a linter, and it had shipped WITH one before that: the
// tree still carries eight `// eslint-disable-next-line` comments naming
// react-hooks/exhaustive-deps and @typescript-eslint/no-explicit-any, suppressing rules
// that nothing had run in a long time. They were fossils.
//
// That matters more here than in most codebases. App.tsx alone holds 66 useCallback, 19
// useEffect, 12 useMemo and 18 useRef, and its entire defence against stale closures is
// a human reading dependency arrays. One had already rotted unnoticed: the command
// palette's useMemo lists an unstable setter, so it rebuilt on every keystroke, while
// the comment above it explains at length why that must never happen.
//
// exhaustive-deps is therefore an ERROR, not a warning. A warning in a project with no
// lint step in CI is a comment.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
    {
        // Build output, deps, and the Rust target dir. Nothing here is ours to lint.
        ignores: ["dist", "node_modules", "src-tauri/target", "coverage"],
    },
    {
        // A suppression that no longer suppresses anything is an error, not a shrug. The
        // eight this project already carried are the argument: they named rules nothing
        // had run in a long time, so a reader had no way to tell which of them were still
        // holding something back and which were just litter. This makes that impossible to
        // reintroduce, and it means every remaining `eslint-disable` in the tree is one
        // that is genuinely doing a job.
        linterOptions: {
            reportUnusedDisableDirectives: "error",
        },
    },
    {
        files: ["**/*.{ts,tsx}"],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2022,
            globals: {
                ...globals.browser,
                // Injected by Vite's `define` (see vite.config.ts). appVersion.ts reads it.
                __APP_VERSION__: "readonly",
            },
        },
        plugins: {
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,

            // THE rule this whole config exists for. See the header.
            "react-hooks/exhaustive-deps": "error",

            // The four rules below are new in eslint-plugin-react-hooks v7, and they come
            // from the React Compiler rather than from the classic hooks lint. They are
            // OFF, on purpose, and this is the one judgement call in this file.
            //
            // Between them they raise 77 errors, and almost all of them are the SAME
            // pattern: a ref written during render so that a window listener can read the
            // latest state without being torn down and re-added on every keystroke
            // (`tabsRef.current = tabs`), and a setState in an effect that syncs one piece
            // of state to another. That pattern is not an accident here; it is written
            // down and argued for, and useGlobalShortcuts exists because of it.
            //
            // Turning these on would not be "adding a linter", it would be a mandate to
            // re-architect a 2400-line component, and it would arrive as 77 errors with no
            // way to land the linter first. The honest sequence is: get exhaustive-deps
            // enforced now, decompose App.tsx, then come back and switch these on against a
            // codebase that can actually satisfy them. Leaving them as warnings instead
            // would just train everyone to ignore lint output.
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/immutability": "off",
            "react-hooks/preserve-manual-memoization": "off",

            // An unused variable is usually a half-finished edit. `_`-prefixed ones are
            // deliberate (exportToPDF takes a `_theme` it ignores on purpose, because a
            // PDF is always printed in the light theme).
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],

            // Fast Refresh only works when a module exports components and nothing else.
            // A warning, not an error: it is a dev-experience rule, and breaking the
            // build over it would be out of proportion.
            "react-refresh/only-export-components": [
                "warn",
                { allowConstantExport: true },
            ],
        },
    },
    {
        // Tests may reach for `any` when they are deliberately feeding a function
        // something its types forbid, which is exactly what a test should be free to do.
        files: ["**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        // Config files run in Node, not the browser.
        files: ["*.config.{ts,js}", "scripts/**/*.{ts,js}"],
        languageOptions: { globals: { ...globals.node } },
        rules: {
            // `/// <reference types="vitest/config" />` is the pattern Vitest itself
            // documents for pulling its `test` key into the Vite config's types. There is
            // no import form that does the same job.
            "@typescript-eslint/triple-slash-reference": "off",
        },
    },
);
