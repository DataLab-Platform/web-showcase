/**
 * Showcase player: plays the selected demos, once or in a loop, with the
 * overlays and the operator hotkeys, and publishes its progress in
 * ``window.__showcase`` (read by the check harness).
 *
 * Robustness for unattended kiosks: every demo runs in a try/catch (a
 * failure is logged, a discreet notice is shown and the next demo starts
 * from a fresh workspace) and, in a loop, the page reloads every
 * ``reloadEvery`` loops (same URL: the showcase restarts by itself with a
 * fresh DataLab Web). With ``close=1`` (a "web interlude" of DataLab
 * desktop), a single pass ends by closing the window.
 *
 * Operator hotkeys (real keyboard only, on the host page and in DataLab
 * Web): F9 requests a pause (applied at the next hold), pressed again
 * pauses at once, then resumes; Shift+F12 stops after the current demo,
 * pressed again stops at once, and leaves DataLab Web to the visitors
 * until pressed again (or Esc quits). While the demos play, → or Page Down
 * skips to the next step, End to the next demo, Home restarts the demo and
 * + / - change the pace; a control bar (``controls``) shows up when the
 * operator moves the mouse.
 *
 * With a welcome menu (:class:`ShowcaseSetup`), DataLab Web boots and the
 * demos are listed while the operator chooses; the demos start once they
 * press Start.
 */

import { ControlBar, rateLabel, type ControlView } from "./controls";
import {
  PUBLIC_WEB_URL,
  ScenarioSkipped,
  ShowcaseAborted,
  ShowcaseContext,
  type ShowcaseScenario,
} from "./engine";
import { AppBridge, AppFrame, type FrameWindow } from "./frame";
import { t } from "./i18n";
import type { ShowcaseOptions } from "./options";
import { ShowcaseOverlay } from "./overlay";
import { PauseController, sleep, stepPace } from "./pause";
import { buildPlaylist, selectScenarios } from "./playlist";
import { typingReport, type TypingReport } from "./codemirror";

export type ShowcaseState =
  | "booting"
  | "menu"
  | "running"
  | "stopped"
  | "done"
  | "aborted"
  | "reloading"
  | "closing"
  | "error";

export interface ShowcaseResult {
  id: string;
  title: string;
  /** ``interrupted``: ended by the operator (next demo, restart, stop
   *  now). */
  status: "passed" | "failed" | "skipped" | "interrupted";
  error?: string;
  durationMs: number;
  loop: number;
}

/** Progress of the showcase, published as ``window.__showcase``. */
export interface ShowcaseStatus {
  state: ShowcaseState;
  options: ShowcaseOptions;
  loop: number;
  current: string | null;
  /** Demos of the playlist, in playing order. */
  playlist: string[];
  results: ShowcaseResult[];
  /** How the CodeMirror editors were typed into. */
  typing: TypingReport;
  /** Checks of the visitor's state (e.g. AI settings restored). */
  checks: Record<string, boolean>;
  error?: string;
}

declare global {
  interface Window {
    __showcase?: ShowcaseStatus;
  }
}

/** Choices of the welcome menu applied to the options. */
export type SetupChoice = Pick<
  ShowcaseOptions,
  "skip" | "loop" | "speed" | "reloadEvery" | "controls"
>;

/** Welcome menu (see ``./menu``), open while DataLab Web boots. */
export interface ShowcaseSetup {
  /** Boot status of DataLab Web (``ready``: it has started and the demos
   *  are listed). */
  setStatus(text: string, ready?: boolean): void;
  /** Every available demo, once the application plugins are listed. */
  setDemos(scenarios: readonly ShowcaseScenario[]): void;
  /** The operator's choices, once they press Start. */
  readonly choice: Promise<SetupChoice>;
  /** Close the menu, e.g. when the showcase cannot start. */
  close(): void;
}

/** Time left to the browser to close the window (``close=1``) before the
 *  showcase concludes that it refused to. */
const CLOSE_GRACE_MS = 1500;
/** Error card shown before closing the window (``close=1``). */
const ERROR_CLOSE_DELAY_MS = 8_000;
/** Error card shown before the page reloads (``loop=1``). */
const ERROR_RESTART_DELAY_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShowcasePlayer {
  private readonly overlay: ShowcaseOverlay | null;
  private readonly pause = new PauseController();
  private readonly abort = new AbortController();
  readonly status: ShowcaseStatus;
  private readonly ctx: ShowcaseContext;
  private stopRequested = false;
  private idle = false;
  /** What plays: a demo (title card included), the end card, or neither
   *  (boot, welcome menu, between demos). */
  private phase: "scenario" | "end" | null = null;
  /** Operator's navigation once the current demo is interrupted. */
  private pendingAction: "next" | "restart" | null = null;
  private demoIndex = 0;
  private demoTitle = "";
  private demoStarted = 0;
  private bar: ControlBar | null = null;

  constructor(
    private readonly frame: AppFrame,
    private options: ShowcaseOptions,
    overlay: ShowcaseOverlay,
    private readonly setup: ShowcaseSetup | null = null,
  ) {
    this.overlay = options.check ? null : overlay;
    this.status = {
      state: "booting",
      options,
      loop: 0,
      current: null,
      playlist: [],
      results: [],
      typing: typingReport,
      checks: {},
    };
    window.__showcase = this.status;
    this.ctx = new ShowcaseContext(frame, new AppBridge(frame), {
      speed: options.speed,
      check: options.check,
      overlay: this.overlay,
      pause: this.pause,
      signal: this.abort.signal,
    });
    this.ctx.checks = this.status.checks;
  }

  /** Boot DataLab Web behind the boot card, then play the demos. */
  async play(): Promise<ShowcaseStatus> {
    const removeHotkeys = this.installHotkeys();
    const unsubscribe = this.pause.onChange(() => this.updateBadge());
    const ctx = this.ctx;
    let reloading = false;
    let closing = false;
    try {
      this.showBootCard();
      await this.frame.start(
        this.abort.signal,
        (text) =>
          this.bootStatus(
            text || t("Please wait until the Python runtime is ready."),
          ),
        () => this.bootStatus(t("DataLab Web did not start, trying again…")),
      );
      ctx.markFresh();
      this.status.state = "running";
      if (this.overlay) {
        this.overlay.mount();
        this.overlay.shield(true, () => this.onShieldPointer());
      }
      this.bootStatus(t("Looking for application plugins…"));
      const all = await buildPlaylist(ctx);
      if (this.setup) {
        this.setup.setDemos(all);
        this.setup.setStatus(t("DataLab Web is ready."), true);
        this.status.state = "menu";
        this.applyChoice(await this.setup.choice);
        this.status.state = "running";
      }
      const { scenarios, unknown } = selectScenarios(
        all,
        this.options.ids,
        this.options.skip,
      );
      this.status.playlist = scenarios.map((scenario) => scenario.id);
      for (const id of unknown) {
        ctx.log(`unknown demo "${id}"`);
        this.status.results.push({
          id,
          title: id,
          status: "failed",
          error: `Unknown showcase demo "${id}"`,
          durationMs: 0,
          loop: 1,
        });
      }
      // Warm up behind the boot card, so that no demo starts with a cold
      // Python worker.
      this.overlay?.cardStatus(t("Preparing the demos…"), "boot");
      await this.prewarm(scenarios);
      await this.overlay?.clearCard(600, "boot");
      this.createControlBar();
      for (let loop = 1; scenarios.length > 0; loop++) {
        this.status.loop = loop;
        for (let index = 0; index < scenarios.length;) {
          this.demoIndex = index;
          this.pendingAction = null;
          await this.playScenario(scenarios[index], loop);
          const restart = this.pendingAction === "restart";
          this.pendingAction = null;
          if (this.stopRequested) await this.waitWhileStopped();
          if (!restart) index++;
        }
        // A window closing after this pass keeps its end card until it goes.
        this.phase = "end";
        try {
          await ctx.endCard(5000, { keep: this.options.close });
        } finally {
          this.phase = null;
        }
        if (!this.options.loop) break;
        // Stopped during the end card: before the next loop.
        if (this.stopRequested) await this.waitWhileStopped();
        const { reloadEvery } = this.options;
        if (reloadEvery > 0 && loop % reloadEvery === 0) {
          // Same URL: the showcase restarts with a fresh DataLab Web. The
          // iframe goes first: a discarded frame never asks "leave the
          // page?" (modified workspace).
          reloading = true;
          this.status.state = "reloading";
          this.frame.unload();
          window.location.reload();
          return this.status;
        }
      }
      this.bar?.setActive(false);
      if (!this.options.close) {
        // DataLab Web may still be reloading (e.g. after W4): the visitors
        // get it back ready.
        await ctx.settleReload().catch((error: unknown) => {
          console.error("[showcase] DataLab Web did not reload", error);
        });
      }
      this.status.state = "done";
      if (this.options.close) {
        closing = true;
        await this.closeWindow();
      }
    } catch (error) {
      if (error instanceof ShowcaseAborted) {
        this.status.state = "aborted";
      } else {
        console.error("[showcase] stopped by an error", error);
        this.status.state = "error";
        this.status.error = errorMessage(error);
        this.status.results.push({
          id: "showcase",
          title: "showcase",
          status: "failed",
          error: errorMessage(error),
          durationMs: 0,
          loop: this.status.loop,
        });
        this.showErrorCard(errorMessage(error));
        if (this.options.close) {
          // A web interlude never hangs: DataLab desktop waits for the
          // window to close.
          closing = true;
          await sleep(ERROR_CLOSE_DELAY_MS).catch(() => undefined);
          await this.closeWindow().catch(() => undefined);
        } else if (this.options.loop) {
          // Unattended kiosk: start afresh a little later.
          this.overlay?.cardNote(t("The showcase restarts in a minute."));
          window.setTimeout(() => {
            this.frame.unload();
            window.location.reload();
          }, ERROR_RESTART_DELAY_MS);
        }
      }
    } finally {
      removeHotkeys();
      unsubscribe();
      this.bar?.destroy();
      this.bar = null;
      this.setup?.close();
      this.status.current = null;
      if (!reloading && !closing && this.status.state !== "error") {
        // The visitors get DataLab Web back.
        this.overlay?.unmount();
      }
    }
    return this.status;
  }

  /** Status line of the boot card, also shown by the welcome menu. */
  private bootStatus(text: string): void {
    this.overlay?.cardStatus(text, "boot");
    this.setup?.setStatus(text);
  }

  /** Apply the choices of the welcome menu. */
  private applyChoice(choice: SetupChoice): void {
    this.options = { ...this.options, ...choice };
    this.status.options = this.options;
    this.ctx.setSpeed(this.options.speed);
  }

  /** Card covering DataLab Web while it boots. */
  private showBootCard(): void {
    if (!this.overlay) return;
    this.overlay.mount();
    this.overlay.card(
      {
        kicker: t("DataLab Web · live demo"),
        title: t("Full DataLab in your browser"),
        subtitle: t(
          "Python, NumPy, SciPy, Sigima in WebAssembly — no install, no server",
        ),
        note: PUBLIC_WEB_URL,
        spinner: true,
      },
      "boot",
    );
  }

  private showErrorCard(message: string): void {
    if (!this.overlay) return;
    this.overlay.clearAll();
    void this.overlay.clearCard(0, "boot");
    this.overlay.shield(false);
    this.overlay.setMode("idle");
    this.overlay.card(
      {
        kicker: t("DataLab Web · live demo"),
        title: t("The showcase cannot start"),
        subtitle: message,
      },
      "error",
    );
  }

  /**
   * ``close=1`` (web interlude): close the window after its single pass,
   * its end card still shown. A browser closes by script only the windows
   * that a script opened or that have a single history entry (e.g. an
   * app window opened with ``--app=<url>``); when it refuses, the end card
   * stays with a discreet "You can close this window" badge.
   */
  private async closeWindow(): Promise<void> {
    const failed = this.status.state === "error";
    this.status.state = "closing";
    this.ctx.log("closing the window");
    // A discarded frame never asks "leave the page?" (modified workspace),
    // which would keep the window open.
    this.frame.unload();
    window.close();
    await sleep(CLOSE_GRACE_MS, this.abort.signal);
    this.ctx.log("the browser kept the window open");
    this.status.state = failed ? "error" : "done";
    this.overlay?.setMode("idle");
    this.overlay?.shield(false);
    this.overlay?.badge(t("You can close this window."), "idle");
    // DataLab Web comes back behind the end card.
    void this.frame.load().catch(() => undefined);
  }

  private async prewarm(scenarios: ShowcaseScenario[]): Promise<void> {
    const ctx = this.ctx;
    for (const scenario of scenarios) {
      if (!scenario.prewarm) continue;
      ctx.beginScenario(scenario);
      try {
        await scenario.prewarm(ctx);
      } catch (error) {
        if (error instanceof ShowcaseAborted) throw error;
        if (error instanceof ScenarioSkipped) continue;
        console.warn(`[showcase] prewarm of "${scenario.id}" failed`, error);
        if (this.options.check) {
          this.status.results.push({
            id: `${scenario.id}:prewarm`,
            title: scenario.title(),
            status: "failed",
            error: errorMessage(error),
            durationMs: 0,
            loop: 0,
          });
        }
      } finally {
        ctx.endScenario();
      }
    }
  }

  private async playScenario(
    scenario: ShowcaseScenario,
    loop: number,
  ): Promise<void> {
    const ctx = this.ctx;
    const started = performance.now();
    const result: ShowcaseResult = {
      id: scenario.id,
      title: scenario.title(),
      status: "passed",
      durationMs: 0,
      loop,
    };
    this.status.current = scenario.id;
    this.demoTitle = result.title;
    this.demoStarted = performance.now();
    this.phase = "scenario";
    ctx.beginScenario(scenario);
    this.bar?.refresh();
    try {
      // The workspace is reset behind the title card.
      await ctx.titleCard(scenario.title(), scenario.subtitle?.(), 3000, () =>
        ctx.resetWorkspace(),
      );
      await scenario.run(ctx);
    } catch (error) {
      if (error instanceof ShowcaseAborted) throw error;
      if (!this.pause.interrupted) {
        result.error = errorMessage(error);
        if (error instanceof ScenarioSkipped) {
          result.status = "skipped";
          ctx.log(`skipped: ${result.error}`);
        } else {
          result.status = "failed";
          console.error(`[showcase] demo "${scenario.id}" failed`, error);
          if (!ctx.check) {
            await ctx
              .notice(t("This demo hit a snag — moving on to the next one."))
              .catch(() => undefined);
          }
        }
      }
    } finally {
      // Whatever the scenario raised once interrupted, it was interrupted.
      if (this.pause.interrupted && result.status === "passed") {
        result.status = "interrupted";
        ctx.log("interrupted by the operator");
      }
      this.phase = null;
      ctx.endScenario();
      result.durationMs = Math.round(performance.now() - started);
      this.status.results.push(result);
      this.status.current = null;
    }
  }

  /** Shift+F12: leave DataLab Web to the visitors until pressed again (or
   *  Esc quits). */
  private async waitWhileStopped(): Promise<void> {
    const ctx = this.ctx;
    this.idle = true;
    this.bar?.setActive(false);
    this.status.state = "stopped";
    ctx.clearCaption();
    ctx.clearSpotlight();
    this.overlay?.shield(false);
    this.overlay?.setMode("idle");
    this.updateBadge();
    ctx.log("stopped (Shift+F12 resumes, Esc quits)");
    try {
      while (this.stopRequested) await sleep(250, this.abort.signal);
    } finally {
      this.idle = false;
    }
    this.status.state = "running";
    this.overlay?.setMode("autoplay");
    this.overlay?.shield(true, () => this.onShieldPointer());
    this.bar?.setActive(true);
    this.updateBadge();
    ctx.log("resuming");
  }

  /** Operator hotkeys, on the host page and in DataLab Web (which has the
   *  keyboard focus once a demo clicked in it). */
  private installHotkeys(): () => void {
    const handler = (event: KeyboardEvent) => {
      // Only the operator's real keyboard: the demos' own (synthetic) key
      // presses must not drive the player.
      if (!event.isTrusted || !this.handleKey(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const listen = (win: Window) =>
      win.addEventListener("keydown", handler, true);
    let frameWindow: FrameWindow | null = null;
    listen(window);
    const removeFrameListener = this.frame.onLoad((win) => {
      frameWindow = win;
      listen(win);
    });
    return () => {
      window.removeEventListener("keydown", handler, true);
      removeFrameListener();
      try {
        frameWindow?.removeEventListener("keydown", handler, true);
      } catch {
        // DataLab Web is gone.
      }
    };
  }

  /** Run the operator's hotkey ``event``; returns whether it was one. */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.key === "F9" && !event.ctrlKey && !event.altKey) {
      this.pause.press();
      return true;
    }
    if (event.key === "F12" && event.shiftKey) {
      this.stopKey();
      return true;
    }
    if (event.key === "Escape" && this.idle) {
      this.abort.abort();
      return true;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (!this.navigable) return false;
    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
        this.nextStep();
        return true;
      case "End":
        this.nextDemo();
        return true;
      case "Home":
        this.restart();
        return true;
      case "+":
      case "=":
        this.changePace(true);
        return true;
      case "-":
        this.changePace(false);
        return true;
      default:
        return false;
    }
  }

  /** Whether the navigation (steps, demos, pace) applies: the demos play,
   *  with the overlays (not in check mode). */
  private get navigable(): boolean {
    return this.overlay !== null && this.phase !== null && !this.idle;
  }

  /** Shift+F12: stop after the current demo, then stop now; once stopped,
   *  resume. */
  private stopKey(): void {
    if (this.idle) {
      this.stopRequested = false;
    } else if (!this.stopRequested) {
      this.stopRequested = true;
      this.pause.release();
    } else if (this.phase === "scenario") {
      this.pause.interrupt();
    } else if (this.phase === "end") {
      this.pause.skipHold();
    }
    this.updateBadge();
  }

  /** Cancel a stop after the demo; a stop now cannot be cancelled. */
  private cancelStop(): void {
    if (this.idle || this.pause.interrupted) return;
    this.stopRequested = false;
    this.updateBadge();
  }

  private nextStep(): void {
    if (this.phase === "scenario") this.pause.requestStep();
    else if (this.phase === "end") this.pause.skipHold();
  }

  private nextDemo(): void {
    if (this.phase === "scenario") {
      this.pendingAction = "next";
      this.pause.interrupt();
    } else if (this.phase === "end") {
      this.pause.skipHold();
    }
  }

  private restart(): void {
    if (this.phase !== "scenario") return;
    this.pendingAction = "restart";
    this.pause.interrupt();
  }

  /** ``+`` / ``-``: change the pace at once (not remembered). */
  private changePace(faster: boolean): void {
    const pace = stepPace(this.ctx.baseSpeed, faster);
    this.ctx.setSpeed(pace);
    this.ctx.log(`pace ${rateLabel(pace)}`);
    this.overlay?.badge(
      t("Pace {rate}", { rate: rateLabel(pace) }),
      "info",
      2000,
    );
    this.bar?.refresh();
  }

  /** Control bar, unless disabled (``controls=0``) or in check mode. */
  private createControlBar(): void {
    if (!this.overlay || !this.options.controls) return;
    this.bar = new ControlBar(
      {
        pause: () => this.pause.press(),
        nextStep: () => this.nextStep(),
        nextDemo: () => this.nextDemo(),
        restart: () => this.restart(),
        stop: () => this.stopKey(),
        cancelStop: () => this.cancelStop(),
        slower: () => this.changePace(false),
        faster: () => this.changePace(true),
      },
      () => this.controlView(),
    );
    this.bar.setActive(true);
  }

  private controlView(): ControlView {
    return {
      pause: this.pause.state,
      stopPending: this.stopRequested && !this.pause.interrupted,
      pace: this.ctx.baseSpeed,
      demo: this.demoIndex + 1,
      total: this.status.playlist.length,
      title: this.demoTitle,
      step: this.ctx.step,
      ending: this.phase === "end",
      elapsedMs: performance.now() - this.demoStarted,
    };
  }

  private updateBadge(): void {
    this.bar?.refresh();
    if (!this.overlay) return;
    const state = this.pause.state;
    if (state === "paused") {
      this.overlay.badge(t("Paused — F9 to resume"), "pause");
    } else if (state === "requested") {
      this.overlay.badge(t("Pause requested — F9 again to pause now"), "pause");
    } else if (state === "pausing") {
      this.overlay.badge(t("Pausing… — F9 to resume"), "pause");
    } else if (this.idle) {
      this.overlay.badge(
        t("Showcase stopped — Shift+F12 to resume, Esc to quit"),
        "idle",
      );
    } else if (this.stopRequested) {
      this.overlay.badge(
        t("Stopping after this demo — Shift+F12 again to stop now"),
      );
    } else {
      this.overlay.badge(null);
    }
  }

  /** A visitor touched the screen while a demo plays. */
  private onShieldPointer(): void {
    if (!this.overlay || this.pause.isPaused || this.stopRequested) return;
    this.overlay.badge(
      t("Live demo in progress — Shift+F12 to take over"),
      "info",
      3500,
    );
  }
}
