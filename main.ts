import { Plugin, Editor, MarkdownView, setIcon, TFile, debounce } from 'obsidian';
import chordHighlighterPlugin from './chordHighlighter';

// --- LOGIC ---

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Common English words that look like chords but should be ignored
const IGNORE_LIST = new Set([
    "DAMN", "DAD", "BAD", "BAG", "FADE", "FACE", "DEAF", "BEEF", "BED",
    "CAB", "CAGE", "CAFE", "BEAD", "ACID", "AGED", "BABE", "DEAD", "DEED"
]);

// Regex structure:
// Group 1: Root (A-G, optional #/b)
// Group 2: Suffix (Valid chars: m, 0-9, +, #, b, M, dim... OR slash followed by digit like 6/9)
// Group 3: Bass (Slash followed by A-G)
const CHORD_REGEX = /^([A-G][#b]?)((?:[m0-9\+#bMdimnsujag°]|(?:\/[0-9]))*)(\/[A-G][#b]?)?$/;

// Captures delimiters around tokens (parentheses, brackets, markdown syntax)
const TOKEN_WRAPPER_REGEX = /^([\({\["'\*_]*)(.*?)([\)}\]"'\*_,\.:;?!]*)$/;

class MusicLogic {
    private getNoteIndex(note: string): number {
        const normalize: {[key: string]: string} = { "Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#", "Cb": "B" };
        if (normalize[note]) note = normalize[note];
        return NOTES.indexOf(note);
    }

    private getNoteString(index: number): string {
        return NOTES[((index % 12) + 12) % 12];
    }

    // Handles tokens with surrounding punctuation, e.g., "(Am)"
    public transposeTokenInclusive(token: string, semitones: number): string {
        const match = token.match(TOKEN_WRAPPER_REGEX);
        if (!match || !match[2]) return token;

        const prefix = match[1];
        const core = match[2];
        const suffix = match[3];

        if (IGNORE_LIST.has(core.toUpperCase())) return token;

        if (CHORD_REGEX.test(core)) {
            const transposedCore = this.transposeCoreChord(core, semitones);
            return prefix + transposedCore + suffix;
        }

        return token;
    }

    private transposeCoreChord(chord: string, semitones: number): string {
        const match = chord.match(CHORD_REGEX);
        if (!match) return chord;

        const root = match[1];
        const suffix = match[2];
        const bassPart = match[3];

        let newRoot = root;
        const rootIdx = this.getNoteIndex(root);
        if (rootIdx !== -1) newRoot = this.getNoteString(rootIdx + semitones);

        let newBass = "";
        if (bassPart) {
            const bassNote = bassPart.substring(1);
            const bassIdx = this.getNoteIndex(bassNote);
            if (bassIdx !== -1) newBass = "/" + this.getNoteString(bassIdx + semitones);
            else newBass = bassPart;
        }

        return newRoot + suffix + newBass;
    }

    // Heuristic: Returns true if > 40% of valid tokens in the line appear to be chords
    public isChordLine(line: string): boolean {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length === 0) return false;

        let chordCount = 0;
        let validTokensCount = 0;

        tokens.forEach(t => {
            if (!t) return;
            validTokensCount++;

            const match = t.match(TOKEN_WRAPPER_REGEX);
            if (match && match[2]) {
                const core = match[2];

                if(IGNORE_LIST.has(core.toUpperCase())) return;

                if (CHORD_REGEX.test(core)) {
                    chordCount++;
                }
            }
        });

        if (validTokensCount === 0) return false;
        return (chordCount / validTokensCount) > 0.4;
    }
}

// --- PLUGIN CLASS ---

export default class SmartChordsPlugin extends Plugin {
    musicLogic = new MusicLogic();
    currentTransposeValueSpan: HTMLElement | null = null;

    private ignoreCacheUntil = 0;

    onload() {
        this.registerEditorExtension(chordHighlighterPlugin);

        // Initialize UI when workspace is ready
        this.app.workspace.onLayoutReady(() => {
            this.updateHeaderUI();
        });

        // Handle tab changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateHeaderUI();
            })
        );

        // Handle file open events (ensures UI updates when sidebar navigation is used)
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.updateHeaderUI();
            })
        );

        // Scan for changes on input (debounced for performance)
        this.registerEvent(
            this.app.workspace.on('editor-change', debounce(() => {
                this.updateHeaderUI();
            }, 300, true))
        );

        // Listen for frontmatter changes via other plugins/undo
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.file === file) {
                    this.syncValueFromFrontmatter(file);
                }
            })
        );
    }

    // Scans the first 500 lines to determine if the widget should be visible
    hasChords(editor: Editor): boolean {
        const lineCount = editor.lineCount();
        const scanLimit = Math.min(lineCount, 500);

        for (let i = 0; i < scanLimit; i++) {
            if (this.musicLogic.isChordLine(editor.getLine(i))) {
                return true;
            }
        }
        return false;
    }

    updateHeaderUI() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        const chordsFound = this.hasChords(view.editor);
        const actionsContainer = view.containerEl.querySelector('.view-actions');
        if (!actionsContainer) return;

        let controlContainer = actionsContainer.querySelector('.chord-transpose-control') as HTMLElement | null;
        if (!chordsFound) {
            if (controlContainer) {
                controlContainer.toggleClass('is-hidden', true);
            }
            return;
        }

        // Initialize container if it doesn't exist
        if (!controlContainer) {
            controlContainer = createEl('div', { cls: 'chord-transpose-control' });

            const btnReset = controlContainer.createEl('div', { cls: 'chord-transpose-btn chord-transpose-reset' });
            setIcon(btnReset, 'rotate-ccw');
            btnReset.onclick = () => this.resetTranspose(view);
            btnReset.ariaLabel = "Reset to 0";

            const btnDown = controlContainer.createEl('div', { cls: 'chord-transpose-btn' });
            setIcon(btnDown, 'arrow-down');
            btnDown.onclick = () => this.applyTranspose(view, -1);

            this.currentTransposeValueSpan = controlContainer.createEl('span', { cls: 'chord-transpose-value', text: '0' });

            const btnUp = controlContainer.createEl('div', { cls: 'chord-transpose-btn' });
            setIcon(btnUp, 'arrow-up');
            btnUp.onclick = () => this.applyTranspose(view, 1);

            actionsContainer.prepend(controlContainer);
        } else {
            // Update references and visibility
            this.currentTransposeValueSpan = controlContainer.querySelector('.chord-transpose-value');
            controlContainer.toggleClass('is-hidden', false);

            const btnReset = controlContainer.querySelector('.chord-transpose-reset') as HTMLElement;
            if (btnReset) btnReset.onclick = () => this.resetTranspose(view);
        }

        this.syncValueFromFrontmatter(view.file);
    }

    async resetTranspose(view: MarkdownView) {
        const file = view.file;
        if (!file) return;

        let currentValue = 0;
        if (this.currentTransposeValueSpan && this.currentTransposeValueSpan.innerText) {
            currentValue = parseInt(this.currentTransposeValueSpan.innerText.replace("+", ""));
        }

        if (currentValue !== 0) {
            await this.applyTranspose(view, -currentValue);
        }
    }

    syncValueFromFrontmatter(file: TFile | null) {
        if (!file || !this.currentTransposeValueSpan) return;

        // Prevent UI flickering by ignoring cache if a local update happened recently
        if (Date.now() < this.ignoreCacheUntil) {
            return;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        let currentTranspose = 0;

        if (cache && cache.frontmatter && cache.frontmatter.transpose) {
            currentTranspose = parseInt(cache.frontmatter.transpose);
            if (isNaN(currentTranspose)) currentTranspose = 0;
        }

        const prefix = currentTranspose > 0 ? "+" : "";
        this.currentTransposeValueSpan.innerText = `${prefix}${currentTranspose}`;
    }

    applyTranspose(view: MarkdownView, steps: number) {
        const editor = view.editor;
        if (!editor || !view.file) return;

        // 1. Determine current value (UI preferred over cache for immediate interaction)
        let currentValue = 0;
        if (this.currentTransposeValueSpan && this.currentTransposeValueSpan.innerText) {
            currentValue = parseInt(this.currentTransposeValueSpan.innerText.replace("+", ""));
        } else {
            const cache = this.app.metadataCache.getFileCache(view.file);
            if (cache && cache.frontmatter && cache.frontmatter.transpose) {
                currentValue = parseInt(cache.frontmatter.transpose);
            }
        }
        if (isNaN(currentValue)) currentValue = 0;

        let newValue = currentValue + steps;

        // Reset to 0 if a full octave is reached
        if (Math.abs(newValue) === 12) {
            newValue = 0;
        }

        // 2. Optimistic UI update and cache locking
        this.ignoreCacheUntil = Date.now() + 2000;
        if (this.currentTransposeValueSpan) {
            const prefix = newValue > 0 ? "+" : "";
            this.currentTransposeValueSpan.innerText = `${prefix}${newValue}`;
        }

        // 3. Transform Text
        const lineCount = editor.lineCount();
        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            if (line.trim() === '---') continue;

            if (this.musicLogic.isChordLine(line)) {
                const newLine = line.replace(/([^\s]+)/g, (match: string) => {
                    return this.musicLogic.transposeTokenInclusive(match, steps);
                });
                if (line !== newLine) {
                    editor.setLine(i, newLine);
                }
            }
        }

        // 4. Update Frontmatter
        this.updateFrontmatterInEditor(editor, newValue);
    }

    // Direct text replacement for frontmatter to avoid race conditions with file system events
    updateFrontmatterInEditor(editor: Editor, newValue: number) {
        const content = editor.getValue();
        const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
        const match = content.match(frontmatterRegex);

        if (match) {
            const fmContent = match[1];
            const transposeMatch = fmContent.match(/^transpose:\s*(-?\d+)/m);

            if (transposeMatch) {
                // Update existing key
                const newFmContent = fmContent.replace(/^transpose:\s*(-?\d+)/m, `transpose: ${newValue}`);
                const newFrontmatterBlock = `---\n${newFmContent}\n---`;
                editor.replaceRange(newFrontmatterBlock, {line: 0, ch: 0}, {line: 0 + match[0].split('\n').length - 1, ch: 3});
            } else {
                // Append key if missing
                const newFmContent = `${fmContent}\ntranspose: ${newValue}`;
                const newFrontmatterBlock = `---\n${newFmContent}\n---`;
                editor.replaceRange(newFrontmatterBlock, {line: 0, ch: 0}, {line: 0 + match[0].split('\n').length - 1, ch: 3});
            }
        } else {
            // Create frontmatter block
            const newFrontmatterBlock = `---\ntranspose: ${newValue}\n---\n\n`;
            editor.replaceRange(newFrontmatterBlock, {line: 0, ch: 0});
        }
    }

    onunload() {
        document.querySelectorAll('.chord-transpose-control').forEach(el => el.remove());
    }
}