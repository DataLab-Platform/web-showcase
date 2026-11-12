/**
 * DataLab Web user interface helpers shared by the demos: tabs, object
 * tree, result tables, Plotly plots and the light/dark theme.
 */

import { isVisible, text, type Point, type ShowcaseContext } from "../engine";
import { appLabels } from "../i18n";

/** Click a panel tab once enabled (tabs are disabled while busy). */
export async function clickEnabledTab(
  ctx: ShowcaseContext,
  name: string,
): Promise<void> {
  const tab = await ctx.waitFor(
    () => {
      const el = ctx.tab(name);
      return el && !(el as HTMLButtonElement).disabled ? el : null;
    },
    30_000,
    `the ${name} tab to be enabled`,
  );
  await ctx.click(tab);
}

/** Whether the tab ``name`` is the selected one. */
export function tabSelected(ctx: ShowcaseContext, name: string): boolean {
  return ctx.tab(name)?.getAttribute("aria-selected") === "true";
}

/** Visible element of ``selector`` whose text is the DataLab Web label
 *  ``label`` (English or French). */
export function elementWithText(
  ctx: ShowcaseContext,
  selector: string,
  label: string,
): () => HTMLElement | undefined {
  const labels = appLabels(label);
  return () =>
    ctx.$$(selector).find((el) => labels.includes(text(el)) && isVisible(el));
}

/** Titles of the object tree items (panel shown). */
export function treeTitles(ctx: ShowcaseContext): string[] {
  return ctx
    .$$(".object-tree-item .object-tree-title")
    .map((el) => (el.textContent ?? "").trim());
}

/** Object tree item whose title is ``title`` (or contains it). */
export function treeItemByTitle(
  ctx: ShowcaseContext,
  title: string,
  partial = false,
): HTMLElement | null {
  return (
    ctx.$$(".object-tree-item").find((item) => {
      const value = text(item.querySelector(".object-tree-title"));
      return partial ? value.includes(title) : value === title;
    }) ?? null
  );
}

// -- Result tables (side panel, Results tab) ----------------------------------

export interface ResultTable {
  title: string;
  headers: string[];
  rows: string[][];
  card: HTMLElement;
}

/** Result tables of the current object, as the Results tab shows them. */
export function resultTables(ctx: ShowcaseContext): ResultTable[] {
  return ctx.$$(".results-panel .result-card").map((card) => ({
    title: text(card.querySelector(".result-card-title")),
    headers: ctx.$$(".result-card-table thead th", card).map((th) => text(th)),
    rows: ctx
      .$$(".result-card-table tbody tr", card)
      .map((tr) => ctx.$$("td", tr).map((td) => text(td))),
    card,
  }));
}

/** The Results tab of the side panel. */
export function resultsTab(ctx: ShowcaseContext): HTMLElement | null {
  const labels = appLabels("Results");
  return (
    ctx
      .$$(".side-panel-tab")
      .find(
        (tab) =>
          isVisible(tab) &&
          labels.some((label) =>
            text(tab.querySelector(".side-panel-tab-label")).startsWith(label),
          ),
      ) ?? null
  );
}

/** Show the Results tab of the side panel (DataLab Web shows it by itself
 *  after an analysis). */
export async function showResults(ctx: ShowcaseContext): Promise<void> {
  const tab = await ctx.find(() => resultsTab(ctx), 10_000);
  if (tab.getAttribute("aria-selected") !== "true") await ctx.click(tab);
}

/** First number of a table cell (``"12.5"``, ``"1.250e+4"``…). */
export function cellNumber(cell: string | undefined): number {
  const match = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i.exec(cell ?? "");
  return match ? Number(match[0]) : Number.NaN;
}

// -- Plotly plots -------------------------------------------------------------

interface PlotlyAxis {
  c2p(value: number): number;
  _offset?: number;
  _length?: number;
}

interface PlotlyGraph extends HTMLElement {
  _fullLayout?: { xaxis?: PlotlyAxis; yaxis?: PlotlyAxis };
}

function plotAxes(
  host: Element,
): { graph: PlotlyGraph; xa: PlotlyAxis; ya: PlotlyAxis } | null {
  const graph = host.querySelector<PlotlyGraph>(".js-plotly-plot");
  const layout = graph?._fullLayout;
  const xa = layout?.xaxis;
  const ya = layout?.yaxis;
  if (!graph || !xa || !ya || typeof xa.c2p !== "function") return null;
  if (typeof ya.c2p !== "function") return null;
  return { graph, xa, ya };
}

/** Position (iframe viewport) of the data coordinates ``(x, y)`` in the
 *  Plotly plot hosted by ``host`` (inverse of the hover read-out). */
export function plotPoint(host: Element, x: number, y: number): Point {
  const axes = plotAxes(host);
  if (!axes) throw new Error("The plot has no axes yet");
  const rect = axes.graph.getBoundingClientRect();
  return {
    x: rect.left + (axes.xa._offset ?? 0) + axes.xa.c2p(x),
    y: rect.top + (axes.ya._offset ?? 0) + axes.ya.c2p(y),
  };
}

/** Wait until the Plotly plot of ``selector`` has axes and a stable size
 *  (a layout change, such as the cross profiles grid, resizes it). */
export async function waitForStablePlot(
  ctx: ShowcaseContext,
  selector: string,
  timeoutMs = 10_000,
): Promise<HTMLElement> {
  let last = "";
  let stableSince = 0;
  return ctx.waitFor(
    () => {
      const host = ctx.visible(selector);
      const axes = host ? plotAxes(host) : null;
      if (!host || !axes) return null;
      const rect = axes.graph.getBoundingClientRect();
      const key = [
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        axes.xa._length,
        axes.ya._length,
      ].join();
      const now = Date.now();
      if (key !== last) {
        last = key;
        stableSince = now;
        return null;
      }
      return now - stableSince >= 250 ? host : null;
    },
    timeoutMs,
    `a stable plot in ${selector}`,
  );
}

// -- Theme --------------------------------------------------------------------

const THEME_KEY = "datalab-web:theme";
export const THEME_TOGGLE = ".menubar-theme-toggle";

/** Theme to restore at the end of a demo: the displayed palette and the
 *  stored preference (``null`` = follow the system). */
export interface ThemeMemento {
  theme: string | null;
  stored: string | null;
}

export function currentTheme(ctx: ShowcaseContext): string | null {
  return ctx.doc.documentElement.getAttribute("data-theme");
}

export function rememberTheme(ctx: ShowcaseContext): ThemeMemento {
  let stored: string | null = null;
  try {
    stored = ctx.win.localStorage.getItem(THEME_KEY);
  } catch {
    // localStorage unavailable: nothing to restore.
  }
  return { theme: currentTheme(ctx), stored };
}

/** Put the visitor's theme back (immediately, whatever happened): the
 *  toggle button if the palette differs, then the stored preference. */
export function restoreTheme(
  ctx: ShowcaseContext,
  memento: ThemeMemento,
): void {
  try {
    if (currentTheme(ctx) !== memento.theme) {
      ctx.$(THEME_TOGGLE)?.click();
    }
    const storage = ctx.win.localStorage;
    if (memento.stored === null) storage.removeItem(THEME_KEY);
    else storage.setItem(THEME_KEY, memento.stored);
  } catch {
    // DataLab Web is reloading, or localStorage is unavailable.
  }
}
