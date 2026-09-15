// Import the test harness first so chat tasks register in its resource catalog.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, label = "condition", timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function errorChunks(harness: { allChunks: unknown[] }) {
  return (harness.allChunks as { type?: string; errorText?: string }[]).filter(
    (c) => c.type === "error"
  );
}

/**
 * A terminal error written into a live response can close it, so by default a
 * mid-turn validation failure is not surfaced to the stream until the turn ends.
 * `clientDataValidationErrorTiming: "arrival"` opts into the earlier report.
 *
 * Both cases run the identical scenario, with a frame that fails validation
 * while the first turn is still open, so the only difference is the setting.
 */
describe("chat.customAgent clientDataValidationErrorTiming", () => {
  async function run(timing: "turn-end" | "arrival" | undefined) {
    const clientData = { sequence: 0 };
    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();
    const validationErrors: unknown[] = [];
    let started = false;

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const sequence = (value as { sequence: number }).sequence;
          if (sequence === 2) {
            throw new Error("invalid mid-turn frame");
          }
          return { sequence };
        },
        ...(timing ? { reportErrorAt: timing } : {}),
        onValidationError: ({ error }) => {
          validationErrors.push(error);
        },
      })
      .customAgent({
        id: `custom-agent-client-data-timing-${timing ?? "default"}`,
        run: async (payload, { signal }) => {
          started = true;
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
            pendingMessages: {},
          });
          for await (const turn of session) {
            firstTurnStarted.resolve();
            await releaseFirstTurn.promise;
            await turn.done();
            break;
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: `custom-agent-client-data-timing-${timing ?? "default"}-chat`,
      clientData,
    });

    try {
      await waitFor(() => started, "run started");
      clientData.sequence = 1;
      const first = harness.sendMessage(userMessage("first", "message-1"));
      await firstTurnStarted.promise;

      // Lands while turn 1 is still open, and fails validation.
      clientData.sequence = 2;
      void harness.sendMessage(userMessage("second", "message-2"));
      await waitFor(() => validationErrors.length === 1, "handler fired");

      // Observed while the turn is still open, before it is released.
      const chunksWhileOpen = errorChunks(harness).length;

      releaseFirstTurn.resolve();
      await first;
      // The default holds the write until the turn closes, so the assertion has
      // to wait for it: without this, "no chunk while open" would also pass if
      // the error were never written at all.
      await waitFor(() => errorChunks(harness).length > 0, "deferred error written");
      return { chunksWhileOpen, chunksAfter: errorChunks(harness).length, validationErrors };
    } finally {
      releaseFirstTurn.resolve();
      await harness.close();
    }
  }

  it("defers the terminal error past an open turn by default", { timeout: 30_000 }, async () => {
    const result = await run(undefined);
    // The handler always fires on arrival; only the stream write is held back.
    expect(result.validationErrors).toHaveLength(1);
    expect(result.chunksWhileOpen).toBe(0);
    expect(result.chunksAfter).toBeGreaterThan(0);
  });

  it('writes the terminal error immediately with "arrival"', { timeout: 30_000 }, async () => {
    const result = await run("arrival");
    expect(result.validationErrors).toHaveLength(1);
    expect(result.chunksWhileOpen).toBeGreaterThan(0);
  });
});
