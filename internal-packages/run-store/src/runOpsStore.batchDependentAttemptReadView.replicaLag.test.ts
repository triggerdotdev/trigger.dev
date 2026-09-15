// Property: the batchTriggerV3 dependent-attempt read tolerates a miss under replica lag. The
// client-less findTaskRunAttempt resolves the PARENT run's attempt (by attempt friendlyId, env-scoped)
// to feed a terminal-state pre-check (throw ServiceValidationError if the parent attempt/run is
// terminal). With no `taskRunId` in the where the router fans out UNROUTED (NEW→LEGACY), each leg with a
// null client → readOnlyPrisma → genuinely REPLICA-routed (never defaults to primary).
//
// Under owning-replica lag the read returns null. Tolerated: the parent attempt is a long-committed row
// (the parent is mid-execution when it triggers the batch — never a read-your-write), and its only
// consumer is a best-effort TOCTOU guard that is racy even against the primary and whose resume path is
// a no-op on an already-terminal parent. A null/stale read skips the guard but drives no wrong outcome.
//
// Builds the router as the webapp holds it, seeds the parent run + attempt on the owning LEGACY primary,
// freezes the LEGACY replica with the shared laggingReplica, invokes findTaskRunAttempt with the EXACT
// caller args and NO client.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput } from "./types.js";

// A cuid (25 chars after the `run_` prefix) classifies LEGACY, so the parent run + attempt are owned
// by the legacy (control-plane) store. The env-scoped, taskRunId-free read then fans out NEW→LEGACY.
const CUID_25 = "c".repeat(25);

async function seedEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

// Full CreateRunInput for the parent run (mirrors the routing test's builder) — used via
// store.createRun so we don't hand-maintain the TaskRun column list.
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
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/parent-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Seed a TaskRunAttempt with FK triggers disabled. `session_replication_role` is session-scoped, so the
// `SET` and the insert must share one connection — separate pooled calls can split across connections,
// leaving the insert with FK triggers on. One transaction with `SET LOCAL` keeps them co-connected.
async function seedAttempt(
  prisma: PrismaClient,
  opts: {
    attemptId: string;
    friendlyId: string;
    runId: string;
    runtimeEnvironmentId: string;
    status: string;
  }
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "TaskRunAttempt" (id, number, "friendlyId", "taskRunId", "backgroundWorkerId", "backgroundWorkerTaskId", "runtimeEnvironmentId", "queueId", status, "createdAt", "updatedAt", "usageDurationMs", "outputType")
       VALUES ($1, 1, $2, $3, 'synthetic-worker', 'synthetic-worker-task', $4, 'synthetic-queue', $5::"TaskRunAttemptStatus", NOW(), NOW(), 0, 'application/json')`,
      opts.attemptId,
      opts.friendlyId,
      opts.runId,
      opts.runtimeEnvironmentId,
      opts.status
    );
  });
}

// Mirror of dependentAttemptScope#dependentAttemptWhere — replicated here to keep this test free of a
// webapp import while matching the exact caller shape.
function dependentAttemptWhere(friendlyId: string, environmentId: string) {
  return { friendlyId, taskRun: { runtimeEnvironmentId: environmentId } } as const;
}

// The EXACT args the batchTriggerV3 caller passes (where builder + include), for a given attempt.
function callSiteArgs(attemptFriendlyId: string, environmentId: string) {
  return {
    where: dependentAttemptWhere(attemptFriendlyId, environmentId),
    include: { taskRun: { select: { id: true, status: true } } },
  } as const;
}

describe("batchTriggerV3 dependentAttempt read — findTaskRunAttempt(no client) under replica lag", () => {
  heteroPostgresTest(
    "env-scoped dependent-attempt read returns null under replica lag, skipping the terminal-state pre-check",
    async ({ prisma14, prisma17 }) => {
      // LEGACY store's replica is FROZEN; its primary (prisma14) is real.
      const legacyReplica = laggingReplica(prisma14, [
        { model: "taskRunAttempt", mode: "missing" },
      ]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
      });
      // NEW store non-lagging (and holds no attempt) — the fan-out probes it first and misses.
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma14, "batch_dep_lag");
      const parentRunId = `run_${CUID_25}`; // cuid → LEGACY-owned
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: parentRunId,
          friendlyId: "run_batch_dep_parent",
          runtimeEnvironmentId: seed.environment.id,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
        })
      );

      const attemptId = "attempt_batch_dep_lag";
      const attemptFriendlyId = "attempt_batch_dep_lag_f";
      // Parent attempt is COMPLETED — a TERMINAL attempt status. If the read saw it, the caller WOULD
      // throw the ServiceValidationError. This makes the tolerance question sharp.
      await seedAttempt(prisma14, {
        attemptId,
        friendlyId: attemptFriendlyId,
        runId: parentRunId,
        runtimeEnvironmentId: seed.environment.id,
        status: "COMPLETED",
      });

      const args = callSiteArgs(attemptFriendlyId, seed.environment.id);

      // HAZARD proof: the call site's exact invocation (no client) misses the attempt under lag.
      const underLag = await router.findTaskRunAttempt(args);
      expect(underLag).toBeNull();
      // Prove the read was genuinely REPLICA-routed (the frozen owning replica was consulted).
      expect(legacyReplica.wasHit()).toBe(true);

      // ROUTING proof (replica, not primary): the SAME store, SAME args, but a WRITER client forces the
      // owning primary (#ownPrimary), which sees the row. So the null above is purely replica lag +
      // replica routing — not a missing row or a bad query.
      const onPrimary = await router.findTaskRunAttempt(args, prisma14);
      expect(onPrimary?.id).toBe(attemptId);
      expect(onPrimary?.status).toBe("COMPLETED");
      expect(onPrimary?.taskRun.id).toBe(parentRunId);

      // TOLERANCE assertion: reproduce the caller's `dependentAttempt ? throw-if-terminal : proceed`
      // branch. Under lag dependentAttempt is null, so the terminal-state guard is SKIPPED.
      const dependentAttempt = underLag as { status: string; taskRun: { status: string } } | null;
      const wouldThrowTerminal =
        !!dependentAttempt &&
        (["COMPLETED", "FAILED", "CANCELED"].includes(dependentAttempt.status) ||
          ["COMPLETED_SUCCESSFULLY", "COMPLETED_WITH_ERRORS", "CANCELED", "FAILED"].includes(
            dependentAttempt.taskRun.status
          ));
      expect(wouldThrowTerminal).toBe(false); // guard skipped under lag — tolerated, not a wrong outcome
    }
  );

  heteroPostgresTest(
    "steady state: the read returns the terminal parent attempt from a caught-up replica",
    async ({ prisma14, prisma17 }) => {
      // Non-lagging: the legacy store reads its real replica (prisma14 itself as the replica handle).
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma14, "batch_dep_ok");
      const parentRunId = `run_${CUID_25}`;
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: parentRunId,
          friendlyId: "run_batch_dep_parent_ok",
          runtimeEnvironmentId: seed.environment.id,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
        })
      );

      const attemptId = "attempt_batch_dep_ok";
      const attemptFriendlyId = "attempt_batch_dep_ok_f";
      await seedAttempt(prisma14, {
        attemptId,
        friendlyId: attemptFriendlyId,
        runId: parentRunId,
        runtimeEnvironmentId: seed.environment.id,
        status: "COMPLETED",
      });

      const found = await router.findTaskRunAttempt(
        callSiteArgs(attemptFriendlyId, seed.environment.id)
      );
      expect(found?.id).toBe(attemptId);
      expect(found?.status).toBe("COMPLETED");
      expect(found?.taskRun.id).toBe(parentRunId);
      // Env-scope enforced: a wrong environment id in the where must not resolve the foreign attempt.
      const wrongEnv = await router.findTaskRunAttempt(
        callSiteArgs(attemptFriendlyId, "env_does_not_exist")
      );
      expect(wrongEnv).toBeNull();
    }
  );
});
