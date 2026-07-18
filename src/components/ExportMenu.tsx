import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useDropdownKeyboard } from '../hooks/useDropdownKeyboard';

// The export module isn't needed for first paint, so we import it on demand to
// keep it out of the main chunk. Caching the promise means a second click — or
// HTML-then-PDF — reuses the first load.
type ExportModule = typeof import('../utils/exportUtils');
let exportModulePromise: Promise<ExportModule> | null = null;
const loadExportModule = (): Promise<ExportModule> => {
    if (!exportModulePromise) {
        exportModulePromise = import('../utils/exportUtils');
    }
    return exportModulePromise;
};

interface ExportMenuProps {
    fileName: string;
    getExportHtml?: () => string;
    onSuccess?: (format: string) => void;
    onError?: (format: string) => void;
}

type ExportFormat = 'html' | 'pdf' | 'docx';

export function ExportMenu({ fileName, getExportHtml, onSuccess, onError }: ExportMenuProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    // userThemes is threaded into the export: without it, resolveThemeStyles cannot
    // find a custom theme's id and the exported document silently falls back to the
    // built-in dark palette. See generateExportCSS.
    const { theme, font, fontSize, userThemes } = useTheme();
    const menuRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const onMenuKeyDown = useDropdownKeyboard(isOpen, panelRef, () => setIsOpen(false));

    // Close menu when clicking outside or pressing Escape
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsOpen(false);
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleKey);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen]);

    const disabled = !getExportHtml;

    const handleExport = async (format: ExportFormat) => {
        if (isExporting || !getExportHtml) return;

        // Capture HTML on demand from the visible preview
        const htmlContent = getExportHtml();
        if (!htmlContent) return;

        setIsExporting(true);
        setIsOpen(false);

        try {
            const mod = await loadExportModule();
            if (format === 'html') {
                // exportToHTML returns false when the save dialog is cancelled.
                if (await mod.exportToHTML(htmlContent, fileName, theme, font, fontSize, userThemes)) {
                    onSuccess?.('HTML');
                }
            } else if (format === 'docx') {
                // exportToDocx returns false on a cancelled save dialog.
                if (await mod.exportToDocx(htmlContent, fileName, theme, font, fontSize)) {
                    onSuccess?.('DOCX');
                }
            } else {
                const result = await mod.exportToPDF(htmlContent, fileName, theme, font, fontSize);
                // Only the native save path (Windows/macOS) can confirm a
                // written file. The Linux print-dialog fallback ('printing') is
                // its own visible feedback, so we don't claim success there.
                // 'cancelled' → stay silent.
                if (result === 'saved') onSuccess?.('PDF');
            }
        } catch (error) {
            console.error(`Failed to export ${format}:`, error);
            onError?.(format.toUpperCase());
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div ref={menuRef} className="relative no-drag">
            {/* Export Button */}
            <button
                onClick={() => !disabled && setIsOpen(!isOpen)}
                disabled={disabled || isExporting}
                aria-label="Export document"
                aria-expanded={isOpen}
                aria-haspopup="true"
                className={`btn-press flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--bg-hover)] transition-colors text-xs ${
                    disabled
                        // --text-muted stays HERE, and it is the one place in this sweep that
                        // keeps it. A disabled control has to LOOK disabled, and WCAG exempts
                        // inactive components from the contrast floor for exactly that reason
                        // (1.4.3). Raising this to --text-secondary made a disabled Export
                        // button indistinguishable from a live one, which trades a contrast
                        // number for a worse interface.
                        ? 'cursor-not-allowed text-[var(--text-muted)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title="Export document"
            >
                {isExporting ? (
                    <>
                        <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                        <span className="hidden sm:inline">Exporting...</span>
                    </>
                ) : (
                    <>
                        <span className="material-symbols-outlined text-[16px]">ios_share</span>
                        <span className="hidden sm:inline">Export</span>
                    </>
                )}
            </button>

            {/* Simple Dropdown Menu */}
            {isOpen && !disabled && (
                <div ref={panelRef} onKeyDown={onMenuKeyDown} role="menu" aria-label="Export formats" className="absolute left-0 top-full mt-1 w-40 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden z-[70] animate-fade-in-down">
                    <button
                        role="menuitem"
                        onClick={() => handleExport('html')}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-[var(--bg-hover)] transition-colors"
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[24px] text-[var(--text-muted)]">description</span>
                        <span>HTML</span>
                    </button>
                    <button
                        role="menuitem"
                        onClick={() => handleExport('pdf')}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-[var(--bg-hover)] transition-colors"
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[24px] text-[var(--text-muted)]">picture_as_pdf</span>
                        <span>PDF</span>
                    </button>
                    <button
                        role="menuitem"
                        onClick={() => handleExport('docx')}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-[var(--bg-hover)] transition-colors"
                    >
                        <span className="material-symbols-outlined text-[22px] w-6 text-center text-[var(--accent)]" aria-hidden="true">description</span>
                        <span>Word (.docx)</span>
                    </button>
                </div>
            )}
        </div>
    );
}
