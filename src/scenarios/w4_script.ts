/**
 * W4 replay script: the assistant's answers, played by the mock provider
 * of DataLab Web (``window.__dlwAIMock``, ``src/aiassistant/providers/
 * mock.ts``). Turns whose answer depends on what really happened (the
 * FWHM printed by the macro, the ID of the noisy signal) are getters,
 * evaluated by the mock provider when it answers.
 */

/** Scripted turn, in the format of the DataLab Web mock provider. */
export interface MockTurn {
  content?: string | null;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** "Thinking…" delay before the answer (ms). */
  delayMs?: number;
}

/** Message of the conversation sent to the provider. */
export interface MockMessage {
  role: string;
  content?: unknown;
}

/** Handle of the mock provider of DataLab Web. */
export interface MockHandle {
  setScript(turns: MockTurn[]): void;
  getRequests(): { messages: MockMessage[] }[];
  reset(): void;
}

/** Result of the last tool call of ``messages`` (``undefined`` when it
 *  failed or when there is none). */
export function lastToolResult(messages: readonly MockMessage[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    try {
      const parsed = JSON.parse(String(message.content)) as {
        ok?: boolean;
        result?: unknown;
      };
      return parsed.ok ? parsed.result : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Text output of the last tool call of ``messages`` (stdout of a macro). */
export function lastToolOutput(messages: readonly MockMessage[]): string {
  const result = lastToolResult(messages) as { stdout?: unknown } | undefined;
  return typeof result?.stdout === "string" ? result.stdout : "";
}

/** FWHM printed by the macro (``FWHM = 3.77``), if any. */
export function parseFwhm(output: string): string | null {
  return /FWHM = ([\d.]+)/.exec(output)?.[1] ?? null;
}

/** ID of the signal titled ``title`` in a ``list_signals`` result. */
export function signalIdByTitle(result: unknown, title: string): string | null {
  if (!Array.isArray(result)) return null;
  const match = (result as { id?: unknown; title?: unknown }[]).find(
    (signal) => signal.title === title,
  );
  return typeof match?.id === "string" ? match.id : null;
}

/** A turn computed once, the first time the mock provider reads it. */
export function lazyTurn(
  delayMs: number,
  compute: () => Omit<MockTurn, "delayMs">,
): MockTurn {
  let value: Omit<MockTurn, "delayMs"> | null = null;
  const get = () => (value ??= compute());
  return {
    delayMs,
    get content() {
      return get().content ?? null;
    },
    get toolCalls() {
      return get().toolCalls ?? [];
    },
  };
}
