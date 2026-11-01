import { invoke } from '@tauri-apps/api/core';

/** Header carrying the destination path. Must match `EXPORT_PATH_HEADER` in commands.rs. */
export const EXPORT_PATH_HEADER = 'x-export-path';

/**
 * Write an export to the path the user chose in the save dialog, through the
 * Rust `write_export_file` command (an atomic temp-and-rename write).
 *
 * The contents go as the raw request body, not as a JSON argument: a byte
 * array argument is serialized as a JSON array of numbers, several times the
 * size of the file. The path rides in a header, percent-encoded, because a
 * header value must be ASCII and a path need not be.
 *
 * This replaced the fs plugin's writeTextFile/writeFile, whose capability
 * granted the webview read and write access to every path on disk.
 */
export async function writeExportFile(path: string, contents: string | Uint8Array): Promise<void> {
    const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
    await invoke('write_export_file', bytes, {
        headers: { [EXPORT_PATH_HEADER]: encodeURIComponent(path) },
    });
}
