import { expect, test, type Page } from "@playwright/test";
import { expectAllPassed, logShowcase, waitForShowcase } from "./helpers";

/**
 * The showcase plays every demo against a DataLab Web of the same origin,
 * in check mode (``speed=0``: no pauses, no overlays), and leaves the
 * visitor's AI Assistant state exactly as it was.
 */

/** Every demo, DataLab Web booting and reloading between them included. */
const PLAYLIST_TIMEOUT_MS = 40 * 60_000;

/** AI Assistant state of a visitor, which the W4 demo must not change. */
const VISITOR_AI_STATE: Record<string, string> = {
  "datalab-web.aiassistant.settings": JSON.stringify({
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    temperature: 0.3,
    maxHistoryMessages: 20,
  }),
  "datalab-web.aiassistant.inputHistory": JSON.stringify([
    "Plot the FFT of the selected signal",
  ]),
  "datalab-web.aiPanelVisible": "false",
  "datalab-web.aiPanelCollapsed": "false",
};

const AI_PREFIXES = ["datalab-web.aiassistant", "datalab-web.aiPanel"];

/** ``localStorage`` entries of the AI Assistant. */
function aiStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate((prefixes) => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        entries[key] = localStorage.getItem(key)!;
      }
    }
    return entries;
  }, AI_PREFIXES);
}

test.describe("showcase check", () => {
  test("plays every demo and keeps the visitor's AI settings", async ({
    page,
  }) => {
    test.setTimeout(PLAYLIST_TIMEOUT_MS + 60_000);
    logShowcase(page);
    // Same origin as DataLab Web: seed the visitor's state first.
    await page.goto("/web-showcase/seed-visitor-state");
    await page.evaluate((state) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(state)) {
        localStorage.setItem(key, value);
      }
    }, VISITOR_AI_STATE);

    await page.goto("/web-showcase/?demos=all&speed=0&lang=en");
    const status = await waitForShowcase(page, PLAYLIST_TIMEOUT_MS);
    console.log(
      status.results
        .map(
          (result) =>
            `${result.status.padEnd(7)} ${result.id} (${Math.round(result.durationMs / 1000)} s)${result.error ? ` — ${result.error}` : ""}`,
        )
        .join("\n"),
    );
    console.log(`typing: ${JSON.stringify(status.typing)}`);
    expectAllPassed(status);
    expect(status.playlist.slice(0, 1)).toEqual(["w1"]);
    for (const id of ["w1", "w2", "w3", "w4"]) {
      expect(status.playlist).toContain(id);
    }
    expect(status.results.map((result) => result.id)).toEqual(status.playlist);
    expect(status.checks["w4.aiStateRestored"]).toBe(true);
    expect(await aiStorage(page)).toEqual(VISITOR_AI_STATE);
  });

  test("refuses to drive a DataLab Web of another origin", async ({ page }) => {
    await page.goto(
      "/web-showcase/?app=https%3A%2F%2Fexample.com%2Fweb%2F&lang=en",
    );
    const status = await waitForShowcase(page, 10_000);
    expect(status.state).toBe("error");
    expect(status.error).toContain("same origin");
    await expect(page.locator(".showcase-card-title")).toHaveText(
      "The showcase cannot start",
    );
    await expect(page.locator("iframe")).toHaveCount(0);
  });

  test("closes its window after one pass with close=1", async ({ context }) => {
    test.setTimeout(5 * 60_000);
    // A window opened by a script may be closed by a script.
    const opener = await context.newPage();
    await opener.goto("/web-showcase/seed-visitor-state");
    const [page] = await Promise.all([
      context.waitForEvent("page"),
      opener.evaluate(() =>
        window.open(
          "/web-showcase/?demos=none&close=1&speed=0.05&lang=en",
          "_blank",
        ),
      ),
    ]);
    logShowcase(page);
    await page.waitForEvent("close", { timeout: 4 * 60_000 });
    expect(page.isClosed()).toBe(true);
  });
});
