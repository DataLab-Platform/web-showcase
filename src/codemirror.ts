/**
 * Typing into the CodeMirror 6 editors of DataLab Web (macros, notebook
 * cells) from the host page.
 *
 * The text goes through the editing path of a real keyboard:
 * ``document.execCommand("insertText")`` on the focused editor of the
 * iframe, which CodeMirror reads back from the DOM (``beforeinput`` /
 * mutation observer) as user input. Typed one character at a time, its
 * auto-closed brackets and quotes are typed over by the closing character,
 * so the final text is verbatim; the result is checked against the
 * expected document all the same.
 *
 * Fallback, when ``execCommand`` is unavailable or the text differs: the
 * ``EditorView`` of the editor, found through the CodeMirror DOM
 * (``cmTile`` on recent versions, ``cmView`` on older ones), receives the
 * text as transactions (``userEvent: "input.type"``), which never
 * auto-indent nor auto-close.
 */

/** The part of a CodeMirror 6 ``EditorView`` the showcase uses. */
export interface EditorViewLike {
  state: {
    doc: { length: number; toString(): string };
    selection: { main: { from: number; to: number } };
  };
  dispatch(spec: {
    changes?: { from: number; to?: number; insert?: string };
    selection?: { anchor: number; head?: number };
    userEvent?: string;
    scrollIntoView?: boolean;
  }): void;
  focus(): void;
}

/** How the characters were typed (published in ``window.__showcase``). */
export interface TypingReport {
  /** Characters inserted with ``execCommand("insertText")``. */
  execCommand: number;
  /** Characters inserted as ``EditorView`` transactions. */
  editorView: number;
  /** Typings corrected afterwards (text differing from the expected one). */
  corrections: number;
  /** Typings where ``execCommand`` was refused. */
  refused: number;
}

export const typingReport: TypingReport = {
  execCommand: 0,
  editorView: 0,
  corrections: 0,
  refused: 0,
};

interface TileLike {
  root?: { view?: unknown };
  rootView?: { view?: unknown };
  view?: unknown;
}

function isEditorView(value: unknown): value is EditorViewLike {
  const view = value as EditorViewLike | null;
  return (
    !!view &&
    typeof view.dispatch === "function" &&
    typeof view.state?.doc?.toString === "function"
  );
}

/** CodeMirror editor (``.cm-editor``) of ``el`` (inside or around it). */
export function editorElement(el: Element): HTMLElement | null {
  return (el.closest(".cm-editor") ??
    el.querySelector(".cm-editor")) as HTMLElement | null;
}

/** ``EditorView`` of a CodeMirror 6 editor, from its DOM (same lookup as
 *  ``EditorView.findFromDOM``, without importing CodeMirror). */
export function findEditorView(el: Element): EditorViewLike | null {
  const editor = editorElement(el);
  if (!editor) return null;
  const content = editor.querySelector(".cm-content");
  for (const node of [content, editor]) {
    if (!node) continue;
    const props = node as unknown as { cmTile?: TileLike; cmView?: TileLike };
    for (const tile of [props.cmTile, props.cmView]) {
      if (!tile) continue;
      for (const view of [tile.root?.view, tile.rootView?.view, tile.view]) {
        if (isEditorView(view)) return view;
      }
    }
  }
  return null;
}

/** Text of an editor: its document, else its rendered lines. */
export function editorText(el: Element): string {
  const view = findEditorView(el);
  if (view) return view.state.doc.toString();
  const editor = editorElement(el);
  return [...(editor?.querySelectorAll(".cm-line") ?? [])]
    .map((line) => line.textContent ?? "")
    .join("\n");
}

/**
 * Typing session in one editor: :meth:`insert` adds text at the caret,
 * :meth:`finish` checks the result (and corrects it if needed).
 */
export class CodeMirrorTyper {
  private readonly view: EditorViewLike | null;
  private readonly content: HTMLElement;
  private readonly before: string;
  private readonly after: string;
  private typed = "";
  private mode: "execCommand" | "editorView";

  constructor(
    el: Element,
    private readonly log: (message: string) => void = () => undefined,
    prefer: "execCommand" | "editorView" = "execCommand",
  ) {
    const editor = editorElement(el);
    if (!editor) throw new Error("Not a CodeMirror editor");
    this.content = (editor.querySelector(".cm-content") ??
      editor) as HTMLElement;
    this.view = findEditorView(editor);
    this.mode = prefer;
    if (this.view) {
      const { from, to } = this.view.state.selection.main;
      const doc = this.view.state.doc.toString();
      this.before = doc.slice(0, from);
      this.after = doc.slice(to);
    } else {
      this.before = editorText(editor);
      this.after = "";
    }
    this.focus();
  }

  private focus(): void {
    if (this.view) this.view.focus();
    else this.content.focus({ preventScroll: true });
  }

  /** Expected document once everything typed so far is in. */
  get expected(): string {
    return this.before + this.typed + this.after;
  }

  insert(text: string): void {
    this.typed += text;
    if (this.mode === "execCommand") {
      const doc = this.content.ownerDocument;
      if (doc.activeElement !== this.content) this.focus();
      let ok: boolean;
      try {
        ok = doc.execCommand("insertText", false, text);
      } catch {
        ok = false;
      }
      if (ok) {
        typingReport.execCommand += Array.from(text).length;
        return;
      }
      typingReport.refused += 1;
      this.log("execCommand(insertText) refused: typing through EditorView");
      this.mode = "editorView";
      // The refused text is not in: re-type it below.
    }
    if (!this.view) throw new Error("No CodeMirror EditorView to type into");
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    typingReport.editorView += Array.from(text).length;
  }

  /** Check the document against the expected text; correct it through the
   *  ``EditorView`` if they differ. Returns whether it was correct. */
  finish(): boolean {
    const actual = this.view
      ? this.view.state.doc.toString()
      : editorText(this.content);
    if (actual === this.expected) return true;
    typingReport.corrections += 1;
    let at = 0;
    while (at < actual.length && actual[at] === this.expected[at]) at += 1;
    const around = (value: string) =>
      JSON.stringify(value.slice(Math.max(0, at - 12), at + 12));
    this.log(
      `typed text differs from the expected one at ${at}: ${around(actual)} instead of ${around(this.expected)}; corrected`,
    );
    if (!this.view) return false;
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: this.expected,
      },
      selection: { anchor: this.before.length + this.typed.length },
      userEvent: "input.type",
    });
    return false;
  }
}
