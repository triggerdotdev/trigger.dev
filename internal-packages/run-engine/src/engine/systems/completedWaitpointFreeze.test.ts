// The freeze's executable definition. It runs the real oracle,
// enhanceExecutionSnapshotWithWaitpoints, against a reference resolver over equivalent
// records, and asserts the two agree field for field. The waitpoint lane owns the
// production resolver; this reference exists so the frozen shapes are checked rather
// than asserted.
import { describe, expect, it } from "vitest";
import type { Waitpoint } from "@trigger.dev/database";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3";
import type {
  CompletedWaitpointRecord,
  CompletedWaitpointResolver,
  CompletedWaitpointsPointer,
  ResolveCompletedWaitpointsArgs,
} from "@internal/run-store";
import { enhanceExecutionSnapshotWithWaitpoints } from "./executionSnapshotSystem.js";

function makeWaitpoint(overrides: Partial<Waitpoint>): Waitpoint {
  return {
    id: "wp_default",
    friendlyId: "waitpoint_default",
    type: "MANUAL",
    status: "COMPLETED",
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: "idem_generated",
    userProvidedIdempotencyKey: false,
    inactiveIdempotencyKey: null,
    idempotencyKeyExpiresAt: null,
    completedByTaskRunId: null,
    completedByBatchId: null,
    completedAfter: null,
    output: null,
    outputType: "application/json",
    outputIsError: false,
    projectId: "proj_1",
    environmentId: "env_1",
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Waitpoint;
}

// The WRITE side of the freeze: one Waitpoint row becomes one record.
function toRecord(w: Waitpoint): CompletedWaitpointRecord {
  return {
    id: w.id,
    friendlyId: w.friendlyId,
    type: w.type,
    completedAt: (w.completedAt ?? new Date()).toISOString(),
    outputType: w.outputType,
    outputIsError: w.outputIsError,
    output: recordOutputFor(w),
    completedByTaskRunId: w.completedByTaskRunId ?? undefined,
    completedByBatchId: w.completedByBatchId ?? undefined,
    completedAfter: w.completedAfter?.toISOString(),
    idempotencyKey:
      w.userProvidedIdempotencyKey && !w.inactiveIdempotencyKey ? w.idempotencyKey : undefined,
  };
}

function recordOutputFor(w: Waitpoint): CompletedWaitpointRecord["output"] {
  if (w.output === null) return null;
  // A RUN success re-derives byte-identically from TaskRun.output. A RUN error cannot,
  // because TaskRun.error is jsonb, so it carries inline.
  //
  // This branch is deliberately BEFORE the application/store branch. An offloaded RUN
  // success is still deriveFromRun, and that is correct: completeAttemptSuccess receives
  // the same `output` and `outputType` the waitpoint got, so TaskRun.output holds the
  // same ref string. The re-read stays byte-identical either way.
  if (w.type === "RUN" && !w.outputIsError && w.completedByTaskRunId)
    return { deriveFromRun: true };
  if (w.outputType === "application/store") return { ref: w.output };
  return { inline: w.output };
}

// The READ side of the freeze. Iterates `records`, never `order`.
async function referenceResolver(
  args: ResolveCompletedWaitpointsArgs,
  lookupRunOutput: (runId: string) => Promise<string | undefined>
): Promise<CompletedWaitpoint[]> {
  const out: CompletedWaitpoint[] = [];
  for (const record of args.records) {
    const indexes: (number | undefined)[] = [];
    for (let i = 0; i < args.order.length; i++) {
      if (args.order[i] === record.id) indexes.push(i);
    }
    if (indexes.length === 0) indexes.push(undefined);

    let output: string | undefined;
    if (record.output === null) {
      output = undefined;
    } else if ("inline" in record.output) {
      output = record.output.inline;
    } else if ("ref" in record.output) {
      output = record.output.ref;
    } else if ("deriveFromRun" in record.output) {
      output = record.completedByTaskRunId
        ? await lookupRunOutput(record.completedByTaskRunId)
        : undefined;
    } else {
      const _never: never = record.output;
      throw new Error(`unknown record output variant: ${JSON.stringify(_never)}`);
    }

    for (const index of indexes) {
      out.push({
        id: record.id,
        // Unreachable: the oracle's own loop pushes a non-negative integer or undefined.
        // Reproduced because the frozen index-expansion rule names it.
        index: index === -1 ? undefined : index,
        friendlyId: record.friendlyId,
        type: record.type,
        completedAt: new Date(record.completedAt),
        idempotencyKey: record.idempotencyKey,
        completedByTaskRun: record.completedByTaskRunId
          ? {
              id: record.completedByTaskRunId,
              friendlyId: RunId.toFriendlyId(record.completedByTaskRunId),
              batch: args.batchId
                ? { id: args.batchId, friendlyId: BatchId.toFriendlyId(args.batchId) }
                : undefined,
            }
          : undefined,
        completedAfter: record.completedAfter ? new Date(record.completedAfter) : undefined,
        completedByBatch: record.completedByBatchId
          ? {
              id: record.completedByBatchId,
              friendlyId: BatchId.toFriendlyId(record.completedByBatchId),
            }
          : undefined,
        output,
        outputType: record.outputType,
        outputIsError: record.outputIsError,
      });
    }
  }
  return out;
}

// Proves the frozen hook signature is implementable exactly as declared. The reference
// resolver takes its TaskRun lookup as a second parameter, so the production shape is
// the curried form -- which is what the waitpoint lane will bind to a Prisma client.
// If this assignment stops compiling, the frozen signature has drifted. This file is
// typechecked by tsconfig.freeze-test.json, wired into this package's `typecheck`
// script, so that drift is caught -- vitest's esbuild transform alone would not catch it.
const resolverUnderTest: CompletedWaitpointResolver = (args) =>
  referenceResolver(args, async () => undefined);

// The oracle spreads the snapshot, so it needs the two fields the mapping reads.
function makeSnapshot(batchId: string | null) {
  return { id: "snap_1", runId: "run_1", batchId, checkpoint: null } as never;
}

async function assertParity(
  waitpoints: Waitpoint[],
  order: string[],
  batchId: string | null,
  runOutputs: Record<string, string> = {}
) {
  const enhanced = enhanceExecutionSnapshotWithWaitpoints(makeSnapshot(batchId), waitpoints, order);
  const args: ResolveCompletedWaitpointsArgs = {
    runId: "run_1",
    batchId: batchId ?? undefined,
    pointer: { cycleSeq: 1, count: order.length },
    order,
    records: waitpoints.map(toRecord),
  };
  // The frozen rule: count is order.length, NOT the record count. Binding it here means every
  // parity case enforces it, not only the dedicated "the frozen pointer shape" cases.
  expect(args.pointer.count).toBe(order.length);
  const resolved = await referenceResolver(args, async (id) => runOutputs[id]);
  expect(resolved).toEqual(enhanced.completedWaitpoints);
  return { enhanced, resolved };
}

describe("the frozen record shape", () => {
  // Literals, not a mirror of the writer. A field rename or an encoding change must
  // fail HERE, because the parity suite cannot see it.
  it("pins the RUN record", () => {
    expect(
      toRecord(
        makeWaitpoint({
          id: "wp_run",
          friendlyId: "waitpoint_run",
          type: "RUN",
          completedByTaskRunId: "run_child",
          output: '{"value":42}',
        })
      )
    ).toEqual({
      id: "wp_run",
      friendlyId: "waitpoint_run",
      type: "RUN",
      completedAt: "2026-01-01T00:00:00.000Z",
      outputType: "application/json",
      outputIsError: false,
      output: { deriveFromRun: true },
      completedByTaskRunId: "run_child",
      completedByBatchId: undefined,
      completedAfter: undefined,
      idempotencyKey: undefined,
    });
  });

  it("pins the BATCH record", () => {
    expect(
      toRecord(
        makeWaitpoint({
          id: "wp_batch",
          friendlyId: "waitpoint_batch",
          type: "BATCH",
          completedByBatchId: "batch_child",
          output: "Batch waitpoint completed",
        })
      )
    ).toEqual({
      id: "wp_batch",
      friendlyId: "waitpoint_batch",
      type: "BATCH",
      completedAt: "2026-01-01T00:00:00.000Z",
      outputType: "application/json",
      outputIsError: false,
      output: { inline: "Batch waitpoint completed" },
      completedByTaskRunId: undefined,
      completedByBatchId: "batch_child",
      completedAfter: undefined,
      idempotencyKey: undefined,
    });
  });

  it("pins the DATETIME record", () => {
    expect(
      toRecord(
        makeWaitpoint({
          id: "wp_dt",
          friendlyId: "waitpoint_dt",
          type: "DATETIME",
          completedAfter: new Date("2026-02-02T00:00:00.000Z"),
        })
      )
    ).toEqual({
      id: "wp_dt",
      friendlyId: "waitpoint_dt",
      type: "DATETIME",
      completedAt: "2026-01-01T00:00:00.000Z",
      outputType: "application/json",
      outputIsError: false,
      output: null,
      completedByTaskRunId: undefined,
      completedByBatchId: undefined,
      completedAfter: "2026-02-02T00:00:00.000Z",
      idempotencyKey: undefined,
    });
  });

  it("pins the MANUAL record, with a user idempotency key and an offloaded output", () => {
    expect(
      toRecord(
        makeWaitpoint({
          id: "wp_manual",
          friendlyId: "waitpoint_manual",
          type: "MANUAL",
          idempotencyKey: "idem_user",
          userProvidedIdempotencyKey: true,
          output: "s3://bucket/key",
          outputType: "application/store",
        })
      )
    ).toEqual({
      id: "wp_manual",
      friendlyId: "waitpoint_manual",
      type: "MANUAL",
      completedAt: "2026-01-01T00:00:00.000Z",
      outputType: "application/store",
      outputIsError: false,
      output: { ref: "s3://bucket/key" },
      completedByTaskRunId: undefined,
      completedByBatchId: undefined,
      completedAfter: undefined,
      idempotencyKey: "idem_user",
    });
  });

  it("keeps an offloaded RUN success on deriveFromRun, not ref", () => {
    // Branch precedence. TaskRun.output holds the same ref string, so the re-read is
    // still byte-identical. A later edit that reorders the branches must fail here.
    const record = toRecord(
      makeWaitpoint({
        id: "wp_run_offloaded",
        type: "RUN",
        completedByTaskRunId: "run_child",
        output: "s3://bucket/key",
        outputType: "application/store",
      })
    );
    expect(record.output).toEqual({ deriveFromRun: true });
  });

  it("carries a RUN error inline, never deriveFromRun", () => {
    const record = toRecord(
      makeWaitpoint({
        id: "wp_run_err",
        type: "RUN",
        completedByTaskRunId: "run_child",
        output: '{"type":"BUILT_IN_ERROR"}',
        outputIsError: true,
      })
    );
    expect(record.output).toEqual({ inline: '{"type":"BUILT_IN_ERROR"}' });
  });
});

describe("the frozen pointer shape", () => {
  it("pins count to order.length, not the record count", () => {
    const order = ["wp_a", "wp_b", "wp_a"];
    const pointer: CompletedWaitpointsPointer = { cycleSeq: 7, count: order.length };
    expect(pointer).toEqual({ cycleSeq: 7, count: 3 });
  });

  it("pins count at 0 when order is empty, even if records exist", () => {
    const order: string[] = [];
    const pointer: CompletedWaitpointsPointer = { cycleSeq: 7, count: order.length };
    expect(pointer).toEqual({ cycleSeq: 7, count: 0 });
  });
});

describe("the completed-waitpoints freeze", () => {
  it("expands a repeated id at each of its positions", async () => {
    const w = makeWaitpoint({ id: "wp_a", type: "RUN", completedByTaskRunId: "run_child" });
    const { resolved } = await assertParity([w], ["wp_a", "wp_other", "wp_a"], "batch_1");
    expect(resolved.map((r) => r.index)).toEqual([0, 2]);
  });

  it("yields one entry with an undefined index for a record absent from order", async () => {
    const w = makeWaitpoint({ id: "wp_absent", type: "MANUAL" });
    const { resolved } = await assertParity([w], ["wp_other"], null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.index).toBeUndefined();
  });

  it("resolves a non-batch wait, where order is empty and one record exists", async () => {
    // The commonest resume. Postgres's join holds the id while order does not, which is
    // why `records` is authoritative and the mint comparison never reads `order`.
    // batchId is null here on purpose: a triggerAndWait outside a batch is the shape
    // this case is named for, and it exercises the oracle's `batchId ? ... : undefined`
    // false branch, which no other case reaches.
    // output stays null, so no TaskRun lookup is involved: both halves yield undefined.
    const w = makeWaitpoint({ id: "wp_single", type: "RUN", completedByTaskRunId: "run_child" });
    const { resolved } = await assertParity([w], [], null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.index).toBeUndefined();
    expect(resolved[0]!.completedByTaskRun?.id).toBe("run_child");
    expect(resolved[0]!.completedByTaskRun?.batch).toBeUndefined();
  });

  it("keys completedByBatch on the id alone, not on the type", async () => {
    // The oracle checks completedByBatchId without looking at `type`, at
    // executionSnapshotSystem.ts:107-113. A resolver keyed on type would pass every
    // other case here and diverge in production.
    const w = makeWaitpoint({
      id: "wp_manual_with_batch",
      type: "MANUAL",
      completedByBatchId: "batch_child",
    });
    const { resolved } = await assertParity([w], ["wp_manual_with_batch"], null);
    expect(resolved[0]!.completedByBatch?.id).toBe("batch_child");
  });

  it("carries outputIsError on a non-RUN type", async () => {
    const w = makeWaitpoint({
      id: "wp_manual_err",
      type: "MANUAL",
      output: '{"type":"STRING_ERROR"}',
      outputIsError: true,
    });
    const { resolved } = await assertParity([w], ["wp_manual_err"], null);
    expect(resolved[0]!.outputIsError).toBe(true);
    expect(resolved[0]!.output).toBe('{"type":"STRING_ERROR"}');
  });

  it("returns an empty list for no waitpoints", async () => {
    const { resolved } = await assertParity([], [], "batch_1");
    expect(resolved).toEqual([]);
  });

  it("resolves through the frozen hook signature", async () => {
    // Exercises resolverUnderTest, so the declared CompletedWaitpointResolver type is
    // proved implementable at runtime, on top of the compile-time proof at its
    // declaration above (checked by tsconfig.freeze-test.json).
    const w = makeWaitpoint({ id: "wp_hook", type: "MANUAL" });
    const resolved = await resolverUnderTest({
      runId: "run_1",
      batchId: undefined,
      pointer: { cycleSeq: 1, count: 1 },
      order: ["wp_hook"],
      records: [toRecord(w)],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.id).toBe("wp_hook");
    expect(resolved[0]!.index).toBe(0);
  });

  it("round-trips all four waitpoint types", async () => {
    const waitpoints = [
      makeWaitpoint({ id: "wp_run", type: "RUN", completedByTaskRunId: "run_child" }),
      makeWaitpoint({ id: "wp_batch", type: "BATCH", completedByBatchId: "batch_child" }),
      makeWaitpoint({
        id: "wp_dt",
        type: "DATETIME",
        completedAfter: new Date("2026-02-02T00:00:00.000Z"),
      }),
      makeWaitpoint({ id: "wp_manual", type: "MANUAL" }),
    ];
    const { resolved } = await assertParity(waitpoints, ["wp_run", "wp_batch"], "batch_1");
    expect(resolved.map((r) => r.type)).toEqual(["RUN", "BATCH", "DATETIME", "MANUAL"]);
  });

  it("applies the idempotency-key rule in all four combinations", async () => {
    const combos: Array<[boolean, string | null, string | undefined]> = [
      [true, null, "idem_user"],
      [true, "cleared", undefined],
      [false, null, undefined],
      [false, "cleared", undefined],
    ];
    for (const [userProvided, inactive, expected] of combos) {
      const w = makeWaitpoint({
        id: "wp_idem",
        idempotencyKey: "idem_user",
        userProvidedIdempotencyKey: userProvided,
        inactiveIdempotencyKey: inactive,
      });
      const { resolved } = await assertParity([w], ["wp_idem"], null);
      expect(resolved[0]!.idempotencyKey).toBe(expected);
    }
  });

  it("forwards completedAfter on a MANUAL waitpoint with a timeout", async () => {
    // The plan comment scopes completedAfter to DATETIME. The oracle forwards it for any
    // type, so the resolver must too.
    const w = makeWaitpoint({
      id: "wp_timeout",
      type: "MANUAL",
      completedAfter: new Date("2026-03-03T00:00:00.000Z"),
    });
    const { resolved } = await assertParity([w], ["wp_timeout"], null);
    expect(resolved[0]!.completedAfter).toEqual(new Date("2026-03-03T00:00:00.000Z"));
  });

  it("falls back off deriveFromRun when the completing run was deleted", async () => {
    const w = makeWaitpoint({
      id: "wp_orphan",
      type: "RUN",
      completedByTaskRunId: null,
      output: '{"value":42}',
    });
    const { resolved } = await assertParity([w], ["wp_orphan"], null);
    expect(resolved[0]!.output).toBe('{"value":42}');
  });

  it("maps every output variant", async () => {
    const runSuccess = makeWaitpoint({
      id: "wp_run_ok",
      type: "RUN",
      completedByTaskRunId: "run_ok",
      output: '{"value":42}',
    });
    const runError = makeWaitpoint({
      id: "wp_run_err",
      type: "RUN",
      completedByTaskRunId: "run_err",
      output: '{"type":"BUILT_IN_ERROR"}',
      outputIsError: true,
    });
    const offloaded = makeWaitpoint({
      id: "wp_ref",
      type: "MANUAL",
      output: "s3://bucket/key",
      outputType: "application/store",
    });
    const empty = makeWaitpoint({ id: "wp_none", type: "MANUAL", output: null });

    const { resolved } = await assertParity(
      [runSuccess, runError, offloaded, empty],
      ["wp_run_ok", "wp_run_err", "wp_ref", "wp_none"],
      "batch_1",
      // deriveFromRun: the same string TaskRun.output holds verbatim.
      { run_ok: '{"value":42}' }
    );
    expect(resolved.map((r) => r.output)).toEqual([
      '{"value":42}',
      '{"type":"BUILT_IN_ERROR"}',
      "s3://bucket/key",
      undefined,
    ]);
  });
});

describe("the freeze's two deliberate divergences", () => {
  it("pins completedAt at write time, where the oracle samples the clock", () => {
    // The oracle applies `w.completedAt ?? new Date()`, so a null value changes on every
    // read. No deterministic record can match that. The record pins it once instead.
    const w = makeWaitpoint({ id: "wp_null_at", completedAt: null });
    const record = toRecord(w);
    expect(Math.abs(Date.now() - new Date(record.completedAt).getTime())).toBeLessThan(60_000);
  });

  it("takes batch{} from the reading entry, not the completing run's own batch", async () => {
    // A known, deliberate conflation in the oracle. Byte-compatibility requires it.
    const w = makeWaitpoint({ id: "wp_run", type: "RUN", completedByTaskRunId: "run_child" });
    const { resolved } = await assertParity([w], ["wp_run"], "batch_reading_entry");
    expect(resolved[0]!.completedByTaskRun?.batch?.id).toBe("batch_reading_entry");
  });
});
