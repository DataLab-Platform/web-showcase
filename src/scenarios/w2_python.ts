import { editorText, findEditorView } from "../codemirror";
import {
  isVisible,
  text,
  type ShowcaseContext,
  type ShowcaseScenario,
} from "../engine";
import { appLabels, isAppLabel, t } from "../i18n";
import { RECENT_STORE, StoreGuard } from "../storage";
import { tabSelected, treeItemByTitle, treeTitles } from "./common";
import { waitForKernel } from "./w2_kernel";

/**
 * W2 — Python in the browser: notebooks & macros.
 *
 * A new notebook gets a Markdown cell and two code cells typed on screen
 * (a chirp pushed to the Signals panel through ``proxy``, then its NumPy
 * spectrum); a new macro then creates noisy signals and averages them with
 * DataLab's own processing, through the same ``proxy`` API as DataLab
 * desktop macros. The notebook and the macro created by the demo are
 * closed at the end and removed from the "Recent…" cache of DataLab Web,
 * so that loops never pile up tabs or pollute the visitor's recent
 * documents.
 */

/** Typing pace of the code (characters per second at speed 1). */
const CODE_CPS = 21;
/** Kernel boot while the demo plays (e.g. after DataLab Web reloaded). */
const KERNEL_RUN_TIMEOUT_MS = 180_000;
/** A notebook cell or a macro run (the macro worker may still boot). */
const RUN_TIMEOUT_MS = 180_000;

// -- Code typed on screen ----------------------------------------------------

function markdownSource(): string {
  return [
    `## ${t("Chirp analysis")}`,
    t("NumPy runs in this tab; the results go to DataLab."),
  ].join("\n");
}

function chirpCell(): string {
  return [
    "import numpy as np",
    "",
    "t = np.linspace(0, 1, 2000)",
    "chirp = np.sin(2 * np.pi * (5 + 40 * t) * t)",
    'await proxy.add_signal("Chirp", t, chirp)',
    `print(f"{chirp.size} ${t("samples")}")`,
  ].join("\n");
}

function spectrumTitle(): string {
  return t("Chirp spectrum");
}

function spectrumCell(): string {
  return [
    "f = np.fft.rfftfreq(t.size, t[1] - t[0])",
    "spectrum = np.abs(np.fft.rfft(chirp))",
    `await proxy.add_signal("${spectrumTitle()}", f, spectrum)`,
    "band = f[spectrum > spectrum.max() / 2]",
    `print(f"${t("Band")}: {band.min():.0f}-{band.max():.0f} Hz")`,
  ].join("\n");
}

function macroSource(): string {
  return [
    "import numpy as np",
    "",
    "x = np.linspace(-5, 5, 500)",
    "ids = []",
    "for i in range(1, 6):",
    "    y = np.exp(-x**2) + np.random.normal(0, 0.2, x.size)",
    `    ids.append(await proxy.add_signal(f"${t("Noisy")} {i}", x, y))`,
    'avg = await proxy.calc("average", sources=ids)',
    "await proxy.select_objects([ids[0]] + avg)",
    "xy = await proxy.get_signal_xy(avg[0])",
    'noise = np.std(np.array(xy["y"]) - np.exp(-x**2))',
    `print(f"${t("Noise")}: 0.20 -> {noise:.2f}")`,
  ].join("\n");
}

// -- DOM helpers ---------------------------------------------------------------

/** Visible button of ``scope`` whose tooltip is the DataLab Web label
 *  ``title``. */
function buttonByTitle(
  ctx: ShowcaseContext,
  scope: string,
  title: string,
): () => HTMLElement | null {
  const titles = appLabels(title);
  return () =>
    ctx
      .$$<HTMLButtonElement>(`${scope} button`)
      .find((button) => titles.includes(button.title) && isVisible(button)) ??
    null;
}

function enabled(button: HTMLElement | null): HTMLElement | null {
  return button && !(button as HTMLButtonElement).disabled ? button : null;
}

/** Confirmation button ``label`` of the visible modal dialog. */
function modalButton(ctx: ShowcaseContext, label: string): HTMLElement | null {
  const dialog = ctx.visible('.overlay[role="dialog"]');
  return dialog
    ? (ctx
        .$$(".actions button", dialog)
        .find((button) => isAppLabel(button.textContent, label)) ?? null)
    : null;
}

/** Close a notebook or macro tab (with its confirmation) through the UI. */
async function closeTab(
  ctx: ShowcaseContext,
  tab: HTMLElement,
  closeSelector: string,
): Promise<void> {
  if (!tab.isConnected) return;
  await ctx.click(() => tab.querySelector<HTMLElement>(closeSelector), {
    instant: true,
  });
  await ctx.click(await ctx.find(() => modalButton(ctx, "Close"), 5_000));
  await ctx.waitFor(() => !tab.isConnected, 10_000, "the tab to close");
}

// -- Clean-up without the showcase context (also after an abort) ---------------

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function poll<T>(probe: () => T | null, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null = null;
    try {
      value = probe();
    } catch {
      // DataLab Web is reloading.
    }
    if (value || Date.now() >= deadline) return value;
    await pause(50);
  }
}

/** Close ``tab`` with plain DOM clicks (no pointer, no abort check). */
async function forceCloseTab(
  ctx: ShowcaseContext,
  tab: HTMLElement | null,
  closeSelector: string,
): Promise<void> {
  const close = tab?.isConnected
    ? tab.querySelector<HTMLElement>(closeSelector)
    : null;
  if (!tab || !close) return;
  close.click();
  const confirm = await poll(() => modalButton(ctx, "Close"), 3_000);
  confirm?.click();
  await poll(() => (tab.isConnected ? null : true), 3_000);
}

// -- Notebook steps ----------------------------------------------------------------

const NB_TOOLBAR = ".nb-panel .nb-toolbar";

function activeCell(ctx: ShowcaseContext): HTMLElement | null {
  return ctx.visible(".nb-cell.nb-cell-active");
}

/** Run the active code cell from the toolbar; resolves once it is done. */
async function runActiveCell(ctx: ShowcaseContext): Promise<HTMLElement> {
  const cell = await ctx.find(() => activeCell(ctx));
  // Disabled while the kernel boots or runs another cell.
  const run = await ctx.find(
    () =>
      enabled(buttonByTitle(ctx, NB_TOOLBAR, "Run active cell (Ctrl+Enter)")()),
    RUN_TIMEOUT_MS,
  );
  await ctx.click(run);
  await ctx.checkpoint(
    () =>
      /^\[\d+\]:$/.test(
        (cell.querySelector(".nb-cell-prompt")?.textContent ?? "").trim(),
      ) && !cell.classList.contains("nb-cell-running"),
    "the notebook cell runs to completion",
    RUN_TIMEOUT_MS,
  );
  await ctx.checkpoint(
    () =>
      !cell.classList.contains("nb-cell-error") &&
      !cell.querySelector(".nb-output-stderr, .nb-output-error"),
    "the notebook cell runs without error",
  );
  return cell;
}

/** Type ``source`` in a new code cell (below the active one). */
async function typeNewCodeCell(
  ctx: ShowcaseContext,
  source: string,
): Promise<void> {
  const before = ctx.$$(".nb-panel .nb-cell").length;
  await ctx.click(buttonByTitle(ctx, NB_TOOLBAR, "Insert code cell below"));
  await ctx.waitFor(
    () =>
      ctx.$$(".nb-panel .nb-cell").length > before &&
      activeCell(ctx)?.classList.contains("nb-cell-code"),
    5_000,
    "a new code cell",
  );
  const editor = ".nb-cell.nb-cell-active .nb-cell-editor .cm-content";
  await ctx.type(editor, source, CODE_CPS);
  await ctx.checkpoint(
    () => editorText(ctx.$(editor) as Element) === source,
    "the code is typed verbatim in the notebook cell",
  );
}

/** The cell's stdout, once the central view shows the notebook again. */
async function showCellOutput(
  ctx: ShowcaseContext,
  cell: HTMLElement,
  expected: string,
): Promise<void> {
  if (!tabSelected(ctx, "Notebooks")) await ctx.clickTab("Notebooks");
  const output = await ctx.find(
    () => cell.querySelector<HTMLElement>(".nb-output-stdout"),
    10_000,
  );
  await ctx.checkpoint(
    () => (output.textContent ?? "").includes(expected),
    `the cell prints "${expected}"`,
    10_000,
  );
  output.scrollIntoView({ block: "nearest" });
  await ctx.spotlight(output);
}

/** After a cell or a macro pushed an object, DataLab shows its plot. */
async function showPlotOf(ctx: ShowcaseContext, title: string): Promise<void> {
  await ctx.checkpoint(
    () => treeItemByTitle(ctx, title),
    `"${title}" is listed in the Signals panel`,
    10_000,
  );
  if (!tabSelected(ctx, "Plot")) await ctx.clickTab("Plot");
}

/** Empty the macro editor: select all, delete (Ctrl+A, Delete), as a
 *  visitor would; the editor view finishes the job if keys were ignored. */
async function clearMacroEditor(
  ctx: ShowcaseContext,
  editor: string,
): Promise<void> {
  await ctx.click(editor);
  await ctx.press("Control+a", editor);
  await ctx.hold(500);
  await ctx.press("Delete", editor);
  const content = ctx.$(editor);
  if (content && editorText(content) !== "") {
    const view = findEditorView(content);
    if (view) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
      });
    } else {
      ctx.doc.execCommand("selectAll");
      ctx.doc.execCommand("delete");
    }
  }
  await ctx.checkpoint(
    () => editorText(ctx.$(editor) as Element) === "",
    "the macro editor is empty",
    3_000,
  );
}

// -- Scenario -----------------------------------------------------------------------

export const w2Python: ShowcaseScenario = {
  id: "w2",
  title: () => t("Python in the browser: notebooks & macros"),
  subtitle: () => t("Notebooks and macros running Python in WebAssembly"),

  async prewarm(ctx) {
    await waitForKernel(ctx);
  },

  async run(ctx) {
    const recent = await StoreGuard.capture(
      ctx.win.indexedDB,
      RECENT_STORE.db,
      RECENT_STORE.store,
    );
    let notebookTab: HTMLElement | null = null;
    let macroTab: HTMLElement | null = null;
    try {
      await ctx.say(
        t(
          "Real CPython, NumPy and SciPy, compiled to WebAssembly, run in this browser tab.",
        ),
        3200,
      );

      // -- Notebook --------------------------------------------------------
      await ctx.clickTab("Notebooks");
      await ctx.waitFor(".nb-panel .nb-toolbar", 10_000);
      // Normally warm (see prewarm), unless DataLab Web reloaded since.
      const kernel = waitForKernel(ctx, KERNEL_RUN_TIMEOUT_MS).then(
        () => null,
        (error: unknown) => error,
      );
      await ctx.say(
        t("Jupyter-like notebooks, with a Python kernel running locally."),
      );
      const kernelError = await kernel;
      if (kernelError) throw kernelError;
      const tabsBefore = ctx.$$(".nb-panel .nb-tab");
      await ctx.click(".nb-panel .nb-tab-new");
      // "Empty notebook" is the first entry of the menu.
      await ctx.click(() => ctx.visible(".nb-new-menu .nb-open-menu-name"));
      notebookTab = await ctx.waitFor(
        () =>
          ctx
            .$$(".nb-panel .nb-tab.active")
            .find((tab) => !tabsBefore.includes(tab)) ?? null,
        15_000,
        "the new notebook",
      );
      // A new notebook has no active cell yet: click into its first cell.
      await ctx.click(() => ctx.visible(".nb-panel .nb-cell"));
      await ctx.waitFor(
        () => activeCell(ctx)?.classList.contains("nb-cell-code"),
        5_000,
        "the first cell of the new notebook",
      );

      // Markdown cell: convert the first cell, type, render (Ctrl+Enter).
      await ctx.click(
        buttonByTitle(
          ctx,
          NB_TOOLBAR,
          "Convert active cell between code and markdown",
        ),
      );
      const markdown = ".nb-cell.nb-cell-active.nb-cell-markdown .cm-content";
      await ctx.waitFor(markdown, 5_000);
      await ctx.type(markdown, markdownSource(), CODE_CPS);
      await ctx.checkpoint(
        () => editorText(ctx.$(markdown) as Element) === markdownSource(),
        "the Markdown text is typed verbatim",
      );
      await ctx.press("Control+Enter", markdown);
      await ctx.checkpoint(
        () =>
          ctx.$(
            ".nb-cell.nb-cell-active.nb-cell-markdown .nb-cell-markdown-rendered",
          ),
        "the Markdown cell is rendered",
        5_000,
      );
      await ctx.hold(1500);

      // Code cell 1: a chirp, pushed to the Signals panel.
      await typeNewCodeCell(ctx, chirpCell());
      await ctx.hold(500);
      const chirp = await runActiveCell(ctx);
      await showPlotOf(ctx, "Chirp");
      await ctx.spotlight(() => treeItemByTitle(ctx, "Chirp"));
      await ctx.say(
        t("One call to proxy.add_signal and the chirp is a DataLab signal."),
        3000,
      );
      ctx.clearSpotlight();
      await showCellOutput(ctx, chirp, `2000 ${t("samples")}`);
      await ctx.hold(2000);
      ctx.clearSpotlight();

      // Code cell 2: its spectrum, computed with NumPy.
      await typeNewCodeCell(ctx, spectrumCell());
      await ctx.hold(500);
      const spectrum = await runActiveCell(ctx);
      await showPlotOf(ctx, spectrumTitle());
      await ctx.spotlight(".plot-area");
      await ctx.say(
        t("A NumPy FFT, computed in the browser and plotted by DataLab."),
        3000,
      );
      ctx.clearSpotlight();
      await showCellOutput(ctx, spectrum, `${t("Band")}:`);
      await ctx.say(t("Cell outputs show up below each cell, as in Jupyter."));
      ctx.clearSpotlight();

      // -- Macro -------------------------------------------------------------
      await ctx.clickTab("Macros");
      await ctx.waitFor(".macro-panel .macro-toolbar", 10_000);
      await ctx.say(
        t("Macros use the same proxy API as DataLab desktop macros."),
      );
      const macroTabsBefore = ctx.$$(".macro-panel .macro-tab");
      await ctx.click(".macro-panel .macro-tab-new");
      // "Blank macro" is the first entry of the menu.
      await ctx.click(() => ctx.visible(".macro-tab-new-menu-item"));
      macroTab = await ctx.waitFor(
        () =>
          ctx
            .$$(".macro-panel .macro-tab.active")
            .find((tab) => !macroTabsBefore.includes(tab)) ?? null,
        15_000,
        "the new macro",
      );
      // A blank macro starts from a sample: select it all, then delete it.
      const editor = ".macro-panel .macro-editor .cm-content";
      await clearMacroEditor(ctx, editor);
      await ctx.type(editor, macroSource(), CODE_CPS);
      await ctx.checkpoint(
        () => editorText(ctx.$(editor) as Element) === macroSource(),
        "the macro is typed verbatim",
      );
      await ctx.hold(500);
      const run = ".macro-panel .macro-toolbar .macro-btn.primary";
      await ctx.click(run);
      const noise = `${t("Noise")}: 0.20 ->`;
      await ctx.checkpoint(
        () =>
          ctx
            .$$(".macro-panel .macro-console-line.stdout")
            .some((line) => text(line).includes(noise)) &&
          !(ctx.$(run) as HTMLButtonElement | null)?.disabled,
        "the macro averages the noisy signals",
        RUN_TIMEOUT_MS,
      );
      await ctx.checkpoint(
        () =>
          treeTitles(ctx).filter((title) => title.startsWith(t("Noisy")))
            .length === 5 &&
          treeTitles(ctx).some((title) => title.startsWith("µ(")),
        "the noisy signals and their average are in the Signals panel",
        10_000,
      );
      if (!tabSelected(ctx, "Plot")) await ctx.clickTab("Plot");
      await ctx.spotlight(".plot-area");
      await ctx.say(
        t(
          "Five noisy signals, averaged by DataLab's own processing: the noise drops.",
        ),
        4000,
      );
      ctx.clearSpotlight();
      await ctx.clickTab("Macros");
      const consoleBox = await ctx.find(".macro-panel .macro-console-wrap");
      await ctx.spotlight(consoleBox);
      await ctx.say(t("The console streams the macro output."), 3200);
      ctx.clearSpotlight();

      // -- Tidy up -----------------------------------------------------------
      await closeTab(ctx, macroTab, ".macro-tab-close");
      await ctx.clickTab("Notebooks", { instant: true });
      await closeTab(ctx, notebookTab, ".nb-tab-close");
      await ctx.clickTab("Plot");
      await ctx.say(
        t("The same Python scripts run in DataLab Web and in DataLab desktop."),
        3500,
      );
    } finally {
      ctx.clearSpotlight();
      await forceCloseTab(ctx, macroTab, ".macro-tab-close");
      await forceCloseTab(ctx, notebookTab, ".nb-tab-close");
      // Let the debounced autosaves land before cleaning the cache.
      await pause(1_500);
      const removed = await recent.restore();
      ctx.log(`recent cache restored (${removed} demo entries removed)`);
    }
  },
};
