import { describe, expect, it } from "vitest";
import { __makeChannelProgressObserverForTests } from "../src/v3/ai.js";

describe("chat.agent channel progress observer", () => {
  it("stop() drains the progress events already queued behind a slow post, in order", async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstPostDone = new Promise<void>((r) => (releaseFirst = r));
    const connector = {
      id: "slow-progress",
      progress: async (event: { type: string }) => {
        if (delivered.length === 0) await firstPostDone;
        delivered.push(event.type);
      },
    };
    const observer = __makeChannelProgressObserverForTests(
      connector as never,
      { event: {}, deliveryId: "d" },
      undefined
    );
    observer.observe({ type: "tool-input-start", toolCallId: "t1", toolName: "lookup" });
    observer.observe({ type: "tool-input-available", toolCallId: "t1", input: { id: 1 } });
    observer.observe({ type: "tool-output-available", toolCallId: "t1", output: { ok: true } });
    const stopped = observer.stop();
    observer.observe({ type: "tool-output-error", toolCallId: "t1", errorText: "late" });
    releaseFirst();
    await stopped;
    expect(delivered).toEqual(["tool-call", "tool-result"]);
  });
});
