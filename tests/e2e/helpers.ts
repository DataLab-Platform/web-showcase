import { expect, type Page } from "@playwright/test";

/** Progress of the showcase (``window.__showcase``, see src/player.ts). */
export interface ShowcaseStatus {
  state: string;
  options: Record<string, unknown>;
  loop: number;
  playlist: string[];
  results: {
    id: string;
    title: string;
    /** ``interrupted``: ended by the operator, not a failure. */
    status: "passed" | "failed" | "skipped" | "interrupted";
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
    .poll(() => showcaseState(page), {
      timeout: timeoutMs,
      intervals: [2_000],
    })
    .toMatch(/^(done|aborted|error)$/);
  return showcaseStatus(page);
}

/** Progress of the showcase. */
export function showcaseStatus(page: Page): Promise<ShowcaseStatus> {
  return page.evaluate(
    () => (window as unknown as { __showcase: ShowcaseStatus }).__showcase,
  );
}

/** State of the showcase (``null`` before it starts). */
export function showcaseState(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __showcase?: ShowcaseStatus }).__showcase
        ?.state ?? null,
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

/**
 * Every demo passed (or was skipped for a missing prerequisite, or was
 * interrupted by the operator).
 */
export function expectAllPassed(status: ShowcaseStatus): void {
  const failures = status.results
    .filter((result) => result.status === "failed")
    .map((result) => `${result.id}: ${result.error}`);
  expect(failures, failures.join("\n")).toEqual([]);
  expect(status.state).toBe("done");
  for (const result of status.results) {
    expect(["passed", "skipped", "interrupted"]).toContain(result.status);
  }
}
