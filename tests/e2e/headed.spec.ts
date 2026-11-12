import { test } from "@playwright/test";
import { expectAllPassed, logShowcase, waitForShowcase } from "./helpers";

/**
 * Watch the showcase on screen (``npm run showcase:headed``): every demo
 * once, at the pace of ``SHOWCASE_SPEED`` (default 1), in the language of
 * ``SHOWCASE_LANG`` (default en).
 */

test("plays every demo on screen", async ({ page }) => {
  test.setTimeout(90 * 60_000);
  logShowcase(page);
  const speed = process.env.SHOWCASE_SPEED ?? "1";
  const lang = process.env.SHOWCASE_LANG ?? "en";
  const demos = process.env.SHOWCASE_DEMOS ?? "all";
  await page.goto(
    `/web-showcase/?demos=${demos}&speed=${speed}&lang=${lang}&reload=0`,
  );
  expectAllPassed(await waitForShowcase(page, 85 * 60_000));
});
