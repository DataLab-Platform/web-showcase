import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFrame, BOOT_ATTEMPTS } from "../../src/frame";
import { ShowcaseAborted } from "../../src/pause";

/** AppFrame whose DataLab Web fails to start ``failures`` times. */
class FlakyFrame extends AppFrame {
  attempts = 0;
  unloads = 0;

  constructor(private failures: number) {
    super(document.body, new URL("http://localhost/web/"));
  }

  override async load(): Promise<void> {
    this.attempts += 1;
  }

  override unload(): void {
    this.unloads += 1;
  }

  override async waitReady(): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("DataLab Web failed to start: runtime error");
    }
  }
}

describe("DataLab Web start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries again when DataLab Web fails to start", async () => {
    const frame = new FlakyFrame(BOOT_ATTEMPTS - 1);
    const retries: number[] = [];
    const started = frame.start(undefined, undefined, (attempt) =>
      retries.push(attempt),
    );
    await vi.runAllTimersAsync();
    await expect(started).resolves.toBeUndefined();
    expect(frame.attempts).toBe(BOOT_ATTEMPTS);
    expect(retries).toEqual([1, 2]);
  });

  it("gives up after the last attempt", async () => {
    const frame = new FlakyFrame(BOOT_ATTEMPTS);
    const started = frame.start();
    const outcome = expect(started).rejects.toThrow("failed to start");
    await vi.runAllTimersAsync();
    await outcome;
    expect(frame.attempts).toBe(BOOT_ATTEMPTS);
  });

  it("stops at once when the showcase is quit", async () => {
    const frame = new FlakyFrame(1);
    const controller = new AbortController();
    const started = frame.start(controller.signal);
    const outcome = expect(started).rejects.toBeInstanceOf(ShowcaseAborted);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await outcome;
    expect(frame.attempts).toBe(1);
  });
});
