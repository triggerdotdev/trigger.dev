// Property: the retry-vs-fail decision must read maxAttempts / lockedRetryConfig from the OWNING
// PRIMARY. Those fields are written at lock time (a recent primary write); served from a lagging
// replica they read null and a run WITH retries remaining is permanently failed instead of retried.
// Freeze the replica at the pre-lock snapshot via the shared `laggingReplica` primitive and drive the
// REAL retryOutcomeFromCompletion: reading via the primary yields "retry", reading via the stale
// replica yields "fail_run" — the replica lag alone is what flips the decision.

import { laggingReplica, postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { TaskRunError, TaskRunExecutionRetry } from "@trigger.dev/core/v3";
import { describe, expect } from "vitest";
import { retryOutcomeFromCompletion } from "./retrying.js";

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
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
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-task",
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

// A plain retriable error (BUILT_IN_ERROR is retriable and not OOM), so the decision falls through
// to the maxAttempts / lockedRetryConfig gates — exactly the read this test targets.
const RETRIABLE_ERROR: TaskRunError = {
  type: "BUILT_IN_ERROR",
  name: "Error",
  message: "boom",
  stackTrace: "at handler (task.ts:1:1)",
};

// The completion carries explicit retry settings (the normal SDK-failure path), so once the run's
// maxAttempts is read as present the outcome is deterministically "retry" — isolating the read as
// the ONLY thing that flips the decision.
const RETRY_SETTINGS: TaskRunExecutionRetry = { timestamp: Date.now() + 60_000, delay: 60_000 };

describe("retry-vs-fail decision under replica lag", () => {
  postgresTest(
    "a retriable attempt retries when lock-time maxAttempts is read from the primary, not the lagging replica",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma, "retry_lag");
      const runId = `run_${"a".repeat(24)}`;

      // Build the store the way the engine does; its readOnlyPrisma is a replica (set below).
      // The write client is the primary.
      const runId_friendly = "run_retrylag";
      const primaryStore = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
        schemaVariant: "legacy",
      });
      await primaryStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: runId_friendly,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      // Snapshot the run as the replica still sees it: PRE-LOCK, so maxAttempts / lockedRetryConfig
      // are still null (the run was created but not yet locked to a worker).
      const staleRun = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(staleRun.maxAttempts).toBeNull();
      expect(staleRun.lockedRetryConfig).toBeNull();

      // The attempt is locked: the primary now records maxAttempts + lockedRetryConfig (the recent
      // lock-time write). This run has 3 attempts and is on attempt 1 -> it SHOULD retry.
      await prisma.taskRun.update({
        where: { id: runId },
        data: {
          maxAttempts: 3,
          lockedRetryConfig: {
            maxAttempts: 3,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 10000,
            factor: 2,
          },
          machinePreset: "small-1x",
          usageDurationMs: 100,
          costInCents: 0,
        },
      });

      // ...but the replica lags, frozen at the pre-lock snapshot (maxAttempts = null).
      const replica = laggingReplica(prisma, [
        { model: "taskRun", mode: "frozen", rows: [staleRun] },
      ]);

      // The store as the engine holds it: reads default to the (lagging) replica.
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: replica.client,
        schemaVariant: "legacy",
      });

      // Mirrors what the engine does — it passes `this.$.readOnlyPrisma` (the REPLICA) as the first
      // arg. `readClient` models what the engine threads in.
      const decide = (readClient: typeof prisma | typeof replica.client) =>
        retryOutcomeFromCompletion(readClient, store, {
          runId,
          attemptNumber: 1,
          error: RETRIABLE_ERROR,
          retryUsingQueue: false,
          retrySettings: RETRY_SETTINGS,
        });

      // Reading the decision on the owning PRIMARY (this.$.prisma) sees maxAttempts = 3, so the run
      // retries — the behaviour the engine must get.
      const fromPrimary = await decide(prisma);
      expect(fromPrimary.outcome).toBe("retry");

      // Reading the same decision off the lagging replica (this.$.readOnlyPrisma) nulls maxAttempts, so
      // a run with retries remaining is permanently FAILED. Pinning fail_run documents the misrouting
      // the engine must never do.
      const fromReplica = await decide(replica.client);
      expect(replica.wasHit("taskRun")).toBe(true); // the decision read hit the stale replica
      expect(fromReplica.outcome).toBe("fail_run");
    }
  );
});
