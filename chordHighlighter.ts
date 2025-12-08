import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// same as in main.ts
const IGNORE_LIST = new Set([
    "DAMN", "DAD", "BAD", "BAG", "FADE", "FACE", "DEAF", "BEEF", "BED",
    "CAB", "CAGE", "CAFE", "BEAD", "ACID", "AGED", "BABE", "DEAD", "DEED"
]);

const CHORD_REGEX = /^([A-G][#b]?)((?:[m0-9+#bMdimnsujag°]|(?:\/[0-9]))*)(\/[A-G][#b]?)?$/;
const TOKEN_WRAPPER_REGEX = /^([({["'*_]*)(.*?)([)}\]"'*_,.:;?!]*)$/;

function isChordLine(lineText: string): boolean {
    const tokens = lineText.trim().split(/\s+/);
    if (tokens.length === 0) return false;
    let chordCount = 0;
    let validCount = 0;

    tokens.forEach(t => {
        if(!t) return;
        validCount++;
        const match = t.match(TOKEN_WRAPPER_REGEX);
        if (match && match[2]) {
            if (IGNORE_LIST.has(match[2].toUpperCase())) return;
            if (CHORD_REGEX.test(match[2])) chordCount++;
        }
    });
    return validCount > 0 && (chordCount / validCount) > 0.4;
}

const chordDecoration = Decoration.mark({ class: "cm-smart-chord" });

const chordHighlighterPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = this.buildDecorations(view); }
        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) this.decorations = this.buildDecorations(update.view);
        }

        buildDecorations(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();

            for (let { from, to } of view.visibleRanges) {
                const startLine = view.state.doc.lineAt(from);
                const endLine = view.state.doc.lineAt(to);

                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = view.state.doc.line(i);
                    const text = line.text;

                    if (isChordLine(text)) {
                        const tokenRegex = /([^\s]+)/g;
                        let match;
                        while ((match = tokenRegex.exec(text)) !== null) {
                            const fullToken = match[1];
                            const tokenStart = line.from + match.index;

                            const wrapperMatch = fullToken.match(TOKEN_WRAPPER_REGEX);
                            if (wrapperMatch && wrapperMatch[2]) {
                                const prefix = wrapperMatch[1];
                                const core = wrapperMatch[2];

                                // Ignore Check
                                if (!IGNORE_LIST.has(core.toUpperCase())) {
                                    if (CHORD_REGEX.test(core)) {
                                        const coreStart = tokenStart + prefix.length;
                                        const coreEnd = coreStart + core.length;
                                        builder.add(coreStart, coreEnd, chordDecoration);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return builder.finish();
        }
    },
    { decorations: v => v.decorations }
);

export default chordHighlighterPlugin;