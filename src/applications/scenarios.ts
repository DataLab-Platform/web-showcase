/**
 * Showcase demos generated for the application plugins of DataLab Web
 * (camera, pulse… characterization): one per application listed by its
 * Applications window.
 *
 * Plugins ship no showcase code. Each demo is derived from what the
 * Applications window shows (see ``./plan``): the application (name,
 * description), its methods and the examples designed for them. The demo
 * opens the Applications window from the menu bar, presents the plugin,
 * plays up to two examples the way a visitor would ("Try with this
 * example", parameter dialog, run), shows the objects and result tables
 * each method produced, and ends with an invitation to explore the
 * plugin's methods. A plugin without any example designed for a method
 * only gets its page and description.
 */

import {
  isVisible,
  text,
  type ShowcaseContext,
  type ShowcaseScenario,
} from "../engine";
import type { WorkspaceObject } from "../frame";
import { isAppLabel, t } from "../i18n";
import { resultTables, resultsTab } from "../scenarios/common";
import {
  applicationScenarioId,
  describeObjects,
  newObjects,
  planApplicationDemo,
  readingTime,
  type ApplicationDemoPlan,
  type ApplicationDemoStep,
  type ApplicationSummary,
} from "./plan";
import {
  captionSideFor,
  closeApplicationsWindow,
  confirmButton,
  createdCount,
  exampleRow,
  foldRecipeCards,
  modalCard,
  openApplicationsWindow,
  openExampleConfirmation,
  openRecipeCard,
  readApplications,
  recipeCard,
  selectApplication,
  showPanel,
  treeItem,
  treeItemId,
  visibleError,
} from "./ui";

/** Opening an example (generated or packaged data). */
const EXAMPLE_TIMEOUT_MS = 180_000;
/** Running a method in Pyodide (hundreds of shots, image stacks…). */
const RECIPE_TIMEOUT_MS = 300_000;

/** Explanations already given in the demo (not repeated per example). */
interface Told {
  outputs: boolean;
  diagnostics: boolean;
}

/** One demo per application plugin of DataLab Web. */
export async function createApplicationScenarios(
  ctx: ShowcaseContext,
): Promise<ShowcaseScenario[]> {
  let apps: ApplicationSummary[] = [];
  try {
    apps = await readApplications(ctx);
  } catch (error) {
    ctx.log(`no application plugin found: ${String(error)}`);
  }
  ctx.log(
    `application plugins: ${apps.map((app) => app.pluginId).join(", ") || "none"}`,
  );
  return apps.map(applicationScenario);
}

function applicationScenario(app: ApplicationSummary): ShowcaseScenario {
  const plan = planApplicationDemo(app);
  return {
    id: applicationScenarioId(app),
    title: () => plan.name,
    subtitle: () => t("Application plugin"),
    async run(ctx) {
      await playApplicationDemo(ctx, plan);
    },
  };
}

async function playApplicationDemo(
  ctx: ShowcaseContext,
  plan: ApplicationDemoPlan,
): Promise<void> {
  const told: Told = { outputs: false, diagnostics: false };
  ctx.log(
    `${plan.name}: ${plan.steps.length} example(s)` +
      plan.steps
        .map((step) => ` ${step.example.id} → ${step.recipe.id}`)
        .join(","),
  );
  await ctx.say(
    t("Application plugins add complete measurement methods to DataLab."),
    2500,
  );
  const intro = plan.description
    ? `${plan.name} — ${plan.description}`
    : t("Application plugin: {name}", { name: plan.name });

  let layer = await openApplicationsWindow(ctx);
  const card = await selectApplication(ctx, layer, plan);
  // Captions keep the title of the application page visible.
  const title = ctx.$(".application-title-row", layer) ?? card;
  await ctx.spotlight(card);
  await ctx.say(intro, readingTime(intro), captionSideFor(ctx, title));
  const methods = ctx.$(".application-accordion", layer);
  const page = ctx.$(".applications-content", layer);
  if (methods && page && isVisible(methods)) {
    await ctx.spotlight(page);
    await ctx.say(
      t(
        "Each method declares its expected inputs and its parameters, with examples to try it at once.",
      ),
      4000,
      captionSideFor(ctx, title),
    );
  }
  ctx.clearSpotlight();

  for (const [index, step] of plan.steps.entries()) {
    if (index > 0) {
      layer = await openApplicationsWindow(ctx);
      await selectApplication(ctx, layer, plan);
    }
    await playExample(ctx, layer, step, told);
  }

  if (plan.steps.length > 0) {
    layer = await openApplicationsWindow(ctx);
    await selectApplication(ctx, layer, plan);
  }
  // Folded method cards: the page lists every method of the plugin.
  await foldRecipeCards(ctx, layer);
  const catalog =
    ctx.visible(".application-accordion", layer) ??
    ctx.$(".applications-dialog", layer) ??
    layer;
  await ctx.spotlight(catalog);
  await ctx.say(
    t(
      "Explore its other methods and examples from the Applications menu, and try them on your own data.",
    ),
    5000,
    captionSideFor(ctx, catalog),
  );
  ctx.clearSpotlight();
  await closeApplicationsWindow(ctx);
}

/** Try ``step.example`` from its method card, then show what it produced. */
async function playExample(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  step: ApplicationDemoStep,
  told: Told,
): Promise<void> {
  const { example, recipe } = step;
  const card = await ctx.find(() => recipeCard(ctx, layer, recipe.id), 10_000);
  await openRecipeCard(ctx, card);
  const row = await ctx.find(() => exampleRow(ctx, card, example.id), 10_000);
  row.scrollIntoView({ block: "nearest" });
  await ctx.spotlight(row);
  const about = t("Example: {title}", { title: example.title });
  const caption = example.description
    ? `${about} — ${example.description}`
    : about;
  await ctx.say(caption, readingTime(caption), captionSideFor(ctx, row));
  const button = row.querySelector("button");
  if (!button) throw new Error(`The "${example.id}" example has no button`);
  await ctx.click(button);
  ctx.clearSpotlight();

  const loaded = await openExample(ctx, layer, step);
  const outputs = await runMethod(ctx, layer, step, loaded, told);
  await closeApplicationsWindow(ctx);
  await showOutputs(ctx, outputs, told);
  // No stale caption while the next step starts.
  ctx.clearCaption();
}

/** Wait for the example to open (confirming that it replaces the
 *  workspace) and present the parameter dialog of the method. Returns the
 *  example objects, or ``null`` when the method has no parameters (it then
 *  runs at once). */
async function openExample(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  step: ApplicationDemoStep,
): Promise<WorkspaceObject[] | null> {
  for (;;) {
    const state = await ctx.waitFor(
      () => {
        const error = visibleError(ctx, layer);
        if (error) return { kind: "error" as const, error };
        const confirmation = openExampleConfirmation(ctx);
        if (confirmation) {
          return { kind: "confirm" as const, card: confirmation };
        }
        const inputs = modalCard(ctx, ".recipe-input-dialog");
        if (inputs) return { kind: "inputs" as const, card: inputs };
        const parameters = modalCard(ctx, ".dataset-dialog");
        if (parameters) {
          return { kind: "parameters" as const, card: parameters };
        }
        if (createdCount(layer)) return { kind: "done" as const };
        return null;
      },
      EXAMPLE_TIMEOUT_MS,
      `the "${step.example.id}" example to open`,
    );
    if (state.kind === "error") {
      throw new Error(
        `The "${step.example.id}" example failed: ${state.error}`,
      );
    }
    if (state.kind === "done") return null;
    if (state.kind === "confirm") {
      // The previous demo left objects: the example replaces them.
      await ctx.hold(700);
      await ctx.click(await ctx.find(() => confirmButton(state.card)));
      continue;
    }
    if (state.kind === "inputs") {
      // Examples bind their inputs; confirm the proposed assignment.
      const submit = await ctx.waitFor(
        () => {
          const button = confirmButton(state.card);
          return button && !button.disabled ? button : null;
        },
        10_000,
        "assignable example inputs",
      );
      await ctx.hold(1200);
      await ctx.click(submit);
      continue;
    }
    const loaded = await ctx.bridge.listObjects();
    await ctx.checkpoint(
      loaded.length > 0,
      `the "${step.example.id}" example objects are created`,
    );
    const ok =
      ctx
        .$$<HTMLButtonElement>(".actions button", state.card)
        .find((button) => isAppLabel(button.textContent, "OK")) ??
      confirmButton(state.card);
    if (!ok) throw new Error("The parameter dialog has no OK button");
    await ctx.spotlight(state.card);
    const caption = t(
      "Example loaded: {objects}. The method “{title}” opens with parameters suited to this example.",
      { objects: describeObjects(loaded), title: step.recipe.title },
    );
    // Long parameter dialogs: the caption leaves the OK button visible.
    await ctx.say(caption, readingTime(caption), captionSideFor(ctx, ok));
    await ctx.click(ok);
    ctx.clearSpotlight();
    return loaded;
  }
}

/** Wait for the method to complete and return the objects it created. */
async function runMethod(
  ctx: ShowcaseContext,
  layer: HTMLElement,
  step: ApplicationDemoStep,
  loaded: WorkspaceObject[] | null,
  told: Told,
): Promise<WorkspaceObject[]> {
  const { recipe } = step;
  // The parameter dialog stays open ("Applying…") while the method runs.
  const running = modalCard(ctx, ".dataset-dialog")?.querySelector(".actions");
  const [created] = await Promise.all([
    ctx.waitFor(
      () => {
        const error = visibleError(ctx, layer);
        if (error) return { error };
        if (modalCard(ctx, ".dataset-dialog")) return null;
        const count = createdCount(layer);
        return count === null ? null : { count };
      },
      RECIPE_TIMEOUT_MS,
      `the "${recipe.title}" method to complete`,
    ),
    ctx.say(
      t(
        "The method runs right here, in the browser: Python and Sigima compiled to WebAssembly.",
      ),
      3500,
      captionSideFor(ctx, running ?? null),
    ),
  ]);
  if ("error" in created) {
    throw new Error(`The "${recipe.title}" method failed: ${created.error}`);
  }
  await ctx.checkpoint(
    created.count > 0,
    `the "${recipe.title}" method succeeded`,
  );

  let outputs: WorkspaceObject[];
  if (loaded) {
    outputs = newObjects(loaded, await ctx.bridge.listObjects());
  } else {
    // No parameter dialog: the method ran before any snapshot, take the
    // outputs selected by the application.
    const all = await ctx.bridge.listObjects();
    const selected = new Set(
      ctx
        .$$(".object-tree-item.selected")
        .map(treeItemId)
        .filter((id): id is string => id !== null),
    );
    outputs = all.filter((obj) => selected.has(obj.id));
  }
  await ctx.checkpoint(
    outputs.length > 0,
    `the "${recipe.title}" method created output objects`,
  );
  ctx.log(`${recipe.id}: ${outputs.map((obj) => obj.title).join(", ")}`);

  const status = ctx.$(".applications-status", layer);
  if (status) await ctx.spotlight(status);
  const caption = t("Done — new objects created by the method: {objects}.", {
    objects: describeObjects(outputs),
  });
  await ctx.say(
    caption,
    readingTime(caption, 2500, 4000),
    captionSideFor(ctx, status),
  );
  const diagnostics = ctx.visible(".applications-diagnostics", layer);
  if (diagnostics && !told.diagnostics) {
    told.diagnostics = true;
    await ctx.spotlight(diagnostics);
    await ctx.say(
      t("Its diagnostics explain every case it flagged."),
      3500,
      captionSideFor(ctx, diagnostics),
    );
  }
  ctx.clearSpotlight();
  return outputs;
}

/** Show the main output, its result tables and the other outputs. */
async function showOutputs(
  ctx: ShowcaseContext,
  outputs: WorkspaceObject[],
  told: Told,
): Promise<void> {
  // The application makes the main output (the one carrying the results,
  // or the first one) current after a method ran.
  const current = ctx.$(".object-tree-item.current");
  const currentId = current ? treeItemId(current) : null;
  const main = outputs.find((obj) => obj.id === currentId) ?? outputs[0];
  await showPanel(ctx, main.kind);
  const item = await ctx.find(() => treeItem(ctx, main.id), 10_000);
  await ctx.click(item);

  if (!told.outputs) {
    told.outputs = true;
    const group = item.closest(".object-tree-group");
    const outputIds = new Set(outputs.map((obj) => obj.id));
    const groupItems = group ? ctx.$$(".object-tree-item", group) : [];
    const onlyOutputs =
      groupItems.length > 0 &&
      groupItems.every((el) => outputIds.has(treeItemId(el) ?? ""));
    await ctx.spotlight(onlyOutputs && group ? group : item);
    await ctx.say(
      t(
        "The results are regular DataLab objects, ready for further processing.",
      ),
      3500,
    );
    ctx.clearSpotlight();
  }

  const plot = ctx.visible(".plot-area");
  if (plot) await ctx.spotlight(plot, 0);
  const mainText = t("Main result: “{title}”.", { title: main.title });
  await ctx.say(mainText, readingTime(mainText, 3000, 4500));
  ctx.clearSpotlight();

  // Result tables: the Results tab of the side panel ("Results (n)").
  const tab = resultsTab(ctx);
  const count = /\((\d+)\)\s*$/.exec(text(tab))?.[1];
  if (tab && count && Number(count) > 0) {
    const previous = ctx.$(".side-panel-tab.active");
    await ctx.click(tab);
    const panel = await ctx.find(".results-panel", 5_000);
    const [first] = resultTables(ctx);
    await ctx.spotlight(panel.closest(".side-panel") ?? panel);
    const caption = t("Its result table: {title}.", {
      title: first?.title ?? "",
    });
    await ctx.say(caption, readingTime(caption, 3500, 5000));
    ctx.clearSpotlight();
    if (previous && previous !== tab && isVisible(previous)) {
      await ctx.click(previous, { instant: true });
    }
  }

  const others = outputs.filter((obj) => obj.kind !== main.kind);
  if (others.length > 0) {
    const other = others[0];
    await showPanel(ctx, other.kind);
    await ctx.click(await ctx.find(() => treeItem(ctx, other.id), 10_000));
    if (plot) await ctx.spotlight(plot, 0);
    const caption = t("Other outputs: {objects}, for example “{title}”.", {
      objects: describeObjects(others),
      title: other.title,
    });
    await ctx.say(caption, readingTime(caption, 3000, 4500));
    ctx.clearSpotlight();
  }
}
