import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, rateLabel } from "../../src/controls";
import {
  FAST_FORWARD_FACTOR,
  PauseController,
  ShowcaseAborted,
  ShowcaseInterrupted,
  sleep,
  stepPace,
} from "../../src/pause";

/** Whether ``promise`` has settled, without waiting for it. */
function track(promise: Promise<unknown>): { done: boolean } {
  const state = { done: false };
  promise.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  return state;
}

describe("PauseController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds for the requested time", async () => {
    const pause = new PauseController();
    const hold = track(pause.hold(500));
    await vi.advanceTimersByTimeAsync(450);
    expect(hold.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(hold.done).toBe(true);
  });

  it("does not count paused time", async () => {
    const pause = new PauseController();
    const hold = track(pause.hold(300));
    await vi.advanceTimersByTimeAsync(100);
    pause.setPaused(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hold.done).toBe(false);
    expect(pause.press()).toBe("none");
    await vi.advanceTimersByTimeAsync(300);
    expect(hold.done).toBe(true);
  });

  it("pauses at once when pressed twice before the pause applies", async () => {
    const pause = new PauseController();
    const seen: string[] = [];
    pause.onChange(() => seen.push(pause.state));
    expect(pause.press()).toBe("requested");
    // No hold under way: the request has not applied yet.
    expect(pause.press()).toBe("pausing");
    expect(pause.pauseLevel).toBe("immediate");
    const gate = track(pause.gate());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gate.done).toBe(false);
    expect(pause.state).toBe("paused");
    expect(pause.isEffective).toBe(true);
    expect(pause.press()).toBe("none");
    await vi.advanceTimersByTimeAsync(100);
    expect(gate.done).toBe(true);
    expect(seen).toEqual(["requested", "pausing", "paused", "none"]);
  });

  it("tracks when a requested pause becomes effective", async () => {
    const pause = new PauseController();
    const seen: string[] = [];
    pause.onChange(() => seen.push(pause.state));
    pause.press();
    // The primitives other than holds do not stop at a requested pause.
    await expect(pause.gate()).resolves.toBe(0);
    const hold = track(pause.hold(200));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pause.state).toBe("paused");
    // Pressed once the pause applies: resume.
    expect(pause.press()).toBe("none");
    await vi.advanceTimersByTimeAsync(250);
    expect(hold.done).toBe(true);
    expect(seen).toEqual(["requested", "paused", "none"]);
  });

  it("returns the time a gate stayed paused", async () => {
    const pause = new PauseController();
    pause.setLevel("immediate");
    const paused = pause.gate();
    await vi.advanceTimersByTimeAsync(2_000);
    pause.release();
    await vi.advanceTimersByTimeAsync(100);
    await expect(paused).resolves.toBeGreaterThanOrEqual(2_000);
  });

  it("freezes real delays during an immediate pause", async () => {
    const pause = new PauseController();
    const wait = track(pause.wait(500));
    await vi.advanceTimersByTimeAsync(200);
    pause.setLevel("immediate");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(wait.done).toBe(false);
    pause.release();
    await vi.advanceTimersByTimeAsync(250);
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(wait.done).toBe(true);
  });

  it("applies a pace change in the middle of a hold", async () => {
    const pause = new PauseController();
    let factor = 1;
    const hold = track(pause.hold(1_000, () => factor));
    await vi.advanceTimersByTimeAsync(500);
    // Half the hold left, now twice as slow: 1 s more.
    factor = 2;
    await vi.advanceTimersByTimeAsync(900);
    expect(hold.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(hold.done).toBe(true);
  });

  it("skips to the next step fast while playing", async () => {
    const pause = new PauseController();
    const hold = track(pause.hold(10_000));
    await vi.advanceTimersByTimeAsync(100);
    pause.requestStep();
    await vi.advanceTimersByTimeAsync(60);
    expect(hold.done).toBe(true);
    expect(pause.stepFactor).toBe(FAST_FORWARD_FACTOR);
    pause.captionShown();
    expect(pause.stepFactor).toBe(1);
    expect(pause.isPaused).toBe(false);
  });

  it("plays the next step and pauses again when paused", async () => {
    const pause = new PauseController();
    pause.press();
    const hold = track(pause.hold(10_000));
    await vi.advanceTimersByTimeAsync(500);
    expect(pause.state).toBe("paused");
    pause.requestStep();
    await vi.advanceTimersByTimeAsync(100);
    expect(hold.done).toBe(true);
    expect(pause.isPaused).toBe(false);
    expect(pause.stepFactor).toBe(1);
    pause.captionShown();
    expect(pause.state).toBe("requested");
  });

  it("raises an interruption once, then unwinds", async () => {
    const pause = new PauseController();
    pause.press();
    pause.interrupt();
    expect(pause.isPaused).toBe(false);
    expect(pause.interrupted).toBe(true);
    await expect(pause.gate()).rejects.toBeInstanceOf(ShowcaseInterrupted);
    expect(pause.unwinding).toBe(true);
    await expect(pause.gate()).resolves.toBe(0);
    pause.press();
    // Holds are instant while unwinding, even paused.
    const hold = track(pause.hold(60_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(hold.done).toBe(true);
    pause.release();
    pause.endScenario();
    expect(pause.interrupted).toBe(false);
    expect(pause.unwinding).toBe(false);
  });

  it("interrupts a hold under way", async () => {
    const pause = new PauseController();
    const hold = pause.hold(60_000);
    const failed = expect(hold).rejects.toBeInstanceOf(ShowcaseInterrupted);
    await vi.advanceTimersByTimeAsync(100);
    pause.interrupt();
    await vi.advanceTimersByTimeAsync(100);
    await failed;
  });

  it("defers an interruption past a protected section", async () => {
    const pause = new PauseController();
    pause.interrupt();
    await expect(pause.protect(() => pause.gate())).resolves.toBe(0);
    await expect(pause.gate()).rejects.toBeInstanceOf(ShowcaseInterrupted);
  });

  it("aborts holds and sleeps", async () => {
    const pause = new PauseController();
    const controller = new AbortController();
    const hold = pause.hold(10_000, () => 1, controller.signal);
    const nap = sleep(10_000, controller.signal);
    const failures = [
      expect(hold).rejects.toBeInstanceOf(ShowcaseAborted),
      expect(nap).rejects.toBeInstanceOf(ShowcaseAborted),
    ];
    controller.abort();
    await Promise.all(failures);
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(
      ShowcaseAborted,
    );
  });
});

describe("live pace", () => {
  it("steps the pace from the nearest step", () => {
    expect(stepPace(1, true)).toBe(0.7);
    expect(stepPace(1, false)).toBe(1.5);
    expect(stepPace(0.5, true)).toBe(0.5);
    expect(stepPace(2, false)).toBe(2);
    // 1.2 is nearest to 1.
    expect(stepPace(1.2, true)).toBe(0.7);
  });

  it("shows the pace as a rate", () => {
    expect([2, 1.5, 1, 0.7, 0.5].map(rateLabel)).toEqual([
      "×0.5",
      "×0.67",
      "×1",
      "×1.4",
      "×2",
    ]);
    expect(formatElapsed(65_400)).toBe("1:05");
  });
});
