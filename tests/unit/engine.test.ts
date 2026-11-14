import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeMirrorTyper,
  editorText,
  findEditorView,
  typingReport,
  type EditorViewLike,
} from "../../src/codemirror";
import {
  isVisible,
  menuItemMatches,
  parseKeys,
  ShowcaseContext,
  typingChunks,
} from "../../src/engine";
import { AppBridge, AppFrame } from "../../src/frame";
import { interleave, selectScenarios } from "../../src/playlist";

/** Minimal CodeMirror ``EditorView`` (document and selection). */
function fakeView(doc: string, caret = doc.length): EditorViewLike {
  const view = {
    state: {
      doc: { length: doc.length, toString: () => doc },
      selection: { main: { from: caret, to: caret } },
    },
    dispatch(spec: Parameters<EditorViewLike["dispatch"]>[0]) {
      if (spec.changes) {
        const { from, to = from, insert = "" } = spec.changes;
        doc = doc.slice(0, from) + insert + doc.slice(to);
        view.state.doc = { length: doc.length, toString: () => doc };
      }
      if (spec.selection) {
        const at = spec.selection.anchor;
        view.state.selection = { main: { from: at, to: at } };
      }
    },
    focus() {},
  };
  return view;
}

function editor(): { root: HTMLElement; content: HTMLElement } {
  const root = document.createElement("div");
  root.className = "cm-editor";
  root.innerHTML =
    '<div class="cm-content" contenteditable="true">' +
    '<div class="cm-line">a = 1</div><div class="cm-line">b = 2</div></div>';
  document.body.appendChild(root);
  return { root, content: root.querySelector<HTMLElement>(".cm-content")! };
}

describe("CodeMirror editors", () => {
  it("find the EditorView from the DOM (recent and older versions)", () => {
    const view = fakeView("x");
    const recent = editor();
    (recent.content as unknown as { cmTile: unknown }).cmTile = {
      root: { view },
    };
    expect(findEditorView(recent.root)).toBe(view);
    expect(findEditorView(recent.content)).toBe(view);

    const older = editor();
    (older.content as unknown as { cmView: unknown }).cmView = {
      rootView: { view },
    };
    expect(findEditorView(older.content)).toBe(view);

    const none = editor();
    expect(findEditorView(none.content)).toBeNull();
    expect(editorText(none.content)).toBe("a = 1\nb = 2");
    expect(findEditorView(document.createElement("div"))).toBeNull();
  });

  it("type through the EditorView when execCommand is refused", () => {
    const view = fakeView("print()", 6);
    const { content } = editor();
    (content as unknown as { cmTile: unknown }).cmTile = { root: { view } };
    const before = { ...typingReport };
    const typer = new CodeMirrorTyper(content);
    for (const chunk of typingChunks('"a"\n\nb')) typer.insert(chunk);
    expect(view.state.doc.toString()).toBe('print("a"\n\nb)');
    expect(typer.finish()).toBe(true);
    expect(typingReport.refused).toBe(before.refused + 1);
    expect(typingReport.editorView - before.editorView).toBe(6);
  });

  it("correct a text that differs from the expected one", () => {
    const view = fakeView("");
    const { content } = editor();
    (content as unknown as { cmTile: unknown }).cmTile = { root: { view } };
    const typer = new CodeMirrorTyper(content, () => undefined, "editorView");
    typer.insert("f(");
    // An auto-closed bracket that was not typed over.
    view.dispatch({ changes: { from: 2, insert: ")" } });
    typer.insert("x)");
    expect(typer.finish()).toBe(false);
    expect(view.state.doc.toString()).toBe("f(x)");
  });

  it("group the line breaks of a run in one keystroke", () => {
    expect(typingChunks("ab\n\n  c\nd")).toEqual([
      "a",
      "b",
      "\n\n",
      " ",
      " ",
      "c",
      "\n",
      "d",
    ]);
    expect(typingChunks("é😀")).toEqual(["é", "😀"]);
    expect(typingChunks("")).toEqual([]);
  });
});

describe("engine helpers", () => {
  it("parse key combinations", () => {
    expect(parseKeys("Control+k")).toMatchObject({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      shiftKey: false,
    });
    expect(parseKeys("Shift+Enter")).toMatchObject({
      key: "Enter",
      shiftKey: true,
    });
    expect(parseKeys("+")).toMatchObject({ key: "+", ctrlKey: false });
    expect(parseKeys("Alt+1")).toMatchObject({ code: "Digit1", altKey: true });
  });

  it("match menu items by action id, path or label (English or French)", () => {
    const item = document.createElement("li");
    item.className = "menu-item";
    item.setAttribute("data-action-id", "file.capsule");
    item.setAttribute("title", "File/Workspace capsule…");
    item.innerHTML = '<span class="menu-label">Fermer…</span>';
    expect(menuItemMatches(item, "file.capsule")).toBe(true);
    expect(menuItemMatches(item, "Workspace capsule…")).toBe(true);
    expect(menuItemMatches(item, "Close")).toBe(true);
    expect(menuItemMatches(item, /^Fermer/)).toBe(true);
    expect(menuItemMatches(item, "Open")).toBe(false);
  });

  it("consider detached or unrendered elements hidden", () => {
    expect(isVisible(null)).toBe(false);
    expect(isVisible(document.createElement("div"))).toBe(false);
    expect(isVisible({ nodeType: 1 })).toBe(false);
  });
});

describe("workspace transitions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function resetContext(withSignal: boolean) {
    const app = document.createElement("div");
    app.className = "app";
    if (withSignal) {
      app.dataset.workspaceResetId = "0";
      app.dataset.workspaceResetState = "idle";
    }
    document.body.appendChild(app);
    const frame = new AppFrame(
      document.createElement("div"),
      new URL("http://localhost/web/"),
    );
    vi.spyOn(frame, "doc", "get").mockReturnValue(document);
    const context = new ShowcaseContext(frame, new AppBridge(frame), {
      speed: 0,
    });
    vi.spyOn(context, "settleReload").mockResolvedValue();
    vi.spyOn(context, "closeTransientUi").mockResolvedValue();
    vi.spyOn(context, "hasAction").mockResolvedValue(true);
    const action = vi.spyOn(context, "runAction").mockResolvedValue();
    const reload = vi.spyOn(context, "reloadApp").mockResolvedValue();
    vi.spyOn(context, "tab").mockReturnValue(null);
    return { app, context, action, reload };
  }

  it("waits for the reset to finish even if the object tree is already empty", async () => {
    vi.useFakeTimers();
    const { app, context, action, reload } = resetContext(true);
    let finished = false;
    const reset = context.resetWorkspace().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(action).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    app.dataset.workspaceResetId = "1";
    await vi.advanceTimersByTimeAsync(100);
    await reset;
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when the action has no reset completion signal", async () => {
    const { context, action, reload } = resetContext(false);
    await context.resetWorkspace();
    expect(reload).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ["New workspace", "Create"],
    ["Nouvel espace de travail", "Créer"],
  ])("confirms %s and waits for completion", async (title, label) => {
    const { app, context } = resetContext(true);
    const dialog = document.createElement("div");
    dialog.innerHTML = `<h2>${title}</h2><div class="actions"><button class="danger">${label}</button></div>`;
    vi.spyOn(context, "visible").mockReturnValue(dialog);
    const click = vi.spyOn(context, "click").mockImplementation(async () => {
      app.dataset.workspaceResetId = "1";
    });
    await context.resetWorkspace();
    expect(click).toHaveBeenCalledWith(dialog.querySelector("button"), {
      instant: true,
    });
  });

  it("reports a failed reset instead of treating an empty tree as success", async () => {
    vi.useFakeTimers();
    const { app, context } = resetContext(true);
    const reset = context.resetWorkspace();
    const assertion = expect(reset).rejects.toThrow(
      "DataLab Web could not create a new workspace",
    );
    await vi.advanceTimersByTimeAsync(100);
    app.dataset.workspaceResetState = "error";
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("does not mistake an error dialog for a confirmation", async () => {
    const { app, context } = resetContext(true);
    const dialog = document.createElement("div");
    dialog.innerHTML =
      '<p>Reset failed</p><div class="actions"><button class="danger">Close</button></div>';
    vi.spyOn(context, "visible").mockReturnValue(dialog);
    vi.spyOn(context, "runAction").mockImplementation(async () => {
      app.dataset.workspaceResetState = "error";
    });
    const click = vi.spyOn(context, "click").mockResolvedValue();
    await expect(context.resetWorkspace()).rejects.toThrow("Reset failed");
    expect(click).not.toHaveBeenCalled();
  });

  it("does not confirm an unrelated destructive dialog", async () => {
    const { context } = resetContext(true);
    const dialog = document.createElement("div");
    dialog.innerHTML =
      '<h2>Delete group</h2><div class="actions"><button class="danger">Delete</button></div>';
    vi.spyOn(context, "visible").mockReturnValue(dialog);
    const click = vi.spyOn(context, "click").mockResolvedValue();
    await expect(context.resetWorkspace()).rejects.toThrow("Unexpected dialog");
    expect(click).not.toHaveBeenCalled();
  });
});

describe("playlist", () => {
  it("interleaves the application demos with the native ones", () => {
    expect(interleave(["w1", "w2", "w3", "w4"], ["a1", "a2"])).toEqual([
      "w1",
      "a1",
      "w2",
      "a2",
      "w3",
      "w4",
    ]);
    expect(interleave(["w1"], ["a1", "a2", "a3"])).toEqual([
      "w1",
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("selects demos in playlist order and reports unknown ones", () => {
    const all = ["w1", "app:x", "w2", "w3"].map((id) => ({ id }));
    expect(selectScenarios(all, null).scenarios).toEqual(all);
    const { scenarios, unknown } = selectScenarios(all, ["w3", "APP:X", "w9"]);
    expect(scenarios.map((s) => s.id)).toEqual(["app:x", "w3"]);
    expect(unknown).toEqual(["w9"]);
  });
});
