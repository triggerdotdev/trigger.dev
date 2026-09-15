import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
  HEAD_START_FAILURE_ERROR_TEXT,
  writeHeadStartFailureToSessionOut,
  type DashboardAgentSessionOutWriter,
} from "~/services/dashboardAgentHeadStart.server";

function createFakeWriter(
  opts: { failChunk?: Error; failTurnComplete?: Error } = {}
): DashboardAgentSessionOutWriter & { calls: string[]; chunks: UIMessageChunk[] } {
  const calls: string[] = [];
  const chunks: UIMessageChunk[] = [];
  return {
    calls,
    chunks,
    async writeChunk(chunk) {
      calls.push("chunk");
      chunks.push(chunk);
      if (opts.failChunk) throw opts.failChunk;
    },
    async writeTurnComplete() {
      calls.push("turn-complete");
      if (opts.failTurnComplete) throw opts.failTurnComplete;
    },
  };
}

describe("writeHeadStartFailureToSessionOut", () => {
  it("writes an error chunk followed by turn-complete", async () => {
    const writer = createFakeWriter();

    await writeHeadStartFailureToSessionOut(writer);

    expect(writer.calls).toEqual(["chunk", "turn-complete"]);
    expect(writer.chunks).toEqual([{ type: "error", errorText: HEAD_START_FAILURE_ERROR_TEXT }]);
  });

  it("does not leak the underlying failure into the chat", async () => {
    const writer = createFakeWriter();

    await writeHeadStartFailureToSessionOut(writer);

    const errorText = (writer.chunks[0] as { errorText: string }).errorText;
    expect(errorText).not.toMatch(/api|key|token|anthropic/i);
    expect(errorText).toMatch(/again/i);
  });

  it("still closes the turn when the error chunk fails to write", async () => {
    const chunkError = new Error("s2 append failed");
    const writer = createFakeWriter({ failChunk: chunkError });

    // A resumed stream only terminates on turn-complete, so it is written even when the error chunk didn't land.
    await expect(writeHeadStartFailureToSessionOut(writer)).rejects.toBe(chunkError);

    expect(writer.calls).toEqual(["chunk", "turn-complete"]);
  });

  it("surfaces a turn-complete write failure to the caller", async () => {
    const turnCompleteError = new Error("s2 control record failed");
    const writer = createFakeWriter({ failTurnComplete: turnCompleteError });

    await expect(writeHeadStartFailureToSessionOut(writer)).rejects.toBe(turnCompleteError);

    expect(writer.calls).toEqual(["chunk", "turn-complete"]);
  });
});
