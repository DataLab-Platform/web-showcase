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
 * Web): F9 pauses/resumes; Shift+F12 stops after the current demo and
 * leaves DataLab Web to the visitors, then resumes when pressed again; Esc
 * quits once stopped.
 */

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
import { PauseController, sleep } from "./pause";
import { buildPlaylist, selectScenarios } from "./playlist";
import { typingReport, type TypingReport } from "./codemirror";

export type ShowcaseState =
  | "booting"
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
  status: "passed" | "failed" | "skipped";
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

  constructor(
    private readonly frame: AppFrame,
    private readonly options: ShowcaseOptions,
    overlay: ShowcaseOverlay,
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
          this.overlay?.cardStatus(
            text || t("Please wait until the Python runtime is ready."),
            "boot",
          ),
        () =>
          this.overlay?.cardStatus(
            t("DataLab Web did not start, trying again…"),
            "boot",
          ),
      );
      ctx.markFresh();
      this.status.state = "running";
      if (this.overlay) {
        this.overlay.mount();
        this.overlay.shield(true, () => this.onShieldPointer());
      }
      this.overlay?.cardStatus(t("Looking for application plugins…"), "boot");
      const all = await buildPlaylist(ctx);
      const { scenarios, unknown } = selectScenarios(all, this.options.ids);
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
      for (let loop = 1; scenarios.length > 0; loop++) {
        this.status.loop = loop;
        for (const scenario of scenarios) {
          await this.playScenario(scenario, loop);
          if (this.stopRequested) await this.waitWhileStopped();
        }
        // A window closing after this pass keeps its end card until it goes.
        await ctx.endCard(5000, { keep: this.options.close });
        if (!this.options.loop) break;
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
      this.status.current = null;
      if (!reloading && !closing && this.status.state !== "error") {
        // The visitors get DataLab Web back.
        this.overlay?.unmount();
      }
    }
    return this.status;
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
    ctx.beginScenario(scenario);
    try {
      // The workspace is reset behind the title card.
      await ctx.titleCard(scenario.title(), scenario.subtitle?.(), 3000, () =>
        ctx.resetWorkspace(),
      );
      await scenario.run(ctx);
    } catch (error) {
      if (error instanceof ShowcaseAborted) throw error;
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
    } finally {
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
    this.updateBadge();
    ctx.log("resuming");
  }

  /** Operator hotkeys, on the host page and in DataLab Web (which has the
   *  keyboard focus once a demo clicked in it). */
  private installHotkeys(): () => void {
    const handler = (event: KeyboardEvent) => {
      // Only the operator's real keyboard: the demos' own (synthetic) key
      // presses must not drive the player.
      if (!event.isTrusted) return;
      if (event.key === "F9" && !event.ctrlKey && !event.altKey) {
        this.pause.toggle();
      } else if (event.key === "F12" && event.shiftKey) {
        this.stopRequested = !this.stopRequested;
        this.updateBadge();
      } else if (event.key === "Escape" && this.idle) {
        this.abort.abort();
      } else {
        return;
      }
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

  private updateBadge(): void {
    if (!this.overlay) return;
    if (this.pause.isPaused) {
      this.overlay.badge(t("Paused — F9 to resume"), "pause");
    } else if (this.idle) {
      this.overlay.badge(
        t("Showcase stopped — Shift+F12 to resume, Esc to quit"),
        "idle",
      );
    } else if (this.stopRequested) {
      this.overlay.badge(t("Stopping after this demo — Shift+F12 to cancel"));
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
