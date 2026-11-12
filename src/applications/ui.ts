/**
 * DOM helpers of the generated application demos: the Applications window
 * of DataLab Web (plugin list, method cards, examples, status) and the
 * workspace objects created by a method.
 *
 * Hooks: ``.applications-window-layer`` and its ``[data-plugin-id]`` list
 * entries, ``.application-method[data-recipe-id]`` method cards and their
 * ``.application-method-example[data-example-id]`` rows, the
 * ``.applications-status`` line, and the ``#<id> ·`` meta line of the
 * object tree items.
 */

import {
  isVisible,
  text,
  type SayOptions,
  type ShowcaseContext,
} from "../engine";
import type { WorkspaceObject } from "../frame";
import { appLabels, isAppLabel } from "../i18n";
import {
  collectExamples,
  parseCreatedCount,
  type ApplicationRecipe,
  type ApplicationSummary,
} from "./plan";

export const APPLICATIONS_LAYER = ".applications-window-layer";

/** Delay for the Applications window and its plugin list (listed by the
 *  Python runtime, which may still be busy, e.g. loading packages). */
const WINDOW_TIMEOUT_MS = 30_000;

/** Caption side leaving ``el`` visible: above it when it lies in the lower
 *  half of DataLab Web, below it otherwise. */
export function captionSideFor(
  ctx: ShowcaseContext,
  el: Element | null,
): SayOptions {
  if (!el) return {};
  const rect = el.getBoundingClientRect();
  const middle = (rect.top + rect.bottom) / 2;
  return {
    position: middle > ctx.frame.viewport().height / 2 ? "top" : "bottom",
  };
}

/** The open Applications window, if any. */
export function applicationsLayer(ctx: ShowcaseContext): HTMLElement | null {
  return ctx.visible(APPLICATIONS_LAYER);
}

/** Open the Applications window from its menu bar entry. */
export async function openApplicationsWindow(
  ctx: ShowcaseContext,
  opts: { instant?: boolean } = {},
): Promise<HTMLElement> {
  if (!applicationsLayer(ctx)) {
    await ctx.click(() => ctx.topMenu("Applications"), opts);
  }
  return ctx.waitFor(APPLICATIONS_LAYER, WINDOW_TIMEOUT_MS);
}

/** Close the Applications window with its close button. */
export async function closeApplicationsWindow(
  ctx: ShowcaseContext,
  opts: { instant?: boolean } = {},
): Promise<void> {
  const layer = applicationsLayer(ctx);
  if (layer) {
    const close = ctx.$(".dialog-close-button", layer);
    if (close) await ctx.click(close, opts);
    else await ctx.press("Escape");
  }
  await ctx.checkpoint(
    () => !applicationsLayer(ctx),
    "the Applications window is closed",
    10_000,
  );
}

function applicationEntry(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  plan: { pluginId: string; name: string },
): HTMLElement | null {
  const entries = ctx.$$(".applications-list button", layer);
  return (
    entries.find(
      (entry) => entry.getAttribute("data-plugin-id") === plan.pluginId,
    ) ??
    entries.find(
      (entry) => text(entry.querySelector("strong")) === plan.name,
    ) ??
    null
  );
}

/** Select the plugin of ``plan`` in the Applications window (showing the
 *  application list first if it is hidden). Returns the window card. */
export async function selectApplication(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  plan: { pluginId: string; name: string },
  opts: { instant?: boolean } = {},
): Promise<HTMLElement> {
  const toggle = ctx.$(".applications-list-toggle", layer);
  if (toggle?.getAttribute("aria-expanded") === "false") {
    await ctx.click(toggle, opts);
  }
  const entry = await ctx.find(
    () => applicationEntry(ctx, layer, plan),
    WINDOW_TIMEOUT_MS,
  );
  await ctx.click(entry, opts);
  await ctx.waitFor(
    () =>
      entry.classList.contains("active") &&
      text(ctx.$(".application-title-row h3", layer)) === plan.name,
    WINDOW_TIMEOUT_MS,
    `the page of ${plan.name}`,
  );
  return ctx.$<HTMLElement>(".applications-dialog", layer) ?? layer;
}

/** The application page shown by the Applications window. */
function readApplicationPage(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  pluginId: string,
): ApplicationSummary {
  const titleRow = ctx.$(".application-title-row", layer);
  const name = text(titleRow?.querySelector("h3"));
  const description = text(titleRow?.querySelector(":scope > div > p"));
  const readExample = (row: Element) => ({
    id: row.getAttribute("data-example-id") ?? "",
    title: text(row.querySelector("strong")),
    description: text(row.querySelector("p")),
  });
  const cards = ctx
    .$$(".application-method[data-recipe-id]", layer)
    .map((card) => ({
      recipe: {
        id: card.getAttribute("data-recipe-id") ?? "",
        title: text(card.querySelector(":scope > summary strong")),
      } satisfies ApplicationRecipe,
      examples: ctx
        .$$(".application-method-example[data-example-id]", card)
        .map(readExample)
        .filter((example) => example.id),
    }))
    .filter((card) => card.recipe.id);
  const datasets = ctx
    .$$(".application-datasets [data-example-id]", layer)
    .map(readExample)
    .filter((example) => example.id);
  return {
    pluginId,
    name,
    description,
    recipes: cards.map((card) => card.recipe),
    examples: collectExamples(
      cards.map((card) => ({
        recipeId: card.recipe.id,
        examples: card.examples,
      })),
      datasets,
    ),
    tools: ctx.$$(".application-tools [data-tool-id]", layer).length,
  };
}

/**
 * The application plugins of DataLab Web, read from its Applications window
 * (opened, browsed and closed again, without pointer animation). Empty when
 * DataLab Web has none (or no Applications entry).
 */
export async function readApplications(
  ctx: ShowcaseContext,
): Promise<ApplicationSummary[]> {
  if (!ctx.topMenu("Applications")) return [];
  const layer = await openApplicationsWindow(ctx, { instant: true });
  try {
    // The list is filled once the runtime has listed the plugins.
    await ctx
      .waitFor(
        () =>
          ctx.$$(".applications-list [data-plugin-id]", layer).length > 0 ||
          ctx.$(".recipe-empty", layer),
        WINDOW_TIMEOUT_MS,
        "the application list",
      )
      .catch(() => undefined);
    const entries = ctx
      .$$(".applications-list [data-plugin-id]", layer)
      .map((entry) => ({
        pluginId: entry.getAttribute("data-plugin-id") ?? "",
        name: text(entry.querySelector("strong")),
      }))
      .filter((entry) => entry.pluginId);
    const apps: ApplicationSummary[] = [];
    for (const entry of entries) {
      await selectApplication(ctx, layer, entry, { instant: true });
      apps.push(readApplicationPage(ctx, layer, entry.pluginId));
    }
    return apps;
  } finally {
    await closeApplicationsWindow(ctx, { instant: true }).catch(
      () => undefined,
    );
  }
}

/** Method card of ``recipeId`` in the Applications window. */
export function recipeCard(
  ctx: ShowcaseContext,
  layer: ParentNode,
  recipeId: string,
): HTMLDetailsElement | null {
  return (
    ctx
      .$$<HTMLDetailsElement>(".application-method", layer)
      .find((card) => card.getAttribute("data-recipe-id") === recipeId) ?? null
  );
}

/** Unfold a method card (the accordion folds the other ones). */
export async function openRecipeCard(
  ctx: ShowcaseContext,
  card: HTMLElement,
): Promise<void> {
  // Method cards are <details> elements.
  const details = card as HTMLDetailsElement;
  if (details.open) return;
  const summary = details.querySelector<HTMLElement>(":scope > summary");
  if (summary) await ctx.click(summary);
  if (!details.open) details.open = true;
  await ctx.waitFor(() => details.open, 5_000, "the method card to unfold");
}

/** Fold the open method cards, so that the window lists every method. */
export async function foldRecipeCards(
  ctx: ShowcaseContext,
  layer: ParentNode,
): Promise<void> {
  for (const card of ctx.$$<HTMLDetailsElement>(
    ".application-accordion > details[open]",
    layer,
  )) {
    const summary = card.querySelector<HTMLElement>(":scope > summary");
    if (summary) await ctx.click(summary);
    if (card.open) card.open = false;
  }
}

/** Row of ``exampleId`` in a method card. */
export function exampleRow(
  ctx: ShowcaseContext,
  card: ParentNode,
  exampleId: string,
): HTMLElement | null {
  return (
    ctx
      .$$(".application-method-example", card)
      .find((row) => row.getAttribute("data-example-id") === exampleId) ?? null
  );
}

/** Text of the Applications window status line, if shown. */
export function statusText(layer: ParentNode): string | null {
  const status = layer.querySelector(".applications-status");
  return isVisible(status) ? text(status) : null;
}

/** Number of objects created by the last method (status line). */
export function createdCount(layer: ParentNode): number | null {
  return parseCreatedCount(
    statusText(layer),
    appLabels("Created {count} objects"),
  );
}

/** Error shown by the Applications window or by one of its dialogs. */
export function visibleError(
  ctx: ShowcaseContext,
  layer: ParentNode,
): string | null {
  const errors = [
    ...ctx.$$(".applications-dialog > .error", layer),
    ...ctx.$$('.overlay[role="dialog"] .error'),
  ];
  const error = errors.find(isVisible);
  return error ? text(error) || appLabels("Error")[0] : null;
}

/** Visible modal dialog whose card matches ``selector``. */
export function modalCard(
  ctx: ShowcaseContext,
  selector: string,
): HTMLElement | null {
  return (
    ctx
      .$$('.overlay[role="dialog"] > .card')
      .find((card) => isVisible(card) && card.matches(selector)) ?? null
  );
}

/** The "replace the workspace?" confirmation of the examples. */
export function openExampleConfirmation(
  ctx: ShowcaseContext,
): HTMLElement | null {
  return (
    ctx
      .$$('.overlay[role="dialog"] > .card')
      .find(
        (card) =>
          isVisible(card) &&
          !card.matches(".dataset-dialog, .recipe-input-dialog") &&
          isAppLabel(card.querySelector("h2")?.textContent, "Open example"),
      ) ?? null
  );
}

/** Last button of a dialog card (its confirm button). */
export function confirmButton(card: ParentNode): HTMLButtonElement | null {
  const buttons = card.querySelectorAll<HTMLButtonElement>(".actions button");
  return buttons[buttons.length - 1] ?? null;
}

/** ID of an object tree item (from its ``#<id> · …`` meta line). */
export function treeItemId(item: Element): string | null {
  const meta = item.querySelector(".object-tree-meta")?.textContent ?? "";
  const match = /^#(\S+)/.exec(meta.trim());
  return match ? match[1] : null;
}

/** Object tree item of ``id`` (in the panel shown). */
export function treeItem(ctx: ShowcaseContext, id: string): HTMLElement | null {
  return (
    ctx.$$(".object-tree-item").find((item) => treeItemId(item) === id) ?? null
  );
}

/** Object tree tab of a panel kind. */
export function panelTabName(kind: WorkspaceObject["kind"]): string {
  return kind === "signal" ? "Signals" : "Images";
}

/** Show the Signals or Images panel. */
export async function showPanel(
  ctx: ShowcaseContext,
  kind: WorkspaceObject["kind"],
): Promise<void> {
  const name = panelTabName(kind);
  const tab = await ctx.find(() => ctx.tab(name), 5_000);
  if (tab.getAttribute("aria-selected") !== "true") {
    await ctx.click(tab);
    await ctx.waitFor(
      () => ctx.tab(name)?.getAttribute("aria-selected") === "true",
      10_000,
      `the ${name} panel`,
    );
  }
}
