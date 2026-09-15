// Two layers. The PURE-LOGIC layer proves buildCompletedWaitpointRecords + the expander agree
// with the Postgres oracle (enhanceExecutionSnapshotWithWaitpoints) field-for-field across every
// required case, with the deriveFromRun lookup injected as a closure per the branch rule. The
// DB layer proves the production resolver's ONE real read: createCompletedWaitpointResolver reads
// TaskRun.output through the routed run-store, single-shard and cross-shard, against real Postgres.
import { describe, expect, it } from "vitest";
import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore, type CreateRunInput } from "@internal/run-store";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { enhanceExecutionSnapshotWithWaitpoints } from "./executionSnapshotSystem.js";
import {
  buildCompletedWaitpointRecords,
  createCompletedWaitpointResolver,
  expandCompletedWaitpointRecords,
} from "./completedWaitpointResolver.js";

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

function makeSnapshot(batchId: string | null) {
  return { id: "snap_1", runId: "run_1", batchId, checkpoint: null } as never;
}

// Build records, resolve them into read rows (deriveFromRun served from runOutputs, the same string
// TaskRun.output holds), then run BOTH sides through the one enhancement step and compare the final
// runner-facing payloads. Comparing the resolver's rows to the oracle's payload instead is what let
// a Redis read that dropped every completion association still look correct here.
function assertParity(
  waitpoints: Waitpoint[],
  order: string[],
  batchId: string | null,
  runOutputs: Record<string, string> = {}
): { resolved: CompletedWaitpoint[] } {
  const snapshot = makeSnapshot(batchId);
  const enhanced = enhanceExecutionSnapshotWithWaitpoints(snapshot, waitpoints, order);
  const rows = expandCompletedWaitpointRecords(
    {
      runId: "run_1",
      batchId: batchId ?? undefined,
      pointer: { cycleSeq: 1, count: order.length },
      order,
      records: buildCompletedWaitpointRecords(waitpoints),
    },
    (id) => runOutputs[id]
  );
  const resolved = enhanceExecutionSnapshotWithWaitpoints(
    snapshot,
    rows,
    order
  ).completedWaitpoints;
  expect(resolved).toEqual(enhanced.completedWaitpoints);
  return { resolved };
}

describe("buildCompletedWaitpointRecords + expander parity with the Postgres oracle", () => {
  it("expands a repeated id at each of its positions (duplicate ids + ordering)", () => {
    const w = makeWaitpoint({ id: "wp_a", type: "RUN", completedByTaskRunId: "run_child" });
    const { resolved } = assertParity([w], ["wp_a", "wp_other", "wp_a"], "batch_1");
    expect(resolved.map((r) => r.index)).toEqual([0, 2]);
  });

  it("dedups the record for a repeated row but keeps every position", () => {
    const w = makeWaitpoint({ id: "wp_a", type: "MANUAL" });
    const records = buildCompletedWaitpointRecords([w, w, w]);
    expect(records).toHaveLength(1);
    const order = ["wp_a", "wp_a"];
    const rows = expandCompletedWaitpointRecords(
      { runId: "run_1", pointer: { cycleSeq: 1, count: 2 }, order, records },
      () => undefined
    );
    // The resolver stays one-row-per-distinct-record; the enhancement step is what puts the id back
    // at each of its positions.
    expect(rows).toHaveLength(1);
    const resolved = enhanceExecutionSnapshotWithWaitpoints(
      makeSnapshot(null),
      rows,
      order
    ).completedWaitpoints;
    expect(resolved.map((r) => r.index)).toEqual([0, 1]);
  });

  it("resolves wait.for: one MANUAL record, empty order, undefined index", () => {
    const w = makeWaitpoint({ id: "wp_for", type: "MANUAL" });
    const { resolved } = assertParity([w], [], null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.index).toBeUndefined();
  });

  it("resolves a non-batch trigger-and-wait: RUN record, empty order, no batch{}", () => {
    const w = makeWaitpoint({ id: "wp_taw", type: "RUN", completedByTaskRunId: "run_child" });
    const { resolved } = assertParity([w], [], null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.completedByTaskRun?.id).toBe("run_child");
    expect(resolved[0]!.completedByTaskRun?.batch).toBeUndefined();
  });

  it("resolves a batch wait: RUN records indexed by order, batch{} from the reading entry", () => {
    const a = makeWaitpoint({ id: "wp_b0", type: "RUN", completedByTaskRunId: "run_0" });
    const b = makeWaitpoint({ id: "wp_b1", type: "RUN", completedByTaskRunId: "run_1c" });
    const { resolved } = assertParity([a, b], ["wp_b0", "wp_b1"], "batch_1");
    expect(resolved.map((r) => r.index)).toEqual([0, 1]);
    expect(resolved.every((r) => r.completedByTaskRun?.batch?.id === "batch_1")).toBe(true);
  });

  it("resolves a BATCH waitpoint (completedByBatch)", () => {
    const w = makeWaitpoint({
      id: "wp_batch",
      type: "BATCH",
      completedByBatchId: "batch_child",
      output: "Batch waitpoint completed",
    });
    const { resolved } = assertParity([w], ["wp_batch"], "batch_1");
    expect(resolved[0]!.completedByBatch?.id).toBe("batch_child");
    expect(resolved[0]!.output).toBe("Batch waitpoint completed");
  });

  it("maps every output variant: manual/datetime/error/inline/ref/deriveFromRun", () => {
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
    const manualError = makeWaitpoint({
      id: "wp_manual_err",
      type: "MANUAL",
      output: '{"type":"STRING_ERROR"}',
      outputIsError: true,
    });
    const offloaded = makeWaitpoint({
      id: "wp_ref",
      type: "MANUAL",
      output: "s3://bucket/key",
      outputType: "application/store",
    });
    const datetime = makeWaitpoint({
      id: "wp_dt",
      type: "DATETIME",
      completedAfter: new Date("2026-02-02T00:00:00.000Z"),
    });
    const empty = makeWaitpoint({ id: "wp_none", type: "MANUAL", output: null });

    const { resolved } = assertParity(
      [runSuccess, runError, manualError, offloaded, datetime, empty],
      ["wp_run_ok", "wp_run_err", "wp_manual_err", "wp_ref", "wp_dt", "wp_none"],
      "batch_1",
      { run_ok: '{"value":42}' }
    );
    expect(resolved.map((r) => r.output)).toEqual([
      '{"value":42}',
      '{"type":"BUILT_IN_ERROR"}',
      '{"type":"STRING_ERROR"}',
      "s3://bucket/key",
      undefined,
      undefined,
    ]);
    expect(resolved[4]!.completedAfter).toEqual(new Date("2026-02-02T00:00:00.000Z"));
  });

  it("keeps an offloaded RUN success on deriveFromRun, a RUN error inline", () => {
    const okOffloaded = buildCompletedWaitpointRecords([
      makeWaitpoint({
        id: "wp_run_offloaded",
        type: "RUN",
        completedByTaskRunId: "run_child",
        output: "s3://bucket/key",
        outputType: "application/store",
      }),
    ]);
    expect(okOffloaded[0]!.output).toEqual({ deriveFromRun: true });

    const err = buildCompletedWaitpointRecords([
      makeWaitpoint({
        id: "wp_run_err",
        type: "RUN",
        completedByTaskRunId: "run_child",
        output: '{"type":"BUILT_IN_ERROR"}',
        outputIsError: true,
      }),
    ]);
    expect(err[0]!.output).toEqual({ inline: '{"type":"BUILT_IN_ERROR"}' });
  });

  it("resolves a checkpoint suspend/resume snapshot: waitpoints carry through unchanged", () => {
    // A resume-after-checkpoint snapshot differs only in carrying a checkpoint; the oracle spreads
    // the snapshot, so completed-waitpoint resolution is identical. Prove parity holds for it.
    const w = makeWaitpoint({ id: "wp_ckpt", type: "RUN", completedByTaskRunId: "run_child" });
    const order = ["wp_ckpt"];
    const snapshot = {
      id: "snap_ckpt",
      runId: "run_1",
      batchId: "batch_1",
      checkpoint: {},
    } as never;
    const enhanced = enhanceExecutionSnapshotWithWaitpoints(snapshot, [w], order);
    const rows = expandCompletedWaitpointRecords(
      {
        runId: "run_1",
        batchId: "batch_1",
        pointer: { cycleSeq: 1, count: order.length },
        order,
        records: buildCompletedWaitpointRecords([w]),
      },
      () => undefined
    );
    const resolved = enhanceExecutionSnapshotWithWaitpoints(
      snapshot,
      rows,
      order
    ).completedWaitpoints;
    expect(resolved).toEqual(enhanced.completedWaitpoints);
  });

  it("applies the idempotency-key rule in all four combinations", () => {
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
      const { resolved } = assertParity([w], ["wp_idem"], null);
      expect(resolved[0]!.idempotencyKey).toBe(expected);
    }
  });

  it("falls back off deriveFromRun when the completing run was deleted (orphan)", () => {
    const w = makeWaitpoint({
      id: "wp_orphan",
      type: "RUN",
      completedByTaskRunId: null,
      output: '{"value":42}',
    });
    const { resolved } = assertParity([w], ["wp_orphan"], null);
    expect(resolved[0]!.output).toBe('{"value":42}');
  });
});

// ---------------------------------------------------------------------------
// DB layer: the resolver's real deriveFromRun read through the routed run-store.
// ---------------------------------------------------------------------------

// run-ops id (v1 internal id, version "1" at index 25) → routed to the run-ops (#new) store.
const RUN_OPS_A = "a".repeat(24) + "01";
const RUN_OPS_B = "b".repeat(24) + "01";
// cuid (25 chars) → classified LEGACY → routed to #legacy (prisma14).
const CUID_LEGACY = "c".repeat(25);

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

async function seedEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "child-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/child-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "done",
      runStatus: "COMPLETED_SUCCESSFULLY",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Create a completing run on its owning shard (createRun routes by id) and stamp its output on that
// same shard, so a deriveFromRun record can re-read it.
async function seedCompletingRun(
  router: RoutingRunStore,
  env: { organization: { id: string }; project: { id: string }; environment: { id: string } },
  runId: string,
  output: string,
  shard: { taskRun: { update: (args: unknown) => Promise<unknown> } }
) {
  await router.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_${runId.slice(0, 6)}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );
  await shard.taskRun.update({
    where: { id: runId },
    data: { output, outputType: "application/json" },
  });
}

describe("createCompletedWaitpointResolver reads TaskRun.output through the routed store", () => {
  heteroRunOpsPostgresTest(
    "resolves a deriveFromRun record from the completing run on the #new shard",
    async ({ prisma14, prisma17 }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const env = await seedEnv(prisma14 as unknown as PrismaClient, "new");
      await seedCompletingRun(router, env, RUN_OPS_A, '{"value":99}', prisma17 as never);

      const resolver = createCompletedWaitpointResolver(router);
      // The waitpoint's own output is a stale placeholder: a deriveFromRun record carries no copy,
      // so the resolver must return the RUN's TaskRun.output ('{"value":99}'), not this string.
      const record = buildCompletedWaitpointRecords([
        makeWaitpoint({
          id: "wp_new",
          type: "RUN",
          completedByTaskRunId: RUN_OPS_A,
          output: '"stale"',
        }),
      ]);
      const resolved = await resolver({
        runId: "reader",
        batchId: undefined,
        pointer: { cycleSeq: 1, count: 0 },
        order: [],
        records: record,
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.output).toBe('{"value":99}');
    }
  );

  heteroRunOpsPostgresTest(
    "batches a cross-shard resolve: one completing run on #new, one on #legacy, in one call",
    async ({ prisma14, prisma17 }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const env = await seedEnv(prisma14 as unknown as PrismaClient, "cross");
      await seedCompletingRun(router, env, RUN_OPS_B, '{"shard":"new"}', prisma17 as never);
      await seedCompletingRun(
        router,
        env,
        CUID_LEGACY,
        '{"shard":"legacy"}',
        prisma14 as unknown as { taskRun: { update: (args: unknown) => Promise<unknown> } }
      );

      const resolver = createCompletedWaitpointResolver(router);
      const records = buildCompletedWaitpointRecords([
        makeWaitpoint({
          id: "wp_x_new",
          type: "RUN",
          completedByTaskRunId: RUN_OPS_B,
          output: '"stale"',
        }),
        makeWaitpoint({
          id: "wp_x_legacy",
          type: "RUN",
          completedByTaskRunId: CUID_LEGACY,
          output: '"stale"',
        }),
      ]);
      const order = ["wp_x_new", "wp_x_legacy"];
      const resolvedRows = await resolver({
        runId: "reader",
        batchId: "batch_x",
        pointer: { cycleSeq: 1, count: 2 },
        order,
        records,
      });
      const resolved = enhanceExecutionSnapshotWithWaitpoints(
        makeSnapshot("batch_x"),
        resolvedRows,
        order
      ).completedWaitpoints;
      expect(resolved.map((r) => r.output)).toEqual(['{"shard":"new"}', '{"shard":"legacy"}']);
      expect(resolved.map((r) => r.index)).toEqual([0, 1]);
    }
  );

  heteroRunOpsPostgresTest(
    "reproduces the Postgres join answer for a mirrored run (real rows, real output read)",
    async ({ prisma14, prisma17 }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const env = await seedEnv(prisma14 as unknown as PrismaClient, "mirror");
      await seedCompletingRun(router, env, RUN_OPS_A, '{"value":42}', prisma17 as never);

      // Real waitpoint rows on the run-ops shard: a batch-indexed RUN (deriveFromRun) plus a
      // non-indexed MANUAL wait.for token.
      await prisma17.waitpoint.create({
        data: {
          id: "wp_mirror_run",
          friendlyId: "waitpoint_mirror_run",
          type: "RUN",
          status: "COMPLETED",
          completedAt: new Date("2026-01-01T00:00:00.000Z"),
          completedByTaskRunId: RUN_OPS_A,
          output: '{"value":42}',
          outputType: "application/json",
          idempotencyKey: "idem_mirror_run",
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await prisma17.waitpoint.create({
        data: {
          id: "wp_mirror_token",
          friendlyId: "waitpoint_mirror_token",
          type: "MANUAL",
          status: "COMPLETED",
          completedAt: new Date("2026-01-01T00:00:00.000Z"),
          output: '{"token":true}',
          outputType: "application/json",
          idempotencyKey: "idem_user_token",
          userProvidedIdempotencyKey: true,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      const rows = (await prisma17.waitpoint.findMany({
        where: { id: { in: ["wp_mirror_run", "wp_mirror_token"] } },
        orderBy: { id: "asc" },
      })) as unknown as Waitpoint[];
      const order = ["wp_mirror_run"]; // only the batch-indexed RUN sits in order

      const snapshot = {
        id: "snap_mirror",
        runId: "reader",
        batchId: "batch_mirror",
        checkpoint: null,
      } as never;
      const oracle = enhanceExecutionSnapshotWithWaitpoints(snapshot, rows, order);

      const resolver = createCompletedWaitpointResolver(router);
      const resolvedRows = await resolver({
        runId: "reader",
        batchId: "batch_mirror",
        pointer: { cycleSeq: 1, count: order.length },
        order,
        records: buildCompletedWaitpointRecords(rows),
      });
      const resolved = enhanceExecutionSnapshotWithWaitpoints(
        snapshot,
        resolvedRows,
        order
      ).completedWaitpoints;

      expect(resolved).toEqual(oracle.completedWaitpoints);
    }
  );
});
