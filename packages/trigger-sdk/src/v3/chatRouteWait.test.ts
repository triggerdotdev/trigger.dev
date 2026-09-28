import { SessionChannelRouter, WaitpointTimeoutError } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { waitForChatRouteAfterIdle } from "./chatRouteWait.js";

function inputRouter() {
  return new SessionChannelRouter({
    kindOf: (data) => (data as { kind?: string }).kind,
    routes: [
      { name: "messages", delivery: "queue", replayable: true, kinds: ["message"] },
      { name: "control", delivery: "queue", replayable: false, kinds: ["control"] },
    ],
  });
}

describe("chat route waits after suspension", () => {
  it("re-suspends after a wake that has no record for the requested route", async () => {
    const router = inputRouter();
    const timeouts: Array<string | undefined> = [];
    let now = 0;

    const result = await waitForChatRouteAfterIdle(router, "messages", {
      timeout: "10s",
      postWakeTimeoutMs: 0,
      now: () => now,
      wake: async (timeout) => {
        timeouts.push(timeout);
        if (timeouts.length === 1) {
          router.ingest({ id: "control-1", seqNum: 1, data: { kind: "control" } });
          now = 4_000;
          return { ok: true, waitpointId: "waitpoint-1" };
        }
        return { ok: false, error: new WaitpointTimeoutError("Timed out") };
      },
    });

    expect(result.ok).toBe(false);
    expect(timeouts).toEqual(["10s", "6s"]);
  });

  it("does not re-wake on an unrelated queued message while waiting for another route", async () => {
    const router = inputRouter();
    const cursors: Array<number | undefined> = [];

    const result = await waitForChatRouteAfterIdle(router, "control", {
      postWakeTimeoutMs: 0,
      wake: async (_timeout, lastSeqNum) => {
        cursors.push(lastSeqNum);
        if (cursors.length === 1) {
          router.ingest({ id: "message-1", seqNum: 1, data: { kind: "message" } });
          return { ok: true, waitpointId: "waitpoint-1" };
        }
        if (lastSeqNum === undefined || lastSeqNum < 1) {
          return { ok: true, waitpointId: "waitpoint-repeated" };
        }
        return { ok: false, error: new WaitpointTimeoutError("Timed out") };
      },
    });

    expect(result.ok).toBe(false);
    expect(cursors).toEqual([undefined, 1]);
    expect(router.resumeFloor()).toBe(0);
    expect(router.hasPending("messages")).toBe(true);
  });

  it("expires an absolute timeout after an unmatched wake", async () => {
    const router = inputRouter();
    const deadline = Date.parse("2026-09-28T10:15:00Z");
    let now = deadline - 1_000;
    const timeouts: Array<string | undefined> = [];

    const result = await waitForChatRouteAfterIdle(router, "messages", {
      timeout: "2026-09-28T10:15:00Z",
      postWakeTimeoutMs: 0,
      now: () => now,
      wake: async (timeout) => {
        timeouts.push(timeout);
        now = deadline + 1;
        return { ok: true, waitpointId: "waitpoint-1" };
      },
    });

    expect(result.ok).toBe(false);
    expect(timeouts).toEqual(["1s"]);
  });

  it("returns a matching record delivered after the channel wakes", async () => {
    const router = inputRouter();
    const message = { id: "message-1", seqNum: 1, data: { kind: "message", text: "hello" } };

    const result = await waitForChatRouteAfterIdle(router, "messages", {
      timeout: "10s",
      postWakeTimeoutMs: 0,
      wake: async () => {
        router.ingest(message);
        return { ok: true, waitpointId: "waitpoint-1" };
      },
    });

    expect(result).toEqual({ ok: true, record: message });
  });
});
