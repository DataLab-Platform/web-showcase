import { expect, type Page } from "@playwright/test";

/** Progress of the showcase (``window.__showcase``, see src/player.ts). */
export interface ShowcaseStatus {
  state: string;
  loop: number;
  playlist: string[];
  results: {
    id: string;
    title: string;
    status: "passed" | "failed" | "skipped";
    error?: string;
    durationMs: number;
  }[];
  typing: Record<string, number>;
  checks: Record<string, boolean>;
  error?: string;
}

/** Wait for the showcase to end, then return its status. */
export async function waitForShowcase(
  page: Page,
  timeoutMs: number,
): Promise<ShowcaseStatus> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __showcase?: ShowcaseStatus }).__showcase
              ?.state ?? null,
        ),
      { timeout: timeoutMs, intervals: [2_000] },
    )
    .toMatch(/^(done|aborted|error)$/);
  return page.evaluate(
    () => (window as unknown as { __showcase: ShowcaseStatus }).__showcase,
  );
}

/** Log the showcase console output (captions, demo progress, errors). */
export function logShowcase(page: Page): void {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[showcase") || message.type() === "error") {
      console.log(`[${message.type()}] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
}

/** Every demo passed (or was skipped for a missing prerequisite). */
export function expectAllPassed(status: ShowcaseStatus): void {
  const failures = status.results
    .filter((result) => result.status === "failed")
    .map((result) => `${result.id}: ${result.error}`);
  expect(failures, failures.join("\n")).toEqual([]);
  expect(status.state).toBe("done");
  for (const result of status.results) {
    expect(["passed", "skipped"]).toContain(result.status);
  }
}
