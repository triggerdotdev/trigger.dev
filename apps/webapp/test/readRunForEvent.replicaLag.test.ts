// Verifies readRunForEvent tolerates replica lag on its event-enrichment read (the store.findRun
// closures inside readThroughRun, which in single-DB passthrough route to the replica). Drives the REAL
// exported function over a real Postgres testcontainer with the replica FROZEN via laggingReplica.
// Two properties: (a) PRESENT-BUT-STALE — a completed run whose UPDATE has not replicated returns the row
// with correct immutable identity and stale status, no throw; (b) MISSING — an unreplicated INSERT returns
// null (no throw), the event fires without enrichment. Both self-heal; the row is live on the primary.

import { containerTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { readRunForEvent, type EventReadDeps } from "~/v3/runEngineHandlersShared.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Exactly the immutable+mutable mix a real event-bus enrichment read selects.
const EVENT_SELECT = {
  id: true,
  friendlyId: true,
  traceId: true,
  spanId: true,
  createdAt: true,
  completedAt: true,
  taskIdentifier: true,
  status: true,
  organizationId: true,
} as const;

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

describe("readRunForEvent tolerates replica lag on its event-enrichment read", () => {
  // (a) PRESENT-BUT-STALE.
  containerTest(
    "readRunForEvent returns a present-but-stale run under lag — correct immutable fields, stale status, no throw",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma, "rrfe_stale");

      const runId = "c".repeat(25); // cuid-shaped → LEGACY; passthrough reads it as-is
      const friendlyId = "run_rrfe_stale";
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      const completedAt = new Date("2024-01-01T00:05:00.000Z");

      // The run is COMPLETED on the PRIMARY (completion is an UPDATE applied on the primary).
      await prisma.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          friendlyId,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_rrfe",
          spanId: "span_rrfe",
          queue: "task/my-task",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          isTest: false,
          taskEventStore: "taskEvent",
          createdAt,
          completedAt,
        },
      });

      // A FROZEN replica: the taskRun row is present but PRE-completion (status EXECUTING, completedAt
      // null) — the UPDATE has not replicated. Immutable fields match the live row (they were set at
      // INSERT, before the lag window). Everything else forwards to the real container.
      const replica = laggingReplica(prisma, [
        {
          model: "taskRun",
          mode: "frozen",
          rows: [
            {
              id: runId,
              friendlyId,
              traceId: "trace_rrfe",
              spanId: "span_rrfe",
              createdAt,
              taskIdentifier: "my-task",
              organizationId: organization.id,
              // STALE mutable fields (pre-completion snapshot):
              status: "EXECUTING",
              completedAt: null,
            },
          ],
        },
      ]);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client as never });
      const deps: EventReadDeps = {
        store,
        newReplica: replica.client as never,
        legacyReplica: replica.client as never,
        splitEnabled: false,
      };

      const run = await readRunForEvent(runId, environment.id, EVENT_SELECT, deps);

      // The enrichment read really hit the (lagging) replica.
      expect(replica.wasHit("taskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the run resolves (present-but-stale) — no throw, no null.
      expect(run).not.toBeNull();
      // Immutable identity is CORRECT even off the stale replica:
      expect(run!.id).toBe(runId);
      expect(run!.friendlyId).toBe(friendlyId);
      expect(run!.traceId).toBe("trace_rrfe");
      expect(run!.spanId).toBe("span_rrfe");
      expect(run!.taskIdentifier).toBe("my-task");
      expect(run!.createdAt).toEqual(createdAt);
      // Mutable completion fields are STALE off the replica (this is the tolerated staleness):
      expect(run!.status).toBe("EXECUTING");
      expect(run!.completedAt).toBeNull();

      // The staleness is pure lag: on the PRIMARY the completion is applied.
      const onPrimary = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(onPrimary.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(onPrimary.completedAt).toEqual(completedAt);
      // Immutable fields are identical on primary and the stale replica read.
      expect(onPrimary.friendlyId).toBe(run!.friendlyId);
    }
  );

  // (b) MISSING (INSERT not yet replicated).
  containerTest(
    "readRunForEvent returns null (no throw) when a live run's INSERT has not replicated",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma, "rrfe_missing");

      const runId = "d".repeat(25);
      await prisma.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_rrfe_missing",
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_m",
          spanId: "span_m",
          queue: "task/my-task",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          isTest: false,
          taskEventStore: "taskEvent",
        },
      });

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client as never });
      const deps: EventReadDeps = {
        store,
        newReplica: replica.client as never,
        legacyReplica: replica.client as never,
        splitEnabled: false,
      };

      const run = await readRunForEvent(runId, environment.id, EVENT_SELECT, deps);

      expect(replica.wasHit("taskRun")).toBe(true);
      // OBSERVABLE OUTPUT: not-found degrades to null (no throw); the event fires without enrichment.
      expect(run).toBeNull();

      // The null is pure lag: the run is live on the PRIMARY.
      const onPrimary = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(onPrimary.friendlyId).toBe("run_rrfe_missing");
    }
  );
});
