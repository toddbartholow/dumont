/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// Standalone test config so Vitest's options/types never leak into the Tauri +
// Vite production build (vite.config.ts). Vitest uses this file in preference to
// vite.config.ts when present. QUALITY-01.
export default defineConfig({
    plugins: [react()],
    // Mirrors vite.config.ts — appVersion.ts reads this constant, so it must
    // exist under test too (there is no Tauri bridge in jsdom to fall back on).
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
        // Some @codemirror/lang-* packages carry their own nested copy of
        // @codemirror/state|view; without dedupe, vitest resolves two instances
        // and EditorState.create rejects extensions built by the other copy
        // ("Unrecognized extension value"). Vite's dep pre-bundling hides this
        // in dev/build, so it only bites in tests.
        //
        // This list MUST match vite.config.ts's, and it did not: that file deduped
        // ten packages while this one deduped five, under a comment in vite.config.ts
        // claiming the two mirror each other. The five missing ones (@codemirror/
        // commands, @codemirror/search, and the three @lezer packages) simply have no
        // nested copies today, which is the only reason the divergence never bit.
        dedupe: [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/language",
            "@codemirror/autocomplete",
            "@codemirror/commands",
            "@codemirror/lint",
            "@lezer/common",
            "@lezer/highlight",
            "@lezer/lr",
        ],
    },
    test: {
        environment: "jsdom",
        // Vitest normally hands node_modules to Node's resolver, which happily
        // loads the nested copies and ignores `resolve.dedupe` above — inline
        // the CodeMirror family so the deduped Vite resolution is used. @lezer is
        // in the pattern because the dedupe list above covers it and this regex used
        // to not, so the three @lezer packages were deduped by Vite and then handed
        // to Node's resolver anyway, which is the same bug one layer down.
        server: { deps: { inline: [/@codemirror[\\/]/, /@lezer[\\/]/] } },
        setupFiles: ["./src/test/setup.ts"],
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
        css: false,
        clearMocks: true,
        restoreMocks: true,
    },
});
