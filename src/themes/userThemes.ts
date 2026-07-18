// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * Themes the user wrote, read from `<config>/themes/<id>.json`.
 *
 * Rust lists the directory and hands back raw TEXT (see src-tauri/src/themes.rs).
 * This is the half that decides what a theme IS: it parses, validates, and turns
 * a file into a ThemeDef the registry can resolve. The split is the same one
 * settings.json uses, for the same reason: the frontend has the schema, the
 * linter, and somewhere to show an error.
 *
 * A bad theme file is skipped, never fatal. One typo in one file cannot stop the
 * others loading, and it certainly cannot stop the app starting: this runs on the
 * boot path, before the first paint.
 */
import { invoke } from "@tauri-apps/api/core";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { CODE_TOKEN_NAMES } from "./highlight";
import { THEME_TOKEN_NAMES, type ThemeDef, type ThemeTokens } from "./types";

/** What Rust gives us: the filename stem, and the file. */
interface ThemeFile {
    id: string;
    text: string;
}

export interface UserThemeProblem {
    /** The theme id, which is the filename stem. */
    id: string;
    message: string;
}

export interface LoadedUserThemes {
    themes: ThemeDef[];
    /** Files we could not use, and why. Shown to the user rather than swallowed. */
    problems: UserThemeProblem[];
}

const KNOWN_TOKENS = new Set<string>([...THEME_TOKEN_NAMES, ...CODE_TOKEN_NAMES]);

/**
 * Turn one file's text into a theme, or explain why it is not one.
 *
 * Deliberately forgiving about what it ignores and strict about what it accepts:
 * an unknown key in the file is not an error (a theme written for a later version
 * should still work), but a token that is not a token IS reported, because that is
 * a typo the author wants to know about rather than a color that silently does
 * nothing.
 */
export function parseUserTheme(file: ThemeFile): { theme?: ThemeDef; problems: UserThemeProblem[] } {
    const problems: UserThemeProblem[] = [];
    const errors: ParseError[] = [];
    const raw = parse(file.text, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
        const e = errors[0];
        const line = file.text.slice(0, e.offset).split("\n").length;
        return {
            problems: [{ id: file.id, message: `${printParseErrorCode(e.error)} at line ${line}` }],
        };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { problems: [{ id: file.id, message: "a theme must be a JSON object" }] };
    }

    const obj = raw as Record<string, unknown>;

    const tokens: ThemeTokens = {};
    const rawTokens = obj.tokens;
    if (rawTokens && typeof rawTokens === "object" && !Array.isArray(rawTokens)) {
        for (const [name, value] of Object.entries(rawTokens as Record<string, unknown>)) {
            if (typeof value !== "string") {
                problems.push({ id: file.id, message: `"${name}" must be a color written as a string` });
                continue;
            }
            if (!KNOWN_TOKENS.has(name)) {
                problems.push({ id: file.id, message: `"${name}" is not a theme token, so it will be ignored` });
                continue;
            }
            tokens[name] = value;
        }
    } else {
        problems.push({ id: file.id, message: `no "tokens" object, so this theme paints nothing` });
    }

    // `type` decides which way round the diff colors go, and which built-in the
    // theme falls back on. Anything but "light" is treated as dark, which is the
    // safer default: a dark theme misread as light is merely wrong, a light theme
    // misread as dark can put black text on a black background.
    const type = obj.type === "light" ? "light" : "dark";

    return {
        theme: {
            id: file.id,
            name: typeof obj.name === "string" && obj.name.trim() ? obj.name : file.id,
            type,
            extends: typeof obj.extends === "string" ? obj.extends : undefined,
            tokens,
        },
        problems,
    };
}

/**
 * Every theme in the themes directory.
 *
 * Never throws. With no Tauri backend (tests), or no directory, or no permission,
 * the answer is "no user themes", and the app runs on its built-ins.
 */
export async function loadUserThemes(): Promise<LoadedUserThemes> {
    let files: ThemeFile[];
    try {
        files = (await invoke<ThemeFile[]>("read_themes")) ?? [];
    } catch {
        return { themes: [], problems: [] };
    }

    const themes: ThemeDef[] = [];
    const problems: UserThemeProblem[] = [];
    for (const file of files) {
        const result = parseUserTheme(file);
        if (result.theme) themes.push(result.theme);
        problems.push(...result.problems);
    }
    return { themes, problems };
}

/** Where the themes live, for a "reveal in the file manager" button. */
export async function themesDir(): Promise<string> {
    return invoke<string>("get_themes_dir");
}
