import type { Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

// A drop-in for CodeMirror's highlightActiveLine() that marks the caret's line
// only while the selection is empty. The stock extension also marks the line
// holding the head of a NON-empty selection, and drawSelection paints the
// selection in a layer BEHIND the line elements, so the opaque .cm-activeLine
// background covered the selection on exactly that line: drag across a few
// paragraphs and the highlight turned from --selection-bg to --bg-hover on the
// paragraph under the pointer. VS Code drops its current-line highlight while
// text is selected for the same reason. Same class name, so the editor themes'
// .cm-activeLine rules apply unchanged.

const caretLineDeco = Decoration.line({ class: "cm-activeLine" });

function caretLines(view: EditorView): DecorationSet {
    const deco: Range<Decoration>[] = [];
    let lastLineStart = -1;
    for (const range of view.state.selection.ranges) {
        if (!range.empty) continue;
        const line = view.lineBlockAt(range.head);
        if (line.from > lastLineStart) {
            deco.push(caretLineDeco.range(line.from));
            lastLineStart = line.from;
        }
    }
    return Decoration.set(deco);
}

export const highlightCaretLine = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = caretLines(view);
        }
        update(update: ViewUpdate) {
            if (update.docChanged || update.selectionSet) this.decorations = caretLines(update.view);
        }
    },
    { decorations: (v) => v.decorations },
);
