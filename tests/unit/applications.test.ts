import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../src/i18n";
import {
  applicationScenarioId,
  collectExamples,
  describeObjects,
  newObjects,
  parseCreatedCount,
  pickDemoSteps,
  planApplicationDemo,
  readingTime,
  type ApplicationExample,
  type ApplicationRecipe,
  type ApplicationSummary,
  type WorkspaceObject,
} from "../../src/applications/plan";
import { captionSideFor, treeItemId } from "../../src/applications/ui";
import type { ShowcaseContext } from "../../src/engine";

function recipe(id: string): ApplicationRecipe {
  return { id: `org.example.app:${id}`, title: `Method ${id}` };
}

function example(id: string, recipeIds: string[]): ApplicationExample {
  return {
    id,
    title: `Example ${id}`,
    description: `About example ${id}`,
    recipeIds: recipeIds.map((name) => `org.example.app:${name}`),
  };
}

function application(
  over: Partial<ApplicationSummary> = {},
): ApplicationSummary {
  return {
    pluginId: "org.example.app",
    name: "Example application",
    description: "  Measures things.  ",
    recipes: [recipe("a"), recipe("b"), recipe("c")],
    examples: [],
    tools: 0,
    ...over,
  };
}

const ids = (steps: ReturnType<typeof pickDemoSteps>) =>
  steps.map((step) => `${step.example.id}→${step.recipe.id.split(":")[1]}`);

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

describe("application demo plan", () => {
  const recipes = [recipe("a"), recipe("b"), recipe("c")];

  it("plays the first examples in order, one method each", () => {
    const steps = pickDemoSteps(recipes, [
      example("quickstart", ["a"]),
      example("ladder", ["b", "a"]),
      example("ramp", ["c"]),
    ]);
    expect(ids(steps)).toEqual(["quickstart→a", "ladder→b"]);
  });

  it("prefers a method not shown yet, then fills with the others", () => {
    const steps = pickDemoSteps(recipes, [
      example("demo", ["a"]),
      example("again", ["a"]),
      example("other", ["a", "c"]),
    ]);
    expect(ids(steps)).toEqual(["demo→a", "other→c"]);
    expect(
      ids(pickDemoSteps(recipes, [example("x", ["a"]), example("y", ["a"])])),
    ).toEqual(["x→a", "y→a"]);
    expect(ids(pickDemoSteps(recipes, [example("x", ["a"])], 3))).toEqual([
      "x→a",
    ]);
  });

  it("ignores datasets and methods without a card", () => {
    const steps = pickDemoSteps(recipes, [
      example("dataset", []),
      example("stale", ["gone"]),
      example("mixed", ["gone", "b"]),
    ]);
    expect(ids(steps)).toEqual(["mixed→b"]);
    expect(pickDemoSteps([], [example("x", ["a"])])).toEqual([]);
  });

  it("derives the demo from the Applications window only", () => {
    const plan = planApplicationDemo(
      application({
        examples: [example("quickstart", ["a"]), example("ladder", ["b"])],
      }),
    );
    expect(plan).toMatchObject({
      pluginId: "org.example.app",
      name: "Example application",
      description: "Measures things.",
    });
    expect(ids(plan.steps)).toEqual(["quickstart→a", "ladder→b"]);
  });

  it("falls back to the page when no example targets a method", () => {
    const plan = planApplicationDemo(
      application({ examples: [example("dataset", [])] }),
    );
    expect(plan.steps).toEqual([]);
    expect(planApplicationDemo(application({ name: "" })).name).toBe(
      "org.example.app",
    );
  });

  it("collects the examples of the method cards and the datasets", () => {
    const strip = (item: ApplicationExample) => ({
      id: item.id,
      title: item.title,
      description: item.description,
    });
    const examples = collectExamples(
      [
        {
          recipeId: "r1",
          examples: [example("e2", []), example("e1", [])].map(strip),
        },
        {
          recipeId: "r2",
          examples: [example("e1", []), example("e3", [])].map(strip),
        },
        { recipeId: "r3", examples: [] },
      ],
      [example("data", []), example("e3", [])].map(strip),
    );
    expect(examples.map((item) => [item.id, item.recipeIds])).toEqual([
      ["e2", ["r1"]],
      ["e1", ["r1", "r2"]],
      ["e3", ["r2"]],
      ["data", []],
    ]);
  });
});

describe("application demo helpers", () => {
  const objects: WorkspaceObject[] = [
    { id: "1", kind: "signal", title: "s1" },
    { id: "1", kind: "image", title: "i1" },
  ];

  it("lists the new objects", () => {
    const after: WorkspaceObject[] = [
      ...objects,
      { id: "2", kind: "signal", title: "s2" },
      { id: "3", kind: "image", title: "i3" },
    ];
    expect(newObjects(objects, after).map((obj) => obj.title)).toEqual([
      "s2",
      "i3",
    ]);
    expect(newObjects(after, objects)).toEqual([]);
  });

  it("describes objects per kind, in both languages", () => {
    const many: WorkspaceObject[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `i${i}`,
        kind: "image" as const,
        title: "",
      })),
      { id: "s", kind: "signal", title: "" },
    ];
    expect(describeObjects(many)).toBe("5 images and 1 signal");
    expect(describeObjects(many.slice(0, 1))).toBe("1 image");
    expect(describeObjects([])).toBe("");
    setLocale("fr");
    expect(describeObjects(many)).toBe("5 images et 1 signal");
  });

  it("reads the number of created objects in either language", () => {
    expect(parseCreatedCount("Created 10 objects")).toBe(10);
    expect(parseCreatedCount(" Created 3 objects ")).toBe(3);
    expect(parseCreatedCount("10 objets créés")).toBe(10);
    expect(parseCreatedCount("Example opened")).toBeNull();
    expect(parseCreatedCount(null)).toBeNull();
    expect(parseCreatedCount("Made 2 things", ["Made {count} things"])).toBe(2);
  });

  it("holds captions long enough to read them", () => {
    expect(readingTime("short")).toBe(2500);
    expect(readingTime("x".repeat(500))).toBe(7000);
    expect(readingTime("x".repeat(100))).toBe(5600);
  });

  it("reads tree item IDs and places captions away from targets", () => {
    const item = document.createElement("li");
    item.innerHTML =
      '<span class="object-tree-title">A</span>' +
      '<div class="object-tree-meta">#9611e8ca · 21 pts</div>';
    expect(treeItemId(item)).toBe("9611e8ca");
    expect(treeItemId(document.createElement("li"))).toBeNull();

    const ctx = {
      frame: { viewport: () => ({ width: 1600, height: 900 }) },
    } as unknown as ShowcaseContext;
    const el = document.createElement("div");
    const at = (top: number, bottom: number) =>
      vi
        .spyOn(el, "getBoundingClientRect")
        .mockReturnValue({ top, bottom } as DOMRect);
    at(800, 850);
    expect(captionSideFor(ctx, el)).toEqual({ position: "top" });
    at(10, 60);
    expect(captionSideFor(ctx, el)).toEqual({ position: "bottom" });
    expect(captionSideFor(ctx, null)).toEqual({});
  });

  it("identifies application demos by plugin ID", () => {
    expect(applicationScenarioId(application())).toBe("app:org.example.app");
    expect(applicationScenarioId({ pluginId: "Org.Example.Other" })).toBe(
      "app:org.example.other",
    );
  });
});
