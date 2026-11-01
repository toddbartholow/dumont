import { useEffect, useRef, useState, memo } from "react";
import { useTheme } from "../context/useTheme";
import { themeType, type ThemeDef } from "../themes";
import { sanitizeDiagramSvg } from "../utils/diagramSanitize";

// Single shared mermaid module promise — loaded only on first use.
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;

const loadMermaid = (): Promise<typeof import("mermaid")["default"]> => {
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = import("mermaid").then((m) => {
        const mermaid = m.default;
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict", // disallow embedded scripts
            theme: "dark",
            fontFamily: "var(--font-body)",
        });
        return mermaid;
    });
    return mermaidPromise;
};

// Map the app theme to the closest built-in mermaid theme so diagrams match the
// surrounding UI. Dracula is a dark theme (was getting the light "default"), and
// Paper's warm light tone reads better with mermaid's softer "neutral" than the
// stark "default". PREVIEW-03.
//
// Darkness is ASKED FOR, not listed. This was a switch over theme ids with a
// `default: "default"` arm, so every dark theme added after it was written fell
// through to the LIGHT mermaid theme: a white diagram on a black page. Only the
// registry knows a theme's type, and it knows it for user themes too, which a
// literal list here could never have covered.
const themeToMermaid = (t: string, userThemes: readonly ThemeDef[]): "default" | "dark" | "neutral" => {
    if (themeType(t, userThemes) === "dark") return "dark";
    // The warm light themes: mermaid's "neutral" is softer than the stark "default"
    // and sits better on a cream page.
    if (t === "paper" || t === "solarized-light") return "neutral";
    return "default";
};

// Cache rendered SVG keyed by theme + source. Without this, a doc re-renders
// (every debounce tick, or when react-markdown remounts the block because blocks
// above it changed height while typing) re-run mermaid.render() — a full SVG
// layout pass — for diagrams the user never touched. Cache hits are instant.
// Bounded LRU-ish: evict the oldest when over the cap. PREVIEW-03.
const svgCache = new Map<string, string>();
const SVG_CACHE_CAP = 64;

let nextMermaidId = 0;

interface MermaidBlockProps {
    code: string;
}

function MermaidBlockImpl({ code }: MermaidBlockProps) {
    // Subscribe to the app theme so diagrams re-render on light/dark switches —
    // previously mermaid.initialize ran once for the app lifetime, so existing
    // diagrams kept their original theme after a switch. PREVIEW-03.
    const { theme, userThemes } = useTheme();
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const idRef = useRef<string>(`dumont-mermaid-${++nextMermaidId}`);

    useEffect(() => {
        let cancelled = false;
        setError(null);
        const mermaidTheme = themeToMermaid(theme, userThemes);
        const cacheKey = `${mermaidTheme}\u0000${code}`;
        const cached = svgCache.get(cacheKey);
        if (cached !== undefined) {
            setSvg(cached);
            return;
        }
        loadMermaid()
            .then((mermaid) => {
                // Re-apply theme before rendering so diagrams follow the active
                // theme. initialize() is global, but the app theme is uniform so
                // concurrent blocks all want the same value.
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: "strict",
                    theme: mermaidTheme,
                    fontFamily: "var(--font-body)",
                });
                return mermaid.render(idRef.current, code);
            })
            .then((result) => {
                if (cancelled) return;
                // Sanitized once, before it is cached, so a cache hit is never
                // the raw render. Same pass the exports run (utils/diagramSanitize).
                const clean = sanitizeDiagramSvg(result.svg);
                svgCache.set(cacheKey, clean);
                if (svgCache.size > SVG_CACHE_CAP) {
                    const oldest = svgCache.keys().next().value;
                    if (oldest !== undefined) svgCache.delete(oldest);
                }
                setSvg(clean);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : "Diagram failed to render";
                setError(msg);
            });
        return () => { cancelled = true; };
    }, [code, theme, userThemes]);

    if (error) {
        return (
            <div className="my-4 p-4 border border-[var(--danger)] rounded-lg bg-[var(--bg-secondary)]">
                <div className="text-sm font-semibold text-[var(--danger)] mb-1">Mermaid error</div>
                <div className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap">{error}</div>
                <pre className="mt-2 text-xs opacity-70 overflow-x-auto">{code}</pre>
            </div>
        );
    }

    if (!svg) {
        return (
            <div className="my-4 p-4 border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-secondary)] animate-pulse text-xs text-[var(--text-secondary)] text-center">
                Rendering diagram…
            </div>
        );
    }

    return (
        <div
            className="my-4 flex justify-center mermaid-rendered overflow-x-auto"
            // mermaid renders with securityLevel: strict, and its SVG has also been
            // through DOMPurify (sanitizeDiagramSvg above) before it gets here.
            dangerouslySetInnerHTML={{ __html: svg }}
        />
    );
}

// Memoized so a parent re-render with unchanged `code` skips re-running the
// effect entirely (the cache covers remounts; memo covers same-position renders).
export const MermaidBlock = memo(MermaidBlockImpl);
