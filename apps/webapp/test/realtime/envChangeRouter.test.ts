import { describe, expect, it, vi } from "vitest";
import {
  EnvChangeRouter,
  type EnvChangeSource,
  type RowHydrator,
} from "~/services/realtime/envChangeRouter.server";
import { type ChangeRecord } from "~/services/realtime/runChangeNotifier.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";

const FLOOR_MS = Date.UTC(2026, 5, 7, 12, 0, 0);

function row(
  id: string,
  opts: { tags?: string[]; createdAtMs?: number; updatedAtMs?: number } = {}
): RealtimeRunRow {
  return {
    id,
    runTags: opts.tags ?? [],
    createdAt: new Date(opts.createdAtMs ?? FLOOR_MS + 1_000),
    updatedAt: new Date(opts.updatedAtMs ?? FLOOR_MS + 5_000),
  } as unknown as RealtimeRunRow;
}

function record(runId: string, extra: Partial<ChangeRecord> = {}): ChangeRecord {
  return { v: 1, runId, envId: "env_1", ...extra };
}

/** A controllable EnvChangeSource: tests push batches to the env's listener. */
function fakeSource() {
  const listeners = new Map<string, Set<(records: ChangeRecord[]) => void>>();
  const source: EnvChangeSource = {
    subscribeToEnv(envId, onBatch) {
      let set = listeners.get(envId);
      if (!set) {
        set = new Set();
        listeners.set(envId, set);
      }
      set.add(onBatch);
      return () => {
        listeners.get(envId)?.delete(onBatch);
      };
    },
  };
  return {
    source,
    push(envId: string, records: ChangeRecord[]) {
      for (const l of listeners.get(envId) ?? []) l(records);
    },
    isSubscribed(envId: string) {
      return (listeners.get(envId)?.size ?? 0) > 0;
    },
  };
}

function makeRouter(
  rowsById: Map<string, RealtimeRunRow> = new Map(),
  options: Record<string, unknown> = {}
) {
  const src = fakeSource();
  const hydrateSpy = vi.fn<RowHydrator["hydrateByIds"]>(async (_env, ids) =>
    ids.map((id) => rowsById.get(id)).filter((r): r is RealtimeRunRow => Boolean(r))
  );
  const router = new EnvChangeRouter({
    source: src.source,
    hydrator: { hydrateByIds: hydrateSpy },
    ...options,
  });
  return { router, src, hydrateSpy };
}

describe("EnvChangeRouter", () => {
  it("routes a tag match to the feed (hydrated + serialized) and ignores non-matches", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    const wait = reg.waitForMatch(undefined, 1_000);

    // A non-matching tag is dropped (no wake); a matching tag wakes with the hydrated row.
    src.push("env_1", [record("rX", { tags: ["b"] }), record("r1", { tags: ["a"] })]);

    const result = await wait;
    expect(result.reason).toBe("notify");
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);
    expect(result.rows[0].value.id).toBe("r1"); // serialized wire value
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", ["r1"], []);
    reg.close();
  });

  it("batch-hydrates ONCE and shares the serialized value across feeds matching the same run", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const regs = [
      router.register("env_1", { kind: "tag", tags: ["a"] }, []),
      router.register("env_1", { kind: "tag", tags: ["a"] }, []),
    ];
    const waits = regs.map((r) => r.waitForMatch(undefined, 1_000));

    src.push("env_1", [record("r1", { tags: ["a"] })]);
    const results = await Promise.all(waits);

    // One hydrate for the whole tick (same column set), shared by both feeds...
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    // ...and the same serialized value object is reused (serialize-once).
    expect(results[0].rows[0].value).toBe(results[1].rows[0].value);
    regs.forEach((r) => r.close());
  });

  it("a hydrate failure doesn't reject out of the source callback; the feed times out", async () => {
    const src = fakeSource();
    const hydrateSpy = vi.fn<RowHydrator["hydrateByIds"]>(async () => {
      throw new Error("replica down");
    });
    const router = new EnvChangeRouter({
      source: src.source,
      hydrator: { hydrateByIds: hydrateSpy },
    });
    const reg = router.register("env_1", { kind: "run", runId: "r1" }, []);
    const wait = reg.waitForMatch(undefined, 50);

    // Would be an unhandled rejection (process exit) if #onBatch's promise were unguarded.
    src.push("env_1", [record("r1")]);

    const result = await wait;
    expect(result.reason).toBe("timeout");
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    reg.close();
  });

  it("routes a run feed by exact runId", async () => {
    const rows = new Map([["r1", row("r1")]]);
    const { router, src } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "run", runId: "r1" }, []);
    const wait = reg.waitForMatch(undefined, 1_000);
    src.push("env_1", [record("r2"), record("r1")]);
    const result = await wait;
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);
    reg.close();
  });

  it("routes a batch feed by batchId", async () => {
    const rows = new Map([["r1", row("r1")]]);
    const { router, src } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "batch", batchId: "batch_1" }, []);
    const wait = reg.waitForMatch(undefined, 1_000);
    src.push("env_1", [
      record("rX", { batchId: "other" }),
      record("r1", { batchId: "batch_1" }),
    ]);
    const result = await wait;
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);
    reg.close();
  });

  it("drops a tag match created before the feed's createdAt floor", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"], createdAtMs: FLOOR_MS - 10_000 })]]);
    const { router, src } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "tag", tags: ["a"], createdAtFloorMs: FLOOR_MS }, []);
    let settled = false;
    const wait = reg.waitForMatch(undefined, 60).then((r) => {
      settled = true;
      return r;
    });
    src.push("env_1", [record("r1", { tags: ["a"], createdAtMs: FLOOR_MS - 10_000 })]);
    // Hydrated but out-of-window -> not woken; falls through to the timeout.
    const result = await wait;
    expect(settled).toBe(true);
    expect(result.reason).toBe("timeout");
    reg.close();
  });

  it("classifies a partial record (no tags) by hydrating and re-checking the row's tags", async () => {
    // Partial record routes to all tag feeds as candidates; the authoritative row decides.
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src } = makeRouter(rows);
    const match = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    const noMatch = router.register("env_1", { kind: "tag", tags: ["z"] }, []);
    const matchWait = match.waitForMatch(undefined, 1_000);
    let noMatchSettled = false;
    const noMatchWait = noMatch.waitForMatch(undefined, 80).then((r) => {
      noMatchSettled = true;
      return r;
    });

    src.push("env_1", [record("r1", { tags: undefined })]); // partial: tags absent

    expect((await matchWait).rows.map((m) => m.row.id)).toEqual(["r1"]);
    expect((await noMatchWait).reason).toBe("timeout"); // row tags ["a"] don't intersect ["z"]
    expect(noMatchSettled).toBe(true);
    match.close();
    noMatch.close();
  });

  it("times out and aborts cleanly", async () => {
    const { router, src } = makeRouter(new Map(), { unsubscribeLingerMs: 0 });
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    expect((await reg.waitForMatch(undefined, 30)).reason).toBe("timeout");

    const controller = new AbortController();
    const wait = reg.waitForMatch(controller.signal, 5_000);
    controller.abort();
    expect((await wait).reason).toBe("abort");
    reg.close();
    expect(src.isSubscribed("env_1")).toBe(false); // linger disabled: last feed left -> unsubscribed
  });

  it("buffers a record that arrives between polls and replays it on the next arm", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    // Not waiting yet: the push can't wake anything, but it lands in the env buffer.
    src.push("env_1", [record("r1", { tags: ["a"] })]);
    expect(hydrateSpy).not.toHaveBeenCalled();

    const result = await reg.waitForMatch(undefined, 1_000);
    expect(result.reason).toBe("notify");
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    reg.close();
  });

  it("does not redeliver a replayed record on a later arm", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    src.push("env_1", [record("r1", { tags: ["a"] })]);
    expect((await reg.waitForMatch(undefined, 1_000)).reason).toBe("notify");

    // Same buffered record must not fire again; the wait falls through to its timeout.
    expect((await reg.waitForMatch(undefined, 50)).reason).toBe("timeout");
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    reg.close();
  });

  it("lingers the env subscription after the last feed closes and replays the gap", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows, { unsubscribeLingerMs: 60 });
    const reg1 = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    reg1.close();
    expect(src.isSubscribed("env_1")).toBe(true); // lingering

    // The inter-poll gap: a change arrives while no feed is registered.
    src.push("env_1", [record("r1", { tags: ["a"] })]);

    const reg2 = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    const result = await reg2.waitForMatch(undefined, 1_000);
    expect(result.reason).toBe("notify");
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    reg2.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(src.isSubscribed("env_1")).toBe(false); // linger expired -> unsubscribed
  });

  it("reports gapCovered=false on a fresh env subscription and true once it ages past the window", async () => {
    const { router } = makeRouter(new Map(), { replayWindowMs: 50 });
    const reg1 = router.register("env_1", { kind: "run", runId: "r1" }, []);
    expect(reg1.gapCovered).toBe(false);

    await new Promise((r) => setTimeout(r, 70));
    const reg2 = router.register("env_1", { kind: "run", runId: "r2" }, []);
    expect(reg2.gapCovered).toBe(true);
    reg1.close();
    reg2.close();
  });

  it("honors the caller's replaySinceMs so a new poll doesn't rewind into delivered records", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const anchor = router.register("env_1", { kind: "tag", tags: ["a"] }, []); // keeps the env subscribed
    src.push("env_1", [record("r1", { tags: ["a"] })]);
    const afterPush = Date.now();

    // A connection whose last response left after the push: nothing to replay.
    const caughtUp = router.register("env_1", { kind: "tag", tags: ["a"] }, [], {
      replaySinceMs: afterPush,
    });
    expect(caughtUp.gapCovered).toBe(true); // env subscribed since before its gap began
    expect((await caughtUp.waitForMatch(undefined, 50)).reason).toBe("timeout");
    expect(hydrateSpy).not.toHaveBeenCalled();

    // A connection whose gap started before the push: the record replays.
    const behind = router.register("env_1", { kind: "tag", tags: ["a"] }, [], {
      replaySinceMs: afterPush - 1_000,
    });
    const result = await behind.waitForMatch(undefined, 1_000);
    expect(result.reason).toBe("notify");
    expect(result.rows.map((m) => m.row.id)).toEqual(["r1"]);

    anchor.close();
    caughtUp.close();
    behind.close();
  });

  it("caps the replay buffer to the newest records per env", async () => {
    const rows = new Map([
      ["r1", row("r1")],
      ["r2", row("r2")],
      ["r3", row("r3")],
    ]);
    const { router, src, hydrateSpy } = makeRouter(rows, { replayMaxRunsPerEnv: 2 });
    const reg = router.register("env_1", { kind: "batch", batchId: "batch_1" }, []);
    src.push("env_1", [
      record("r1", { batchId: "batch_1" }),
      record("r2", { batchId: "batch_1" }),
      record("r3", { batchId: "batch_1" }),
    ]);

    const result = await reg.waitForMatch(undefined, 1_000);
    expect(result.reason).toBe("notify");
    // r1 was evicted by the cap; only the newest two replay.
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", ["r2", "r3"], []);
    reg.close();
  });
});
