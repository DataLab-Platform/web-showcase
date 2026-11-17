/**
 * Timing primitives of the showcase and the operator transport controls:
 * abortable sleeps, the two-level pause (F9), the step navigation (next
 * step, next demo, restart) and the interruption of a playing demo.
 */

/** Raised inside a scenario when the showcase is quit (Esc). */
export class ShowcaseAborted extends Error {
  constructor() {
    super("showcase aborted");
    this.name = "ShowcaseAborted";
  }
}

/** Raised once inside a scenario when the operator interrupts it (next
 *  demo, restart, stop now): the scenario unwinds, its ``finally`` blocks
 *  restoring the visitor's state. */
export class ShowcaseInterrupted extends Error {
  constructor() {
    super("demo interrupted by the operator");
    this.name = "ShowcaseInterrupted";
  }
}

/** Whether ``error`` ends the scenario on the operator's request (quit or
 *  interruption): never swallow it. */
export function isOperatorStop(error: unknown): boolean {
  return (
    error instanceof ShowcaseAborted || error instanceof ShowcaseInterrupted
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ShowcaseAborted();
}

/** ``setTimeout`` as a promise, rejected with :class:`ShowcaseAborted` when
 *  ``signal`` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ShowcaseAborted());
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new ShowcaseAborted());
    };
    const timer = window.setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pause level: ``requested`` is applied at the next pause point (holds,
 * pointer glides, typed characters); ``immediate`` at any primitive of the
 * engine (waits, clicks, key presses…).
 */
export type PauseLevel = "none" | "requested" | "immediate";

/** Pause as the operator sees it: ``paused`` once a wait of the scenario
 *  is parked because of it. */
export type PauseState = "none" | "requested" | "pausing" | "paused";

/** Pace factor while skipping to the next step (delays × 0.2). */
export const FAST_FORWARD_FACTOR = 0.2;

/** Pace factors (delay multipliers) of the live pace controls, slowest
 *  first. */
export const PACE_STEPS = [2, 1.5, 1, 0.7, 0.5] as const;

/** Pace factor one step faster (``+``) or slower (``-``) than ``factor``,
 *  starting from the nearest step. */
export function stepPace(factor: number, faster: boolean): number {
  let nearest = 0;
  PACE_STEPS.forEach((step, index) => {
    if (Math.abs(step - factor) < Math.abs(PACE_STEPS[nearest] - factor)) {
      nearest = index;
    }
  });
  const index = Math.min(
    PACE_STEPS.length - 1,
    Math.max(0, nearest + (faster ? 1 : -1)),
  );
  return PACE_STEPS[index];
}

/** Operator transport: pause, step navigation and interruption. */
export class PauseController {
  private level: PauseLevel = "none";
  /** Waits currently parked because of the pause. */
  private parked = 0;
  private fastForward = false;
  private pauseAtCaption = false;
  /** Incremented to end the holds under way (next step, end card). */
  private skips = 0;
  private interruptPending = false;
  private unwindingNow = false;
  /** Depth of :meth:`protect` calls (interruptions deferred). */
  private protectedDepth = 0;
  private readonly listeners = new Set<() => void>();

  get isPaused(): boolean {
    return this.level !== "none";
  }

  get pauseLevel(): PauseLevel {
    return this.level;
  }

  /** Whether some wait of the scenario is parked because of the pause. */
  get isEffective(): boolean {
    return this.level !== "none" && this.parked > 0;
  }

  get state(): PauseState {
    if (this.level === "none") return "none";
    if (this.parked > 0) return "paused";
    return this.level === "requested" ? "requested" : "pausing";
  }

  /** Multiplier of the pace: :data:`FAST_FORWARD_FACTOR` while skipping to
   *  the next step, else 1. */
  get stepFactor(): number {
    return this.fastForward ? FAST_FORWARD_FACTOR : 1;
  }

  /** An interruption was requested and the scenario has not ended yet. */
  get interrupted(): boolean {
    return this.interruptPending;
  }

  /** The interrupted scenario unwinds: holds and glides are instant. */
  get unwinding(): boolean {
    return this.unwindingNow;
  }

  setLevel(level: PauseLevel): void {
    if (this.level === level) return;
    this.level = level;
    this.notify();
  }

  setPaused(paused: boolean): void {
    this.setLevel(paused ? "requested" : "none");
  }

  /** F9: request a pause, then pause at once if it is not effective yet,
   *  else resume. */
  press(): PauseState {
    if (this.level === "none") this.setLevel("requested");
    else if (this.level === "requested" && this.parked === 0) {
      this.setLevel("immediate");
    } else this.release();
    return this.state;
  }

  /** Resume (a step request pausing again at the next caption is
   *  cancelled). */
  release(): void {
    this.pauseAtCaption = false;
    this.setLevel("none");
  }

  /** Be notified of changes (pause level, pause effective, navigation);
   *  returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Next step: while playing, the hold under way ends and the demo plays
   * fast until the next caption; while paused, the demo resumes at its
   * normal pace and pauses again at the next caption.
   */
  requestStep(): void {
    this.skips += 1;
    if (this.level !== "none") {
      this.fastForward = false;
      this.pauseAtCaption = true;
      this.level = "none";
    } else {
      this.fastForward = true;
    }
    this.notify();
  }

  /** End the holds under way (e.g. the end card), releasing the pause. */
  skipHold(): void {
    this.skips += 1;
    this.release();
  }

  /** A caption is shown: the next step is reached. */
  captionShown(): void {
    const changed = this.fastForward || this.pauseAtCaption;
    this.fastForward = false;
    if (this.pauseAtCaption) {
      this.pauseAtCaption = false;
      this.level = "requested";
    }
    if (changed) this.notify();
  }

  /** Interrupt the scenario: the next pause point raises
   *  :class:`ShowcaseInterrupted` once, then the scenario unwinds. */
  interrupt(): void {
    this.interruptPending = true;
    this.fastForward = false;
    this.pauseAtCaption = false;
    this.skips += 1;
    this.level = "none";
    this.notify();
  }

  /** The scenario has ended: interruption and fast-forward are over. */
  endScenario(): void {
    this.interruptPending = false;
    this.unwindingNow = false;
    this.fastForward = false;
  }

  /** Run ``fn`` without interruption (e.g. a workspace reset, which must
   *  not leave DataLab Web half reset): a request waits for the next pause
   *  point after it. */
  async protect<T>(fn: () => Promise<T>): Promise<T> {
    this.protectedDepth += 1;
    try {
      return await fn();
    } finally {
      this.protectedDepth -= 1;
    }
  }

  /** Raise :class:`ShowcaseAborted` or, once, :class:`ShowcaseInterrupted`. */
  private raise(signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (
      this.interruptPending &&
      !this.unwindingNow &&
      this.protectedDepth === 0
    ) {
      this.unwindingNow = true;
      throw new ShowcaseInterrupted();
    }
  }

  private blocks(level: Exclude<PauseLevel, "none">): boolean {
    if (this.unwindingNow) return false;
    return level === "requested"
      ? this.level !== "none"
      : this.level === "immediate";
  }

  /** Wait while the pause blocks ``level``; returns the paused time. */
  private async park(
    level: Exclude<PauseLevel, "none">,
    signal?: AbortSignal,
    slice = 50,
  ): Promise<number> {
    if (!this.blocks(level)) return 0;
    const started = Date.now();
    this.parked += 1;
    if (this.parked === 1) this.notify();
    try {
      while (this.blocks(level)) await sleep(slice, signal);
    } finally {
      this.parked -= 1;
      if (this.parked === 0 && this.level !== "none") this.notify();
    }
    return Date.now() - started;
  }

  /** Pause point of the ``requested`` level (holds, glides, typing):
   *  returns the paused time. */
  async pausePoint(signal?: AbortSignal): Promise<number> {
    this.raise(signal);
    const paused = await this.park("requested", signal);
    if (paused > 0) this.raise(signal);
    return paused;
  }

  /** Pause point of the ``immediate`` level (every engine primitive):
   *  returns the paused time, by which deadlines are extended. */
  async gate(signal?: AbortSignal): Promise<number> {
    this.raise(signal);
    const paused = await this.park("immediate", signal);
    if (paused > 0) this.raise(signal);
    return paused;
  }

  /** Real delay of ``ms``, frozen by an immediate pause. */
  async wait(ms: number, signal?: AbortSignal, slice = 50): Promise<void> {
    let end = Date.now() + Math.max(0, ms);
    for (;;) {
      end += await this.gate(signal);
      const left = end - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(slice, left), signal);
    }
  }

  /**
   * Wait until ``ms`` milliseconds of normal-pace time have elapsed, the
   * pace ``factor`` (delay multiplier) being read continuously, so that a
   * change applies in the middle of the hold. Frozen while paused, ended at
   * once by a step request, instant while unwinding. Measured on the clock,
   * so that throttled timers of a background tab do not stretch it.
   */
  async hold(
    ms: number,
    factor: () => number = () => 1,
    signal?: AbortSignal,
    slice = 50,
  ): Promise<void> {
    let remaining = Math.max(0, ms);
    const skips = this.skips;
    let last = Date.now();
    for (;;) {
      const paused = await this.pausePoint(signal);
      if (this.unwindingNow || this.skips !== skips) return;
      const now = Date.now();
      const pace = Math.max(0.01, factor());
      if (paused === 0) remaining -= (now - last) / pace;
      last = now;
      if (remaining <= 0) return;
      await sleep(Math.min(slice, remaining * pace), signal);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
