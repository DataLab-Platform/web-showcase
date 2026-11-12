import { describe, expect, it } from "vitest";
import {
  lastToolOutput,
  lastToolResult,
  lazyTurn,
  parseFwhm,
  signalIdByTitle,
  type MockMessage,
} from "../../src/scenarios/w4_script";

function tool(result: unknown, ok = true): MockMessage {
  return { role: "tool", content: JSON.stringify({ ok, result }) };
}

describe("W4 replay script", () => {
  it("reads the last tool result of the conversation", () => {
    const messages: MockMessage[] = [
      { role: "user", content: "Create a signal" },
      tool({ stdout: "FWHM = 3.77\n" }),
      { role: "assistant", content: "Done" },
      tool([{ id: "s1", title: "Noisy Gaussian" }]),
    ];
    expect(lastToolResult(messages)).toEqual([
      { id: "s1", title: "Noisy Gaussian" },
    ]);
    expect(lastToolOutput(messages.slice(0, 2))).toBe("FWHM = 3.77\n");
    expect(lastToolOutput(messages)).toBe("");
    expect(lastToolResult([tool("x", false)])).toBeUndefined();
    expect(lastToolResult([{ role: "tool", content: "not json" }])).toBe(
      undefined,
    );
    expect(lastToolResult([])).toBeUndefined();
  });

  it("reads the FWHM printed by the macro", () => {
    expect(parseFwhm("…\nFWHM = 3.77\n")).toBe("3.77");
    expect(parseFwhm("no value")).toBeNull();
  });

  it("finds the noisy signal in a list_signals result", () => {
    const signals = [
      { id: "a", title: "gaussian_fit(…)" },
      { id: "b", title: "Noisy Gaussian" },
    ];
    expect(signalIdByTitle(signals, "Noisy Gaussian")).toBe("b");
    expect(signalIdByTitle(signals, "Other")).toBeNull();
    expect(signalIdByTitle({ id: "b" }, "Noisy Gaussian")).toBeNull();
  });

  it("computes a lazy turn once, when the mock provider reads it", () => {
    let calls = 0;
    const turn = lazyTurn(250, () => {
      calls += 1;
      return {
        content: `answer ${calls}`,
        toolCalls: [{ name: "list_signals", arguments: {} }],
      };
    });
    expect(calls).toBe(0);
    expect(turn.delayMs).toBe(250);
    expect(turn.content).toBe("answer 1");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.content).toBe("answer 1");
    expect(calls).toBe(1);
    // As read by the mock provider: setScript copies the array, not the
    // turns.
    const script = [turn].slice();
    expect(script[0].content).toBe("answer 1");
    expect(lazyTurn(0, () => ({})).toolCalls).toEqual([]);
  });
});
