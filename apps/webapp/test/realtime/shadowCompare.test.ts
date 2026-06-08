import {
  type RealtimeRunRow,
  serializeRunRow,
} from "~/services/realtime/electricStreamProtocol.server";
import { type RunListFilter } from "~/services/realtime/runReader.server";
import { RealtimeShadowComparator } from "~/services/realtime/shadowCompare.server";
import { describe, expect, it } from "vitest";

function sampleRow(overrides: Partial<RealtimeRunRow> = {}): RealtimeRunRow {
  return {
    id: "run_a",
    taskIdentifier: "my-task",
    createdAt: new Date("2026-06-07T09:00:00.000Z"),
    updatedAt: new Date("2026-06-07T10:05:30.123Z"),
    startedAt: null,
    delayUntil: null,
    queuedAt: null,
    expiredAt: null,
    completedAt: null,
    friendlyId: "run_friendly_a",
    number: 7,
    isTest: true,
    status: "EXECUTING",
    usageDurationMs: 1234,
    costInCents: 0.55,
    baseCostInCents: 0.25,
    ttl: "1h",
    payload: '{"hello":"world"}',
    payloadType: "application/json",
    metadata: null,
    metadataType: "application/json",
    output: null,
    outputType: "application/json",
    runTags: ["a", "b"],
    error: null,
    realtimeStreams: [],
    ...overrides,
  };
}

const UP_TO_DATE = { headers: { control: "up-to-date" } };

function insert(value: Record<string, string | null>) {
  return { key: `"public"."TaskRun"/"${value.id}"`, value, headers: { operation: "insert" } };
}

function makeComparator(
  rowsById: Record<string, RealtimeRunRow | null>,
  resolvedIds: string[] = []
) {
  return new RealtimeShadowComparator({
    runReader: { getRunById: async (_env: string, id: string) => rowsById[id] ?? null } as any,
    runListResolver: { resolveMatchingRunIds: async (_f: RunListFilter) => resolvedIds } as any,
  });
}

describe("RealtimeShadowComparator serialization", () => {
  it("counts a faithful re-serialization as a match", async () => {
    const row = sampleRow();
    const body = JSON.stringify([insert(serializeRunRow(row)), UP_TO_DATE]);
    const cmp = makeComparator({ run_a: row });

    const out = await cmp.compare({
      feed: "run",
      electricBody: body,
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
    });

    expect(out.serializationMatched).toBe(1);
    expect(out.serializationDiverged).toBe(0);
    expect(out.serializationSkew).toBe(0);
    expect(out.diffs).toEqual([]);
  });

  it("does not flag semantically-equivalent but differently-encoded values", async () => {
    const row = sampleRow();
    // Electric encodes bool as "true" (notifier uses "t"), a number with a trailing
    // zero, and a timestamp without millis — all equal after decoding.
    const value = {
      ...serializeRunRow(row),
      isTest: "true",
      costInCents: "0.5500",
      createdAt: "2026-06-07T09:00:00",
    };
    const body = JSON.stringify([insert(value), UP_TO_DATE]);
    const cmp = makeComparator({ run_a: row });

    const out = await cmp.compare({
      feed: "run",
      electricBody: body,
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
    });

    expect(out.serializationMatched).toBe(1);
    expect(out.serializationDiverged).toBe(0);
  });

  it("flags a genuine column divergence (same version)", async () => {
    const row = sampleRow();
    const value = { ...serializeRunRow(row), payload: '{"hello":"TAMPERED"}' };
    const body = JSON.stringify([insert(value), UP_TO_DATE]);
    const cmp = makeComparator({ run_a: row });

    const out = await cmp.compare({
      feed: "run",
      electricBody: body,
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
    });

    expect(out.serializationDiverged).toBe(1);
    expect(out.serializationMatched).toBe(0);
    expect(out.diffs).toEqual([
      { runId: "run_a", column: "payload", electric: '{"hello":"TAMPERED"}', notifier: '{"hello":"world"}' },
    ]);
  });

  it("treats DEQUEUED/EXECUTING as equivalent (legacy status rewrite)", async () => {
    const row = sampleRow({ status: "EXECUTING" });
    const value = { ...serializeRunRow(row), status: "DEQUEUED" };
    const body = JSON.stringify([insert(value), UP_TO_DATE]);
    const cmp = makeComparator({ run_a: row });

    const out = await cmp.compare({
      feed: "run",
      electricBody: body,
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
    });

    expect(out.serializationDiverged).toBe(0);
    expect(out.serializationMatched).toBe(1);
  });

  it("records skew when the row advanced between emit and refetch", async () => {
    const row = sampleRow();
    // Electric emitted an older version; the refetched row is newer.
    const value = { ...serializeRunRow(sampleRow({ updatedAt: new Date("2026-06-07T10:00:00.000Z") })) };
    const body = JSON.stringify([insert(value), UP_TO_DATE]);
    const cmp = makeComparator({ run_a: row });

    const out = await cmp.compare({
      feed: "run",
      electricBody: body,
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
    });

    expect(out.serializationSkew).toBe(1);
    expect(out.serializationMatched).toBe(0);
    expect(out.serializationDiverged).toBe(0);
  });
});

describe("RealtimeShadowComparator membership", () => {
  const filter: RunListFilter = {
    organizationId: "org_1",
    projectId: "proj_1",
    environmentId: "env_1",
    tags: ["t"],
    createdAtAfter: new Date("2026-06-06T00:00:00.000Z"),
    limit: 1000,
  };

  function bodyFor(ids: string[]) {
    const msgs = ids.map((id) => insert(serializeRunRow(sampleRow({ id }))));
    return JSON.stringify([...msgs, UP_TO_DATE]);
  }

  it("matches when Electric's set equals the notifier resolver's set", async () => {
    const cmp = makeComparator(
      { a: sampleRow({ id: "a" }), b: sampleRow({ id: "b" }) },
      ["a", "b"]
    );
    const out = await cmp.compare({
      feed: "runs",
      electricBody: bodyFor(["a", "b"]),
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
      membershipFilter: filter,
    });
    expect(out.membershipMatch).toBe(true);
    expect(out.missingInNotifier).toEqual([]);
    expect(out.extraInNotifier).toEqual([]);
  });

  it("reports rows missing from / extra in the notifier resolution", async () => {
    const cmp = makeComparator(
      { a: sampleRow({ id: "a" }), b: sampleRow({ id: "b" }) },
      ["a", "c"] // notifier missing b, has extra c
    );
    const out = await cmp.compare({
      feed: "runs",
      electricBody: bodyFor(["a", "b"]),
      environment: { id: "env_1" },
      skipColumns: [],
      isInitialSnapshot: true,
      membershipFilter: filter,
    });
    expect(out.membershipMatch).toBe(false);
    expect(out.missingInNotifier).toEqual(["b"]);
    expect(out.extraInNotifier).toEqual(["c"]);
  });
});
