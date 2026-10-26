/** Quick check used in the components map to short-circuit normal code rendering. */
export const isMermaidLanguage = (className: string | undefined): boolean =>
    typeof className === "string" && /\blanguage-mermaid\b/.test(className);
