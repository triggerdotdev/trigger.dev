import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { resolveRealtimeRunResource } from "~/v3/mollifier/realtimeRunResource.server";

const pgRun = {
  id: "pg_internal_id",
  friendlyId: "run_pg_friendly",
  taskIdentifier: "hello-world",
  runTags: ["a", "b"],
  batch: { friendlyId: "batch_1" },
};

const bufferedSynthetic = {
  id: "buffered_id",
  friendlyId: "run_buffered_id",
  taskIdentifier: "hello-world",
  runTags: ["c"],
  // Six seconds ago against the fixed `now` below.
  createdAt: new Date("2026-05-22T12:00:00.000Z"),
};

const fixedNow = () => new Date("2026-05-22T12:00:06.000Z").getTime();

describe("resolveRealtimeRunResource", () => {
  it("returns the PG run unchanged when one exists", () => {
    // PG wins even if the buffer also has the entry — the drainer may
    // be racing the route call and the PG row is the canonical source.
    expect(
      resolveRealtimeRunResource({ pgRun, bufferedSynthetic: null }),
    ).toEqual(pgRun);
    expect(
      resolveRealtimeRunResource({ pgRun, bufferedSynthetic }),
    ).toEqual(pgRun);
  });

  it("never stamps __bufferedDwellMs on a PG-sourced resource", () => {
    // The loader body uses __bufferedDwellMs as a discriminant for
    // emitting buffered-subscription observability. A PG-resident run
    // must never carry it or every PG subscription would over-count.
    const result = resolveRealtimeRunResource({ pgRun, bufferedSynthetic });
    expect(result).not.toHaveProperty("__bufferedDwellMs");
  });

  it("synthesises a resource from the buffered entry when PG misses", () => {
    // Load-bearing assertion: `id` must equal `bufferedSynthetic.id`.
    // The realtime route hands this `id` to streamRun, which builds
    // Electric's `WHERE id='<id>'` clause. When the drainer materialises
    // the run, engine.trigger writes the row with that same id (derived
    // deterministically from friendlyId), and Electric streams the
    // INSERT to the client. If the synthesised `id` ever drifts from
    // what the drainer writes, the customer subscribes to a shape that
    // never matches and the hook silently hangs even after materialise.
    const result = resolveRealtimeRunResource({
      pgRun: null,
      bufferedSynthetic,
      now: fixedNow,
    });
    expect(result).toEqual({
      id: "buffered_id",
      friendlyId: "run_buffered_id",
      taskIdentifier: "hello-world",
      runTags: ["c"],
      batch: null,
      __bufferedDwellMs: 6000,
    });
  });

  it("defaults a missing taskIdentifier to empty string", () => {
    const result = resolveRealtimeRunResource({
      pgRun: null,
      bufferedSynthetic: { ...bufferedSynthetic, taskIdentifier: undefined },
      now: fixedNow,
    });
    expect(result?.taskIdentifier).toBe("");
  });

  it("returns null when neither PG nor buffer have the run", () => {
    // This is the genuine not-found case — typo'd runId, deleted run,
    // etc. The api-builder maps null to 404. Critically, the buffered-
    // fallback must NOT promote a missing run to a synthetic resource —
    // that would cause Electric to open a shape for a runId that may
    // never exist, which is also a silent-hang situation but for a
    // different reason.
    expect(
      resolveRealtimeRunResource({ pgRun: null, bufferedSynthetic: null }),
    ).toBeNull();
  });
});
