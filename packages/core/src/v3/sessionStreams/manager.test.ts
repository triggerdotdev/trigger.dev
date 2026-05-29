import { describe, expect, it } from "vitest";
import { StandardSessionStreamManager } from "./manager.js";
import type { ApiClient } from "../apiClient/index.js";
import type { SSEStreamPart } from "../apiClient/runStream.js";

// Single-shot mock that mimics S2's long-poll: delivers `records` once via
// `onPart` on the first subscribe call, then keeps the returned async
// iterable OPEN until the abort signal fires. Real S2 keeps the SSE
// connection alive on a long-poll; the manager's `runTail` finally /
// reconnect path only fires when the connection actually closes. Returning
// an empty stream synchronously triggers a tight reconnect loop, so the
// mock parks indefinitely instead.
function singleShotApiClient(
  records: Array<{ id: string; chunk: unknown; timestamp: number }>
): ApiClient {
  let delivered = false;
  return {
    async subscribeToSessionStream<T>(
      _sessionIdOrExternalId: string,
      _io: "out" | "in",
      options?: { onPart?: (part: SSEStreamPart<T>) => void; signal?: AbortSignal }
    ) {
      if (!delivered) {
        delivered = true;
        for (const record of records) {
          options?.onPart?.(record as SSEStreamPart<T>);
        }
      }
      const signal = options?.signal;
      return (async function* () {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          if (!signal) {
            // No signal — block the stream forever; tests must
            // explicitly call `disconnectStream` / `disconnect` to
            // unblock.
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })() as unknown as Awaited<ReturnType<ApiClient["subscribeToSessionStream"]>>;
    },
  } as unknown as ApiClient;
}

describe("StandardSessionStreamManager — minTimestamp filter", () => {
  const sessionId = "session-1";
  const io = "in" as const;

  it("dispatches records when no filter is set", async () => {
    const records = [
      { id: "0", chunk: { kind: "message", payload: { id: "u1" } }, timestamp: 1000 },
      { id: "1", chunk: { kind: "message", payload: { id: "u2" } }, timestamp: 2000 },
    ];
    const manager = new StandardSessionStreamManager(singleShotApiClient(records), "http://localhost");

    const first = await manager.once(sessionId, io);
    expect(first).toEqual({ ok: true, output: { kind: "message", payload: { id: "u1" } } });

    const second = await manager.once(sessionId, io);
    expect(second).toEqual({ ok: true, output: { kind: "message", payload: { id: "u2" } } });

    manager.disconnectStream(sessionId, io); // stop reconnect loop
    manager.disconnect();
  });

  it("drops records whose timestamp is <= minTimestamp", async () => {
    const records = [
      { id: "0", chunk: { kind: "message", payload: { id: "u1" } }, timestamp: 1000 },
      { id: "1", chunk: { kind: "message", payload: { id: "u2" } }, timestamp: 2000 },
      { id: "2", chunk: { kind: "message", payload: { id: "u3" } }, timestamp: 3000 },
    ];
    const manager = new StandardSessionStreamManager(singleShotApiClient(records), "http://localhost");

    // Cutoff at 2000 (inclusive: `<=` is dropped). Only u3 should pass.
    manager.setMinTimestamp(sessionId, io, 2000);

    const passed = await manager.once(sessionId, io, { timeoutMs: 200 });
    expect(passed).toEqual({ ok: true, output: { kind: "message", payload: { id: "u3" } } });

    manager.disconnectStream(sessionId, io);
    manager.disconnect();
  });

  it("clears the filter when set to undefined", async () => {
    const records = [
      { id: "0", chunk: { kind: "message", payload: { id: "u1" } }, timestamp: 1000 },
    ];
    const manager = new StandardSessionStreamManager(singleShotApiClient(records), "http://localhost");

    manager.setMinTimestamp(sessionId, io, 5000);
    manager.setMinTimestamp(sessionId, io, undefined);

    const passed = await manager.once(sessionId, io, { timeoutMs: 200 });
    expect(passed).toEqual({ ok: true, output: { kind: "message", payload: { id: "u1" } } });

    manager.disconnectStream(sessionId, io);
    manager.disconnect();
  });

  it("filter is per-(sessionId, io) and doesn't bleed across streams", async () => {
    const inApi = singleShotApiClient([
      { id: "0", chunk: { kind: "in-record" }, timestamp: 1000 },
    ]);
    const manager = new StandardSessionStreamManager(inApi, "http://localhost");

    manager.setMinTimestamp(sessionId, "in", 5000);

    // The "out" stream uses the same singleShotApiClient instance — its
    // single-shot delivers the same fixture, but the filter doesn't apply
    // to "out" so the record passes.
    const outResult = await manager.once(sessionId, "out", { timeoutMs: 200 });
    expect(outResult).toEqual({ ok: true, output: { kind: "in-record" } });

    // The "in" stream is filtered (minTimestamp=5000, record ts=1000): the
    // once() call should idle-timeout instead of resolving with the record.
    // But the singleShot instance has already delivered to the "out" tail,
    // so the "in" tail will get nothing on first connect anyway. Use a
    // separate manager+api to keep the assertion crisp.
    const inApi2 = singleShotApiClient([
      { id: "0", chunk: { kind: "in-record-2" }, timestamp: 1000 },
    ]);
    const manager2 = new StandardSessionStreamManager(inApi2, "http://localhost");
    manager2.setMinTimestamp(sessionId, "in", 5000);

    const inResult = await manager2.once(sessionId, "in", { timeoutMs: 100 });
    expect(inResult.ok).toBe(false); // filter-dropped → idle timeout

    manager.disconnectStream(sessionId, "in");
    manager.disconnectStream(sessionId, "out");
    manager.disconnect();
    manager2.disconnectStream(sessionId, "in");
    manager2.disconnect();
  });

  it("reset() clears all per-stream timestamp filters", async () => {
    const records = [
      { id: "0", chunk: { kind: "message", payload: { id: "u1" } }, timestamp: 1000 },
    ];
    const manager = new StandardSessionStreamManager(singleShotApiClient(records), "http://localhost");

    manager.setMinTimestamp(sessionId, io, 5000);
    manager.reset();

    const passed = await manager.once(sessionId, io, { timeoutMs: 200 });
    expect(passed).toEqual({ ok: true, output: { kind: "message", payload: { id: "u1" } } });

    manager.disconnectStream(sessionId, io);
    manager.disconnect();
  });
});
