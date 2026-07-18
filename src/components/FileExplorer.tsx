import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { attachFocusTrap } from "../utils/focusTrap";

interface FileEntry {
    name: string;
    path: string;
    is_dir: boolean;
}

interface FileExplorerProps {
    isOpen: boolean;
    currentFilePath: string | null;
    onFileSelect: (path: string) => void;
    onClose: () => void;
}

export function FileExplorer({
    isOpen,
    currentFilePath,
    onFileSelect,
    onClose,
}: FileExplorerProps) {
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentViewDir, setCurrentViewDir] = useState<string | null>(null);
    const panelRef = useRef<HTMLElement>(null);

    // Get directory from current file path
    const getDirectory = (filePath: string | null): string | null => {
        if (!filePath) return null;
        const normalized = filePath.replace(/\\/g, "/");
        const lastSlash = normalized.lastIndexOf("/");
        return lastSlash > 0 ? filePath.substring(0, lastSlash) : null;
    };

    // Initialize the view directory when opening the panel
    useEffect(() => {
        if (isOpen && currentFilePath) {
            // Keep the current view if the user already navigated somewhere
            setCurrentViewDir((prev) => prev ?? getDirectory(currentFilePath));
        } else if (!isOpen) {
            // Reset view when closed so it snaps back to the active file next time
            setCurrentViewDir(null);
        }
    }, [isOpen, currentFilePath]);

    // Load files whenever the currentViewDir changes
    useEffect(() => {
        if (isOpen && currentViewDir) {
            loadFiles(currentViewDir);
        }
    }, [isOpen, currentViewDir]);

    // Refresh when the window regains focus — files may have been created or
    // deleted in another app while the explorer sat open. Mirrors App's
    // external-change-on-focus detection so the list never goes stale.
    useEffect(() => {
        if (!isOpen || !currentViewDir) return;
        const onFocus = () => loadFiles(currentViewDir);
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [isOpen, currentViewDir]);

    // Escape key to close and focus management + focus trap
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        panelRef.current?.focus();
        const detachTrap = attachFocusTrap(panelRef.current);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            detachTrap();
        };
    }, [isOpen, onClose]);

    const loadFiles = async (directory: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const entries = await invoke<FileEntry[]>("list_directory_files", {
                directory,
            });
            setFiles(entries);
        } catch (err) {
            console.error("Failed to load directory:", err);
            setError("Failed to load files");
        } finally {
            setIsLoading(false);
        }
    };

    const handleEntryClick = (entry: FileEntry) => {
        if (entry.is_dir) {
            // Navigate into the folder
            setCurrentViewDir(entry.path);
        } else {
            // Select the file and close
            onFileSelect(entry.path);
            onClose();
        }
    };
    
    const parentDir = currentViewDir ? getDirectory(currentViewDir) : null;

    const handleGoUp = () => {
        if (parentDir) setCurrentViewDir(parentDir);
    };

    const directoryName = currentViewDir
        ? currentViewDir.replace(/\\/g, "/").split("/").pop()
        : "Files";

    // No slide-in transition. The explorer is a thing you open to find a file and
    // close again, often several times a minute — a 200ms slide on every one of
    // those is 200ms of waiting for a list that is already in memory. It snaps.
    return (
        <aside
            ref={panelRef}
            role="navigation"
            aria-label="File explorer"
            tabIndex={-1}
            className={`fixed left-0 top-12 bottom-7 w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] z-50 shadow-2xl flex flex-col overflow-hidden ${
                isOpen ? "translate-x-0" : "-translate-x-full"
            }`}
        >
            {/* Header */}
            <div className="h-10 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-titlebar)]">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] no-select">
                    <button
                        onClick={handleGoUp}
                        disabled={!parentDir}
                        aria-label="Go up one folder"
                        title="Go up"
                        className="btn-press flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors mr-1 disabled:opacity-40 disabled:pointer-events-none"
                    >
                        <span className="material-symbols-outlined text-[18px]">
                            arrow_upward
                        </span>
                    </button>
                    <span className="material-symbols-outlined text-[18px]">
                        folder_open
                    </span>
                    <span className="truncate max-w-[140px]" title={directoryName}>{directoryName}</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => currentViewDir && loadFiles(currentViewDir)}
                        aria-label="Refresh file list"
                        title="Refresh"
                        className="btn-press flex items-center justify-center w-7 h-7 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        <span className="material-symbols-outlined text-[18px]">
                            refresh
                        </span>
                    </button>
                    <button
                        onClick={onClose}
                        aria-label="Close file explorer"
                        className="btn-press flex items-center justify-center w-7 h-7 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        <span className="material-symbols-outlined text-[18px]">
                            close
                        </span>
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {isLoading ? (
                    <div className="flex items-center justify-center h-32 text-[var(--text-secondary)] text-sm">
                        Loading...
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm" role="alert">
                        <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">error_outline</span>
                        <span className="text-[var(--danger)]">{error}</span>
                    </div>
                ) : files.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-[var(--text-secondary)]">
                        <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[var(--text-muted)]">folder_open</span>
                        <span>Folder is empty</span>
                    </div>
                ) : (
                    <ul className="py-2" role="listbox" aria-label="Files and folders">
                        {files.map((file) => {
                            const isActive = file.path === currentFilePath && !file.is_dir;
                            // No stagger-item / animationDelay here. Each row used to
                            // fade and slide in on a 30ms-per-item delay, so a folder
                            // of 20 files rippled in over ~600ms — and the file you
                            // were reaching for kept moving while you reached for it.
                            // The list is already in memory; it appears at once.
                            return (
                                <li key={file.path}>
                                    <button
                                        onClick={() => handleEntryClick(file)}
                                        role="option"
                                        aria-selected={isActive}
                                        className={`btn-press w-full px-4 py-2 text-left text-sm flex items-center gap-2 transition-colors ${
                                            isActive
                                                ? "bg-[var(--accent)] text-[var(--accent-text)]"
                                                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                        }`}
                                    >
                                        <span className="material-symbols-outlined text-[16px]">
                                            {file.is_dir ? "folder" : "description"}
                                        </span>
                                        <span className="truncate">{file.name}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </aside>
    );
}
