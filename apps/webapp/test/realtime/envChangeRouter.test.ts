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

function makeRouter(rowsById: Map<string, RealtimeRunRow> = new Map()) {
  const src = fakeSource();
  const hydrateSpy = vi.fn<RowHydrator["hydrateByIds"]>(async (_env, ids) =>
    ids.map((id) => rowsById.get(id)).filter((r): r is RealtimeRunRow => Boolean(r))
  );
  const router = new EnvChangeRouter({ source: src.source, hydrator: { hydrateByIds: hydrateSpy } });
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
    const { router, src } = makeRouter();
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    expect((await reg.waitForMatch(undefined, 30)).reason).toBe("timeout");

    const controller = new AbortController();
    const wait = reg.waitForMatch(controller.signal, 5_000);
    controller.abort();
    expect((await wait).reason).toBe("abort");
    reg.close();
    expect(src.isSubscribed("env_1")).toBe(false); // last feed left -> unsubscribed
  });

  it("only routes to feeds currently waiting (gaps between polls fall to the backstop)", async () => {
    const rows = new Map([["r1", row("r1", { tags: ["a"] })]]);
    const { router, src, hydrateSpy } = makeRouter(rows);
    const reg = router.register("env_1", { kind: "tag", tags: ["a"] }, []);
    // Not waiting yet: a push is dropped (no hydrate, no buffering).
    src.push("env_1", [record("r1", { tags: ["a"] })]);
    expect(hydrateSpy).not.toHaveBeenCalled();
    reg.close();
  });
});
