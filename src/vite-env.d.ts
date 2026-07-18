/// <reference types="vite/client" />

// Inlined by Vite's `define` (vite.config.ts) from package.json's version.
declare const __APP_VERSION__: string;

// KaTeX ships its mhchem extension as a side-effect module that patches the
// global KaTeX macro table. There's no public type surface — we just need to
// import it for its side effects. Without this declaration, TS errors on the
// dynamic import inside MarkdownPreview.tsx.
declare module "katex/dist/contrib/mhchem.mjs";
