import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightCaretLine } from "./caretLine";
import { installCodeMirrorDomPolyfills } from "../test/codemirrorDom";

beforeAll(installCodeMirrorDomPolyfills);

let view: EditorView | null = null;
afterEach(() => {
    view?.destroy();
    view = null;
});

const DOC = "first paragraph\n\nsecond paragraph\nthird";

function mount(multi = false): EditorView {
    view = new EditorView({
        parent: document.body,
        state: EditorState.create({
            doc: DOC,
            extensions: [highlightCaretLine, EditorState.allowMultipleSelections.of(multi)],
        }),
    });
    return view;
}

function markedLines(v: EditorView): string[] {
    return Array.from(v.contentDOM.querySelectorAll(".cm-activeLine")).map((el) => el.textContent ?? "");
}

describe("highlightCaretLine", () => {
    it("marks the caret's line when the selection is empty", () => {
        const v = mount();
        v.dispatch({ selection: { anchor: DOC.indexOf("second") + 3 } });
        expect(markedLines(v)).toEqual(["second paragraph"]);
    });

    // The bug: the opaque line background covered the selection layer on the
    // line holding the selection head, so a drag changed color mid-selection.
    it("marks no line while text is selected", () => {
        const v = mount();
        v.dispatch({ selection: { anchor: 2, head: DOC.indexOf("second") + 6 } });
        expect(markedLines(v)).toEqual([]);
    });

    it("comes back when the selection collapses", () => {
        const v = mount();
        v.dispatch({ selection: { anchor: 2, head: DOC.indexOf("third") } });
        v.dispatch({ selection: { anchor: DOC.indexOf("third") } });
        expect(markedLines(v)).toEqual(["third"]);
    });

    it("marks only the empty ranges of a multi-range selection", () => {
        const v = mount(true);
        v.dispatch({
            selection: EditorSelection.create([
                EditorSelection.range(0, 5),
                EditorSelection.cursor(DOC.indexOf("third") + 1),
            ]),
        });
        expect(markedLines(v)).toEqual(["third"]);
    });
});
