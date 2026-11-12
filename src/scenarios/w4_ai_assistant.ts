import {
  isVisible,
  ShowcaseAborted,
  text,
  type ShowcaseContext,
  type ShowcaseScenario,
} from "../engine";
import { appLabels, isAppLabel, t } from "../i18n";
import {
  CONVERSATIONS_STORE,
  restoreStorage,
  sameStorage,
  snapshotStorage,
  StoreGuard,
} from "../storage";
import { treeTitles } from "./common";
import {
  lastToolOutput,
  lastToolResult,
  lazyTurn,
  parseFwhm,
  signalIdByTitle,
  type MockHandle,
  type MockTurn,
} from "./w4_script";

/**
 * W4 — AI assistant (replayed session).
 *
 * The visitor's request is typed in the AI Assistant, which proposes a
 * macro (``create_and_run_macro``); the showcase approves it, the macro
 * really runs (noisy Gaussian, Gaussian fit computed by DataLab, FWHM) and
 * the assistant sums up the real result, read on screen. A follow-up
 * request shows a read-only tool running at once (``list_signals``), then
 * a processing (``apply_processing``, moving average) waiting for approval.
 *
 * Only the assistant's answers are scripted, played by the mock provider
 * of DataLab Web (no network), which a permanent label states on screen.
 * The visitor's AI Assistant state is saved first (every ``localStorage``
 * key of the AI Assistant, the conversation history) and restored exactly
 * afterwards, DataLab Web being reloaded so that the visitor's settings
 * apply again.
 */

const PANEL = '[data-testid="ai-assistant-panel"]';
const PANEL_TIMEOUT_MS = 10_000;
/** The macro worker may still be booting (cold browser cache). */
const RUN_TIMEOUT_MS = 180_000;
const MACRO_TOOL_NAME = "create_and_run_macro";

/** ``localStorage`` keys of the AI Assistant (settings, input history,
 *  panel visibility, size and position). */
export const AI_STORAGE_PREFIXES = [
  "datalab-web.aiassistant",
  "datalab-web.aiPanel",
];
const SETTINGS_KEY = "datalab-web.aiassistant.settings";
/** Settings selecting the mock provider (as the DataLab Web tests do). */
const MOCK_SETTINGS = {
  provider: "mock",
  baseUrl: "",
  model: "mock",
  temperature: 0,
  maxHistoryMessages: 0,
};

// -- Replayed conversation ---------------------------------------------------------

function noisyTitle(): string {
  return t("Noisy Gaussian");
}

function fitMacro(): string {
  return [
    "import numpy as np",
    "",
    `# ${t("Noisy Gaussian signal (reproducible noise)")}`,
    "x = np.linspace(-10, 10, 2001)",
    "rng = np.random.default_rng(42)",
    "y = 2.5 * np.exp(-0.5 * ((x - 1) / 1.6) ** 2) + rng.normal(0, 0.08, x.size)",
    `sig = await proxy.add_signal("${noisyTitle()}", x, y)`,
    "",
    `# ${t("Gaussian fit, computed by DataLab")}`,
    'fit = (await proxy.calc("gaussian_fit", sources=[sig]))[0]',
    "",
    `# ${t("FWHM of the fitted curve")}`,
    "xy = await proxy.get_signal_xy(fit)",
    'xf, yf = np.array(xy["x"]), np.array(xy["y"])',
    "above = xf[yf >= (yf.max() + yf.min()) / 2]",
    'print(f"FWHM = {above[-1] - above[0]:.2f}")',
  ].join("\n");
}

interface Replay {
  turns: MockTurn[];
  /** FWHM quoted by the assistant (read from the macro output). */
  fwhm: string | null;
}

/** Assistant turns, the answers depending on what really happened being
 *  computed when the mock provider plays them. */
function replayScript(ctx: ShowcaseContext, mock: MockHandle): Replay {
  const pace = (ms: number) => (ctx.check ? 300 : Math.round(ms * ctx.speed));
  const lastMessages = () => mock.getRequests().at(-1)?.messages ?? [];
  const replay: Replay = { turns: [], fwhm: null };
  replay.turns = [
    {
      delayMs: pace(2200),
      content: t(
        "Sure! I will write a macro that creates the noisy signal, fits a Gaussian with DataLab and measures its full width at half maximum.",
      ),
      toolCalls: [
        {
          name: MACRO_TOOL_NAME,
          arguments: { name: t("Noisy Gaussian fit"), code: fitMacro() },
        },
      ],
    },
    lazyTurn(pace(2000), () => {
      // The macro output, as shown in the conversation (else as sent to
      // the assistant).
      const fwhm =
        parseFwhm(macroOutputOnScreen(ctx)) ??
        parseFwhm(lastToolOutput(lastMessages()));
      replay.fwhm = fwhm;
      return {
        content: fwhm
          ? t(
              "Done! The noisy Gaussian and its fit are now in the Signals panel. The fitted curve has a full width at half maximum of **{fwhm}**.",
              { fwhm },
            )
          : t(
              "The macro did not report the full width at half maximum: see its output above.",
            ),
      };
    }),
    // Follow-up request: a read-only query, then a dedicated processing.
    {
      delayMs: pace(1500),
      toolCalls: [{ name: "list_signals", arguments: {} }],
    },
    lazyTurn(pace(1500), () => {
      const id = signalIdByTitle(lastToolResult(lastMessages()), noisyTitle());
      return id
        ? {
            content: t(
              "I will smooth “{title}” with a 25-point moving average.",
              { title: noisyTitle() },
            ),
            toolCalls: [
              {
                name: "apply_processing",
                arguments: {
                  id,
                  processing_id: "moving_average",
                  params: { n: 25 },
                },
              },
            ],
          }
        : { content: t("I could not find the noisy signal.") };
    }),
    {
      delayMs: pace(1200),
      content: t(
        "Done: the smoothed signal is in the Signals panel, next to the noisy one.",
      ),
    },
  ];
  return replay;
}

// -- DOM helpers ---------------------------------------------------------------------

function panel(ctx: ShowcaseContext): HTMLElement | null {
  try {
    return ctx.doc.querySelector<HTMLElement>(PANEL);
  } catch {
    return null;
  }
}

function buttonIn(
  ctx: ShowcaseContext,
  root: Element | null | undefined,
  selector: string,
  match: (button: HTMLButtonElement) => boolean,
): HTMLButtonElement | null {
  if (!root) return null;
  return (
    ctx
      .$$<HTMLButtonElement>(selector, root)
      .find((button) => isVisible(button) && match(button)) ?? null
  );
}

function byText(label: string) {
  return (button: HTMLButtonElement) => isAppLabel(button.textContent, label);
}

function byLabel(label: string) {
  const labels = appLabels(label);
  return (button: HTMLButtonElement) =>
    labels.includes(button.getAttribute("aria-label") ?? "");
}

/** The assistant is answering (its Stop button replaces Send). */
function isBusy(ctx: ShowcaseContext): boolean {
  return buttonIn(ctx, panel(ctx), ".ai-input button", byText("Stop")) !== null;
}

function bubbleCount(ctx: ShowcaseContext): number {
  return panel(ctx)?.querySelectorAll(".ai-bubble").length ?? 0;
}

function lastAnswer(ctx: ShowcaseContext): HTMLElement | null {
  const answers = panel(ctx)?.querySelectorAll<HTMLElement>(
    ".ai-bubble-assistant:not(.ai-bubble-streaming)",
  );
  return answers && answers.length > 0 ? answers[answers.length - 1] : null;
}

/** Output of the last tool shown in the conversation (macro stdout). */
function macroOutputOnScreen(ctx: ShowcaseContext): string {
  const tools = panel(ctx)?.querySelectorAll(".ai-bubble-tool") ?? [];
  return tools.length > 0 ? text(tools[tools.length - 1]) : "";
}

function panelShown(ctx: ShowcaseContext): boolean {
  return panel(ctx) !== null || ctx.$(".ai-floating-pill") !== null;
}

/** Show the AI Assistant panel (expanded); true if it was hidden. */
async function openPanel(ctx: ShowcaseContext): Promise<boolean> {
  if (ctx.visible(PANEL)) return false;
  const pill = ctx.visible(".ai-floating-pill");
  await ctx.click(pill ?? ".menubar-ai-toggle");
  await ctx.waitFor(PANEL, PANEL_TIMEOUT_MS);
  return true;
}

/** Start from an empty conversation (the panel restores the latest one
 *  when it opens; it stays untouched in the history). */
async function newConversation(
  ctx: ShowcaseContext,
  restoring: boolean,
): Promise<void> {
  if (restoring) {
    try {
      await ctx.waitFor(() => bubbleCount(ctx) > 0, 5_000);
    } catch (error) {
      if (error instanceof ShowcaseAborted) throw error;
    }
  }
  if (bubbleCount(ctx) > 0) {
    await ctx.click(() =>
      buttonIn(
        ctx,
        panel(ctx),
        ".ai-panel-header button",
        byLabel("New conversation"),
      ),
    );
    await ctx.waitFor(
      () => bubbleCount(ctx) === 0,
      5_000,
      "a new conversation",
    );
  }
  await ctx.checkpoint(
    () => bubbleCount(ctx) === 0 && !isBusy(ctx),
    "the AI Assistant starts a new, empty conversation",
  );
}

/** Type ``value`` in the assistant input, as a visitor would, and send it. */
async function ask(ctx: ShowcaseContext, value: string): Promise<void> {
  const input = (await ctx.find(
    `${PANEL} .ai-input textarea`,
  )) as HTMLTextAreaElement;
  input.setSelectionRange(0, input.value.length);
  await ctx.type(input, value, 14);
  await ctx.hold(600);
  await ctx.click(() =>
    buttonIn(
      ctx,
      panel(ctx),
      ".ai-input button",
      (button) => byText("Send")(button) && !button.disabled,
    ),
  );
}

/** Wait for the approval dialog of ``tool``, explain it, then approve. */
async function approve(
  ctx: ShowcaseContext,
  tool: string,
  caption: string,
): Promise<void> {
  const dialog = await ctx.find(".ai-tool-confirm-dialog", 60_000);
  await ctx.checkpoint(
    () => (dialog.textContent ?? "").includes(tool),
    `the assistant asks to approve ${tool}`,
  );
  await ctx.hold(600);
  await ctx.spotlight(dialog);
  await ctx.say(caption, 4500);
  // The caption would hide the dialog buttons.
  ctx.clearCaption();
  await ctx.hold(700);
  ctx.clearSpotlight();
  await ctx.click(() =>
    buttonIn(ctx, dialog, ".actions button", byText("Approve")),
  );
}

/** Plot every signal (select their group) under a spotlight. */
async function showGroup(ctx: ShowcaseContext): Promise<void> {
  await ctx.click(".object-tree-group > :first-child");
  await ctx.hold(800);
  await ctx.spotlight(".plot-area");
}

/** Stop the replayed answer, if any (also rejects a pending approval). */
async function stopAssistant(ctx: ShowcaseContext): Promise<void> {
  try {
    if (!isBusy(ctx)) return;
    buttonIn(ctx, panel(ctx), ".ai-input button", byText("Stop"))?.click();
    const deadline = Date.now() + 30_000;
    while (isBusy(ctx) && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  } catch {
    // DataLab Web is reloading.
  }
}

// -- Scenario ------------------------------------------------------------------------

export const w4AiAssistant: ShowcaseScenario = {
  id: "w4",
  title: () => t("AI assistant (replayed session)"),
  subtitle: () => t("Ask in plain language, DataLab does the processing"),

  async run(ctx) {
    ctx.label(t("Replayed session — simulated AI provider"));
    // Same origin: the storage of DataLab Web is the one of this page.
    const storage = window.localStorage;
    const saved = snapshotStorage(storage, AI_STORAGE_PREFIXES);
    const conversations = await StoreGuard.capture(
      window.indexedDB,
      CONVERSATIONS_STORE.db,
      CONVERSATIONS_STORE.store,
    );
    ctx.log(
      `AI Assistant state saved (${saved.size} localStorage keys, ${conversations.size} conversations)`,
    );
    let changed = false;
    try {
      // The panel reads its settings when it opens: close it first.
      if (panelShown(ctx)) {
        await ctx.click(".menubar-ai-toggle", { instant: true });
        await ctx.waitFor(() => !panelShown(ctx), 5_000, "the panel to close");
      }
      changed = true;
      storage.setItem(SETTINGS_KEY, JSON.stringify(MOCK_SETTINGS));

      await ctx.say(
        t("The AI assistant drives DataLab with the same actions as you."),
      );
      await openPanel(ctx);
      const mock = await ctx.waitFor(
        () =>
          (ctx.win as unknown as { __dlwAIMock?: MockHandle }).__dlwAIMock ??
          null,
        PANEL_TIMEOUT_MS,
        "the mock AI provider of DataLab Web",
      );
      const replay = replayScript(ctx, mock);
      mock.setScript(replay.turns);
      await newConversation(ctx, conversations.size > 0);
      await ctx.say(t("This session is replayed: no data leaves the booth."));

      // The request, typed by the "visitor".
      await ask(
        ctx,
        t("Create a noisy Gaussian signal, fit it and give me its FWHM"),
      );

      // The assistant proposes a macro: nothing runs before approval.
      await approve(
        ctx,
        MACRO_TOOL_NAME,
        t(
          "Nothing runs without your approval: the proposed macro is shown first.",
        ),
      );
      await ctx.say(
        t(
          "Approved: the macro runs in DataLab's Python sandbox, on real data.",
        ),
      );

      // The macro really ran: its objects, then the assistant's summary.
      await ctx.checkpoint(
        () =>
          treeTitles(ctx).includes(noisyTitle()) &&
          treeTitles(ctx).some((title) => title.startsWith("gaussian_fit(")),
        "the noisy signal and its Gaussian fit are in the Signals panel",
        RUN_TIMEOUT_MS,
      );
      const answered = () => mock.getRequests().length;
      await ctx.checkpoint(
        () => answered() === 2 && !isBusy(ctx) && lastAnswer(ctx),
        "the assistant answers once the macro has run",
        RUN_TIMEOUT_MS,
      );
      await ctx.checkpoint(
        () =>
          replay.fwhm !== null && text(lastAnswer(ctx)).includes(replay.fwhm),
        "the answer quotes the FWHM measured by the macro",
      );

      // The agent loop: the macro output went back to the assistant.
      await ctx.spotlight(() => panel(ctx)?.querySelector(".ai-bubble-tool"));
      await ctx.say(
        t(
          "The macro output goes back to the assistant, which reads the measured value.",
        ),
        3500,
      );
      await ctx.spotlight(() => lastAnswer(ctx));
      await ctx.hold(3000);
      ctx.clearSpotlight();

      // Plot both curves (select their group).
      await showGroup(ctx);
      await ctx.say(
        t(
          "Real results: the noisy signal, its Gaussian fit and the measured FWHM.",
        ),
        4000,
      );
      ctx.clearSpotlight();

      // Follow-up: a read-only query runs at once, a processing asks first.
      await ask(ctx, t("Now smooth the noisy signal with a moving average"));
      await approve(
        ctx,
        "apply_processing",
        t(
          "Read-only queries run at once; any change still waits for your approval.",
        ),
      );
      await ctx.checkpoint(
        () => treeTitles(ctx).length === 3,
        "the smoothed signal is in the Signals panel",
        RUN_TIMEOUT_MS,
      );
      await ctx.checkpoint(
        () => answered() === 5 && !isBusy(ctx),
        "the assistant answers once the signal is smoothed",
        RUN_TIMEOUT_MS,
      );
      await ctx.hold(1500);
      await showGroup(ctx);
      await ctx.hold(2500);
      ctx.clearSpotlight();
      await ctx.say(
        t("Bring your own model: OpenAI or a local LLM (Ollama, LM Studio…)."),
        4000,
      );
      await ctx.click(() =>
        buttonIn(
          ctx,
          panel(ctx),
          ".ai-panel-header button",
          byLabel("Hide AI Assistant"),
        ),
      );
    } finally {
      ctx.clearSpotlight();
      ctx.label(null);
      if (changed) {
        await stopAssistant(ctx);
        // DataLab Web is unloaded while the visitor's state is put back, so
        // that nothing can overwrite it, then reloaded with it (in the
        // background: the next workspace reset waits for it).
        let restored = false;
        await ctx.reloadApp(
          async () => {
            restoreStorage(storage, AI_STORAGE_PREFIXES, saved);
            const removed = await conversations.restore();
            restored = sameStorage(storage, AI_STORAGE_PREFIXES, saved);
            ctx.log(
              `AI Assistant state restored (${removed} demo conversation(s) removed, settings identical: ${restored})`,
            );
          },
          {
            defer: true,
            onReady: () => {
              const identical =
                restored && sameStorage(storage, AI_STORAGE_PREFIXES, saved);
              ctx.checks["w4.aiStateRestored"] = identical;
              ctx.log(
                `AI Assistant settings identical after reload: ${identical}`,
              );
            },
          },
        );
      }
    }
  },
};
