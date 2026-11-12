import {
  clearField,
  isVisible,
  text,
  type Point,
  type ShowcaseContext,
  type ShowcaseScenario,
} from "../engine";
import { formatNumber, isAppLabel, t } from "../i18n";
import { answerFilePicker, fetchDemoFile } from "../pickers";
import {
  cellNumber,
  clickEnabledTab,
  currentTheme,
  elementWithText,
  plotPoint,
  rememberTheme,
  restoreTheme,
  resultTables,
  showResults,
  THEME_TOGGLE,
  waitForStablePlot,
} from "./common";

/**
 * W1 — Interactive imaging, zero install.
 *
 * Opens the NDT demo workspace of DataLab Web (``demos/ndt.h5``, a
 * synthetic radiograph) from the File menu, follows a defect with the
 * cross profiles, measures its width on the extracted profile (FWHM),
 * moves a region of interest onto other indications and computes its
 * statistics, runs the Canny edge detection from the command palette with
 * a live preview, then shows the dark theme (the visitor's theme is always
 * restored).
 */

/** NDT demo workspace, shipped with DataLab Web. */
const DEMO_WORKSPACE = "demos/ndt.h5";

/** Indications of the synthetic radiograph (pixel coordinates): the
 *  vertical profile through "compact-04" is a clean dip on a flat
 *  background (the horizontal one is dominated by the thickness gradient),
 *  so its FWHM is the width of the defect. */
const PROFILED_DEFECT = { x: 368, y: 352 };
/** Rectangle drawn around "compact-03", then moved onto the overlapping
 *  pair "compact-04"/"compact-05". */
const ROI_DRAW = { x0: 298, y0: 188, x1: 346, y1: 242 };
const ROI_TARGET = { x: 376, y: 356 };

const IMAGE_HOST = ".image-plot-host";
const HEATMAP_HOST = ".image-plot-cell-heatmap .image-plot-host";
const PLOT_AREA = "main.plot-area";
const SIDE_PANEL = "aside.side-panel";
const ROI_EDITOR = ".roi-floating";

async function imageCount(ctx: ShowcaseContext): Promise<number> {
  return (await ctx.bridge.listImages()).length;
}

/** 1. The demo workspace, opened from the File menu. */
async function openWorkspace(ctx: ShowcaseContext): Promise<void> {
  const file = await fetchDemoFile(new URL(DEMO_WORKSPACE, ctx.frame.src));
  await ctx.say(
    t("DataLab Web runs entirely in this browser tab: nothing to install."),
    2500,
  );
  await ctx.say(
    t(
      "Open a workspace from the File menu: a synthetic radiograph for non-destructive testing.",
    ),
    1200,
  );
  await answerFilePicker(
    ctx.frame,
    [file],
    () => ctx.clickMenuPath("File", "file.open_workspace_h5"),
    {
      waitFor: (probe, timeoutMs, what) => ctx.waitFor(probe, timeoutMs, what),
      log: (message) => ctx.log(message),
    },
  );
  await ctx.checkpoint(
    async () => (await imageCount(ctx)) === 1,
    "the NDT demo workspace is loaded (one image)",
    30_000,
  );
  await clickEnabledTab(ctx, "Images");
  await ctx.click(".object-tree-item");
  await waitForStablePlot(ctx, IMAGE_HOST);
  await ctx.spotlight(PLOT_AREA, 4);
  await ctx.say(
    t("The dark spots and streaks are the defects to inspect."),
    4000,
  );
  ctx.clearSpotlight();
}

/** Width of the FWHM segment in the result tables (NaN without one). */
function fwhmWidth(ctx: ShowcaseContext): number {
  for (const table of resultTables(ctx)) {
    if (!/fwhm/i.test(table.title)) continue;
    const row = table.rows[0] ?? [];
    // Geometry results show their displayed values (a single Δx column
    // for a segment); the ROI column, if any, comes first.
    const values = row.slice(table.headers[0] === "ROI" ? 1 : 0);
    const width = cellNumber(values[0]);
    if (Number.isFinite(width)) return Math.abs(width);
  }
  return Number.NaN;
}

/** 2. Live cross profiles, frozen on a defect, extracted and measured. */
async function crossProfiles(ctx: ShowcaseContext): Promise<void> {
  const toggle = elementWithText(ctx, ".image-tools-button", "Cross profiles");
  await ctx.spotlight(toggle, 6);
  await ctx.say(
    t("Cross profiles: intensity cuts that follow the pointer."),
    1800,
  );
  await ctx.click(toggle);
  ctx.clearSpotlight();
  const host = await waitForStablePlot(ctx, HEATMAP_HOST);
  await ctx.spotlight(".image-plot-grid", 4);
  const at = (x: number, y: number): Point => plotPoint(host, x, y);
  for (const [x, y] of [
    [150, 120],
    [430, 190],
    [250, 300],
    [170, 380],
  ]) {
    await ctx.moveTo(at(x, y));
    await ctx.hold(800);
  }
  await ctx.checkpoint(
    () => ctx.$(".image-plot-cell-xprofile .js-plotly-plot") !== null,
    "the cross profiles follow the pointer",
    5_000,
  );
  await ctx.say(t("A click freezes the cross on a defect."), 1200);
  await ctx.clickAt(at(PROFILED_DEFECT.x, PROFILED_DEFECT.y));
  await ctx.checkpoint(
    () => host.classList.contains("profiles-frozen"),
    "a click on the image freezes the cross profiles",
    5_000,
  );
  await ctx.hold(2500);

  const extract = ".image-plot-cell-yprofile .image-profile-extract";
  await ctx.spotlight(extract, 6);
  await ctx.say(
    t("Extract the vertical profile through the defect as a new signal."),
    1800,
  );
  await ctx.click(extract);
  ctx.clearSpotlight();
  await ctx.checkpoint(
    async () => (await ctx.bridge.listSignals()).length === 1,
    "the extracted profile is a new signal",
    20_000,
  );
  await ctx.waitFor(
    () => ctx.tab("Signals")?.getAttribute("aria-selected") === "true",
    10_000,
    "the Signals panel to show the profile",
  );
  await ctx.waitFor(".object-tree-item", 10_000);
  await ctx.spotlight(PLOT_AREA, 4);
  await ctx.say(
    t("The profile lands in the Signals panel: the dip is the defect."),
    3000,
  );
  ctx.clearSpotlight();

  await ctx.say(t("Analysis: full width at half-maximum."), 800);
  await ctx.clickMenuPath("Analysis", "analysis.signal.fwhm");
  await ctx.confirmDialogIfAny();
  await showResults(ctx);
  let width = Number.NaN;
  await ctx.checkpoint(
    () => {
      width = fwhmWidth(ctx);
      return width > 4 && width < 40;
    },
    "the FWHM of the defect profile is measured (4 to 40 pixels)",
    20_000,
  );
  const card = resultTables(ctx).find((table) => /fwhm/i.test(table.title));
  await ctx.spotlight(card?.card ?? SIDE_PANEL, 6);
  await ctx.say(
    t("The defect is {width} pixels wide at half depth.", {
      width: formatNumber(width),
    }),
    4500,
  );
  ctx.clearSpotlight();
}

/** Rectangle of the ROI selected in the ROI editor (its X₀, Y₀, ΔX, ΔY
 *  fields), ``null`` without one. */
function roiCenter(ctx: ShowcaseContext): Point | null {
  const editor = ctx.visible(ROI_EDITOR);
  if (!editor) return null;
  const values = ctx
    .$$<HTMLInputElement>(".roi-field-grid input[type='number']", editor)
    .map((input) => Number(input.value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [x0, y0, dx, dy] = values;
  return { x: x0 + dx / 2, y: y0 + dy / 2 };
}

/** Centre of the image ROI once ``accept`` holds (checkpoint). */
async function roiCenterWhen(
  ctx: ShowcaseContext,
  accept: (center: Point) => boolean,
  message: string,
): Promise<Point> {
  const found: { center: Point | null } = { center: null };
  await ctx.checkpoint(
    () => {
      const center = roiCenter(ctx);
      found.center = center && accept(center) ? center : null;
      return found.center !== null;
    },
    message,
    10_000,
  );
  return found.center as Point;
}

/** Statistics computed inside a region of interest (a result table with a
 *  ROI column whose rows are ROI indexes). */
function hasRoiStatistics(ctx: ShowcaseContext): boolean {
  return resultTables(ctx).some(
    (table) =>
      table.headers[0] === "ROI" &&
      table.rows.some((row) => /^\d+$/.test(row[0] ?? "")),
  );
}

/** 3. A rectangular ROI, drawn, dragged, then its statistics. */
async function regionOfInterest(ctx: ShowcaseContext): Promise<void> {
  await clickEnabledTab(ctx, "Images");
  await ctx.waitFor(".object-tree-item", 10_000);
  const host = await waitForStablePlot(ctx, IMAGE_HOST);
  await ctx.say(
    t("Regions of interest: draw a rectangle around a defect."),
    1000,
  );
  await ctx.clickMenuPath("ROI", "image_roi.edit");
  await ctx.waitFor(`${ROI_EDITOR} .roi-draw-btn.active`, 10_000);
  await ctx.spotlight(PLOT_AREA, 4);
  const at = (x: number, y: number): Point => plotPoint(host, x, y);
  await ctx.drag(at(ROI_DRAW.x0, ROI_DRAW.y0), at(ROI_DRAW.x1, ROI_DRAW.y1));
  const start = await roiCenterWhen(
    ctx,
    () => true,
    "a rectangular ROI is drawn on the image",
  );
  await ctx.hold(1500);
  await ctx.say(t("Grab it and move it onto another defect."), 900);
  await ctx.drag(at(start.x, start.y), [
    at((start.x + ROI_TARGET.x) / 2 + 20, (start.y + ROI_TARGET.y) / 2),
    at(ROI_TARGET.x, ROI_TARGET.y),
  ]);
  await roiCenterWhen(
    ctx,
    (center) =>
      Math.hypot(center.x - ROI_TARGET.x, center.y - ROI_TARGET.y) < 25,
    "the ROI is dragged onto the other defect",
  );
  // DataLab Web saves the ROI drawn on the plot after a short debounce.
  await ctx.delay(500);
  await ctx.hold(2000);
  await ctx.click(`${ROI_EDITOR} .roi-panel-close`);
  ctx.clearSpotlight();

  await ctx.say(t("Statistics, computed inside the region of interest."), 800);
  await ctx.clickMenuPath("Analysis", "analysis.image.stats");
  await showResults(ctx);
  await ctx.checkpoint(
    () => hasRoiStatistics(ctx),
    "the statistics are computed inside the ROI",
    20_000,
  );
  await ctx.spotlight(SIDE_PANEL, 0);
  await ctx.hold(4500);
  ctx.clearSpotlight();
}

/** 4. Canny edge detection from the command palette, with a live preview. */
async function edgeDetection(ctx: ShowcaseContext): Promise<void> {
  await ctx.say(
    t(
      "Every feature is a few keystrokes away: Ctrl+K opens the command palette.",
    ),
    1500,
  );
  await ctx.press("Control+k");
  const input = await ctx.waitFor(".command-palette-input", 5_000);
  await ctx.type(input, "canny", 8);
  const item = () =>
    ctx
      .$$(".command-palette-item")
      .find(
        (li) =>
          isVisible(li) &&
          /canny/i.test(text(li.querySelector(".command-palette-label"))),
      );
  await ctx.waitFor(item, 5_000, "the Canny filter in the command palette");
  await ctx.spotlight(".command-palette", 6);
  await ctx.hold(900);
  await ctx.click(item);
  ctx.clearSpotlight();

  const dialog = await ctx.waitFor(".processing-dataset-dialog", 15_000);
  await ctx.spotlight(dialog, 6);
  await ctx.say(t("Tune the parameters with a live preview."), 1000);
  const preview = dialog.querySelector<HTMLInputElement>(
    'input[name="preview_enabled"]',
  );
  if (!preview) throw new Error("The Canny dialog has no preview");
  if (!preview.checked) await ctx.click(preview);
  const previewUpToDate = () =>
    isAppLabel(
      dialog.querySelector(".processing-preview-status")?.textContent,
      "Preview up to date",
    );
  await ctx.checkpoint(
    previewUpToDate,
    "the Canny preview is computed",
    30_000,
  );
  await ctx.say(
    t("With little smoothing, the noise makes edges everywhere…"),
    2500,
  );
  const sigma = dialog.querySelector<HTMLInputElement>(
    '.dataset-form input[type="number"]',
  );
  if (!sigma) throw new Error("The Canny dialog has no sigma field");
  await ctx.click(sigma);
  clearField(sigma);
  await ctx.type(sigma, "3", 4);
  await ctx.checkpoint(
    () => sigma.value === "3",
    "the Canny sigma is set to 3",
  );
  await ctx.checkpoint(
    () =>
      previewUpToDate() &&
      (dialog.querySelector(".processing-preview-plot")?.textContent ?? "")
        .replace(/\s+/g, "")
        .includes("sigma=3"),
    "the Canny preview is updated with sigma = 3",
    30_000,
  );
  await ctx.say(t("…more smoothing keeps the edges of the defects."), 3000);
  const imagesBefore = await imageCount(ctx);
  await ctx.confirmDialogIfAny(2_000);
  ctx.clearSpotlight();
  await ctx.checkpoint(
    async () => {
      const images = await ctx.bridge.listImages();
      return (
        images.length === imagesBefore + 1 &&
        images.some((image) => /canny/i.test(image.title))
      );
    },
    "the Canny edge image is created",
    30_000,
  );
  await waitForStablePlot(ctx, IMAGE_HOST, 15_000);
  await ctx.spotlight(PLOT_AREA, 4);
  await ctx.say(
    t("Edge detection outlines the defects and the detector artifacts."),
    4000,
  );
  ctx.clearSpotlight();
}

/** 5. The dark theme, then back to the visitor's theme. */
async function darkTheme(ctx: ShowcaseContext): Promise<void> {
  const original = currentTheme(ctx);
  await ctx.spotlight(THEME_TOGGLE, 8);
  await ctx.say(t("Light or dark: one click switches the theme."), 1200);
  await ctx.click(THEME_TOGGLE);
  ctx.clearSpotlight();
  await ctx.checkpoint(
    () => currentTheme(ctx) !== original,
    "the theme toggle switches the theme",
    3_000,
  );
  await ctx.say(t("The plots and images follow the theme too."), 4000);
  await ctx.click(THEME_TOGGLE);
  await ctx.checkpoint(
    () => currentTheme(ctx) === original,
    "the original theme is restored",
    3_000,
  );
  await ctx.hold(600);
}

export const w1Imaging: ShowcaseScenario = {
  id: "w1",
  title: () => t("Interactive imaging, zero install"),
  subtitle: () =>
    t("Images, profiles and measurements, straight from a web page"),
  async run(ctx) {
    const theme = rememberTheme(ctx);
    try {
      await openWorkspace(ctx);
      await crossProfiles(ctx);
      await regionOfInterest(ctx);
      await edgeDetection(ctx);
      await darkTheme(ctx);
    } finally {
      // Never leave the visitor's theme or the ROI editor changed.
      restoreTheme(ctx, theme);
      try {
        ctx.$(`${ROI_EDITOR} .roi-panel-close`)?.click();
      } catch {
        // DataLab Web is reloading.
      }
    }
  },
};
