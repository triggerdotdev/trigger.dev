// RED→GREEN repro for the run-ops split BASELINE BLOCKER:
// RoutingRunStore cross-DB PROBE reads forward the caller's control-plane `client` into the #new
// sub-store probe, so #new queries the CONTROL-PLANE DB instead of its own (5434) and never finds a
// ksuid-resident batch/attempt → returns null. Live effect: batchSystem.#tryCompleteBatch calls
// `runStore.findBatchTaskRunById(batchId, undefined, this.$.prisma)` → null → "batch doesn't exist"
// → the batch waitpoint is never completed → every `batchTriggerAndWait` parent hangs forever.
//
// `heteroRunOpsPostgresTest` gives a REAL split topology: prisma17 = real RunOpsPrismaClient over the
// dedicated subset schema (#new / 5434), prisma14 = full legacy schema on a SEPARATE physical PG
// container (#legacy / control-plane). NEVER mocked. The repro seeds a ksuid batch (and a ksuid
// attempt) on #new and probes via the router passing the LEGACY client as the read client — exactly
// as the live caller does. RED before the fix (router forwards the client → #new reads control-plane
// → null); GREEN after (router drops the client → #new reads its own DB → finds the row).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH (runOpsResidency.ts): 25 chars → cuid → LEGACY,
// 27 chars → ksuid → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const KSUID_27 = "k".repeat(27); // → NEW (#new / prisma17, dedicated subset schema)

async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${suffix}` },
      project: { id: `proj_${suffix}` },
      environment: { id: `env_${suffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function makeLegacyStore(prisma14: PrismaClient) {
  return new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
}

// Real production split topology: #new = dedicated subset on prisma17, #legacy = full schema on
// prisma14 — two physically distinct DBs.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

describe("run-ops split — cross-DB probe reads must NOT forward the caller's control-plane client", () => {
  // findBatchTaskRunById — the live batchTriggerAndWait hang: #tryCompleteBatch probes with the
  // control-plane client, which the router forwarded into #new → #new read the wrong DB → null.
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById FINDS a ksuid batch on #new even when probed with the LEGACY (control-plane) client",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "batchprobe_new");
      const batchId = `batch_${KSUID_27}`; // ksuid → #new

      // Seed the batch directly on #new (5434), exactly where a runEngine-routed ksuid batch lives.
      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_probe_new",
          runtimeEnvironmentId: env.environment.id,
          runCount: 3,
          successfulRunCount: 3,
          status: "PENDING",
        },
      });

      // Probe EXACTLY as batchSystem.#tryCompleteBatch does: pass the control-plane client.
      // RED before fix: null (probed control-plane). GREEN after: resolved from #new's own DB.
      const found = await router.findBatchTaskRunById(batchId, undefined, prisma14 as never);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(batchId);
      expect(found!.successfulRunCount).toBe(3);
    }
  );

  // Control: a cuid batch on #legacy is still found through the router when probed with the same
  // (legacy) client — proving the fix does not regress the legacy cohort.
  heteroRunOpsPostgresTest(
    "findBatchTaskRunById control: a cuid batch on #legacy is still found",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "batchprobe_leg");
      const batchId = `batch_${CUID_25}`; // cuid → #legacy

      await prisma14.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_probe_leg",
          runtimeEnvironmentId: env.environment.id,
          runCount: 1,
          successfulRunCount: 1,
          status: "PENDING",
        },
      });

      const found = await router.findBatchTaskRunById(batchId, undefined, prisma14 as never);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(batchId);
    }
  );

  // findBatchTaskRunByFriendlyId — same anti-pattern (env-scoped friendlyId probe).
  heteroRunOpsPostgresTest(
    "findBatchTaskRunByFriendlyId FINDS a ksuid batch on #new despite the LEGACY client",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "batchfid_new");
      const batchId = `batch_${KSUID_27}`;
      const friendlyId = "batch_fid_new";

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId,
          runtimeEnvironmentId: env.environment.id,
          status: "PENDING",
        },
      });

      const found = await router.findBatchTaskRunByFriendlyId(
        friendlyId,
        env.environment.id,
        undefined,
        prisma14 as never
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(batchId);
    }
  );

  // findBatchTaskRunByIdempotencyKey — same anti-pattern (env + idempotency-key probe).
  heteroRunOpsPostgresTest(
    "findBatchTaskRunByIdempotencyKey FINDS a ksuid batch on #new despite the LEGACY client",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "batchidem_new");
      const batchId = `batch_${KSUID_27}`;
      const idempotencyKey = "idem_batch_new";

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_idem_new",
          runtimeEnvironmentId: env.environment.id,
          idempotencyKey,
          status: "PENDING",
        },
      });

      const found = await router.findBatchTaskRunByIdempotencyKey(
        env.environment.id,
        idempotencyKey,
        undefined,
        prisma14 as never
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(batchId);
    }
  );

  // findTaskRunAttempt — same anti-pattern. A classifiable taskRunId routes to the owning store
  // (#new for a ksuid run) but the control-plane client was still forwarded into it.
  heteroRunOpsPostgresTest(
    "findTaskRunAttempt FINDS a ksuid attempt on #new even when probed with the LEGACY client",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "attempt_new");
      const runId = `run_${KSUID_27}`; // ksuid run → #new
      const attemptId = `attempt_${KSUID_27}`;

      // The attempt's owning run lives on #new (the FK is co-resident on the dedicated schema).
      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_attempt_new",
          runtimeEnvironmentId: env.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: env.organization.id,
          projectId: env.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${runId}`,
          spanId: `span_${runId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma17.taskRunAttempt.create({
        data: {
          id: attemptId,
          number: 1,
          friendlyId: "attempt_fid_new",
          taskRunId: runId,
          backgroundWorkerId: `bw_${KSUID_27}`,
          backgroundWorkerTaskId: `bwt_${KSUID_27}`,
          runtimeEnvironmentId: env.environment.id,
          queueId: `queue_${KSUID_27}`,
          status: "PENDING",
        },
      });

      // Probe with the LEGACY client, mirroring callers that pass the control-plane handle.
      const found = await router.findTaskRunAttempt(
        { where: { taskRunId: runId } },
        prisma14 as never
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(attemptId);
    }
  );

  // Split-OFF guard: with a single store configured, the probe finds the batch with or without a
  // passed client (the one configured store reads its own DB either way) — no behavior change.
  heteroRunOpsPostgresTest(
    "split-OFF: a single-store router finds the batch with or without a passed client",
    async ({ prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      // Single-DB config: both slots point at the same dedicated store (split effectively OFF).
      const router = new RoutingRunStore({ new: newStore, legacy: newStore });
      const env = await seedEnvironment(prisma17, "dedicated", "splitoff_new");
      const batchId = `batch_${KSUID_27}`;

      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_splitoff",
          runtimeEnvironmentId: env.environment.id,
          status: "PENDING",
        },
      });

      const withoutClient = await router.findBatchTaskRunById(batchId);
      const withClient = await router.findBatchTaskRunById(batchId, undefined, prisma17 as never);
      expect(withoutClient?.id).toBe(batchId);
      expect(withClient?.id).toBe(batchId);
    }
  );
});
