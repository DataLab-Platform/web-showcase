/**
 * Plan of the showcase demo generated for an application plugin.
 *
 * Plugins ship no showcase code: the demo is derived from what the
 * Applications window of DataLab Web shows about them — the application
 * (name, description), its methods (recipes) and the examples designed for
 * each method. This module holds the pure part of the generator (no DOM),
 * so that any application plugin gets a sensible demo and the choices stay
 * unit-tested.
 */

import { t } from "../i18n";

/** Examples played per application plugin (keeps a demo under ~2 min). */
export const MAX_DEMO_EXAMPLES = 2;

/** A method (recipe) of an application, as its card shows it. */
export interface ApplicationRecipe {
  id: string;
  title: string;
}

/** An example of an application and the methods it is designed for, in
 *  the order of the method cards. */
export interface ApplicationExample {
  id: string;
  title: string;
  description: string;
  recipeIds: string[];
}

/** An application plugin, as the Applications window lists it. */
export interface ApplicationSummary {
  /** Plugin ID (``data-plugin-id`` of the application list). */
  pluginId: string;
  name: string;
  description: string;
  recipes: ApplicationRecipe[];
  /** Examples in order of appearance (method cards, then datasets). */
  examples: ApplicationExample[];
  /** Number of tools of the application. */
  tools: number;
}

/** One example of the demo and the method run on it. */
export interface ApplicationDemoStep {
  example: ApplicationExample;
  /** One of the recipes the example targets, declared by the plugin. */
  recipe: ApplicationRecipe;
}

export interface ApplicationDemoPlan {
  pluginId: string;
  name: string;
  description: string;
  /** Examples to play, in order (empty: page and description only). */
  steps: ApplicationDemoStep[];
}

/** Object of the workspace, as listed by DataLab Web. */
export interface WorkspaceObject {
  id: string;
  kind: "signal" | "image";
  title: string;
}

/** Scenario id of an application plugin, e.g.
 *  ``app:datalab_camera_characterization``. */
export function applicationScenarioId(app: { pluginId: string }): string {
  return `app:${app.pluginId}`.toLowerCase();
}

/**
 * Pick up to ``max`` examples designed for a recipe, in order (so a
 * plugin's first, "quickstart"-like example comes first). Each example
 * runs the first of its recipes not shown yet — the example's own method
 * unless an earlier example already showed it — so that the demo shows
 * several methods when it can; examples whose recipes were all shown only
 * fill the remaining places. Recipes without a card are ignored.
 */
export function pickDemoSteps(
  recipes: readonly ApplicationRecipe[],
  examples: readonly ApplicationExample[],
  max = MAX_DEMO_EXAMPLES,
): ApplicationDemoStep[] {
  const declared = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const candidates = examples
    .map((example) => ({
      example,
      recipes: example.recipeIds
        .map((id) => declared.get(id))
        .filter((recipe): recipe is ApplicationRecipe => !!recipe),
    }))
    .filter((candidate) => candidate.recipes.length > 0);
  const chosen = new Map<number, ApplicationDemoStep>();
  const shown = new Set<string>();
  candidates.forEach((candidate, index) => {
    if (chosen.size >= max) return;
    const recipe = candidate.recipes.find((item) => !shown.has(item.id));
    if (!recipe) return;
    shown.add(recipe.id);
    chosen.set(index, { example: candidate.example, recipe });
  });
  candidates.forEach((candidate, index) => {
    if (chosen.size >= max || chosen.has(index)) return;
    chosen.set(index, {
      example: candidate.example,
      recipe: candidate.recipes[0],
    });
  });
  return [...chosen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, step]) => step);
}

/** What the demo of ``app`` shows. */
export function planApplicationDemo(
  app: ApplicationSummary,
  max = MAX_DEMO_EXAMPLES,
): ApplicationDemoPlan {
  return {
    pluginId: app.pluginId,
    name: app.name || app.pluginId,
    description: app.description.trim(),
    steps: pickDemoSteps(app.recipes, app.examples, max),
  };
}

/** Examples of an application from its method cards (each card lists the
 *  examples designed for it) and its datasets (examples of no method). */
export function collectExamples(
  cards: readonly {
    recipeId: string;
    examples: readonly Omit<ApplicationExample, "recipeIds">[];
  }[],
  datasets: readonly Omit<ApplicationExample, "recipeIds">[] = [],
): ApplicationExample[] {
  const examples = new Map<string, ApplicationExample>();
  for (const card of cards) {
    for (const example of card.examples) {
      const known = examples.get(example.id);
      if (known) {
        if (!known.recipeIds.includes(card.recipeId)) {
          known.recipeIds.push(card.recipeId);
        }
      } else {
        examples.set(example.id, { ...example, recipeIds: [card.recipeId] });
      }
    }
  }
  for (const dataset of datasets) {
    if (!examples.has(dataset.id)) {
      examples.set(dataset.id, { ...dataset, recipeIds: [] });
    }
  }
  return [...examples.values()];
}

/** Caption hold for ``text``: long enough to read it (scaled by the pace
 *  by the engine). */
export function readingTime(text: string, minMs = 2500, maxMs = 7000): number {
  return Math.round(Math.min(maxMs, Math.max(minMs, 1400 + 42 * text.length)));
}

/** Objects of ``after`` missing from ``before`` (same kind and ID). */
export function newObjects(
  before: readonly WorkspaceObject[],
  after: readonly WorkspaceObject[],
): WorkspaceObject[] {
  const known = new Set(before.map((obj) => `${obj.kind}:${obj.id}`));
  return after.filter((obj) => !known.has(`${obj.kind}:${obj.id}`));
}

/** "500 signals", "20 images and 1 signal"… (kinds in first-seen order). */
export function describeObjects(objects: readonly WorkspaceObject[]): string {
  const counts = new Map<WorkspaceObject["kind"], number>();
  for (const obj of objects) {
    counts.set(obj.kind, (counts.get(obj.kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([kind, count]) => {
    if (kind === "signal") {
      return count === 1 ? t("1 signal") : t("{count} signals", { count });
    }
    return count === 1 ? t("1 image") : t("{count} images", { count });
  });
  return parts.length > 1
    ? t("{first} and {second}", { first: parts[0], second: parts[1] })
    : (parts[0] ?? "");
}

/** Number of objects reported by the Applications window status after a
 *  method ran (``"Created 5 objects"``, in English or French), or
 *  ``null``. */
export function parseCreatedCount(
  status: string | null | undefined,
  templates: readonly string[] = [
    "Created {count} objects",
    "{count} objets créés",
  ],
): number | null {
  if (!status) return null;
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const template of templates) {
    const [before, after = ""] = template.split("{count}");
    const match = new RegExp(`^${escape(before)}(\\d+)${escape(after)}$`).exec(
      status.trim(),
    );
    if (match) return Number(match[1]);
  }
  return null;
}
