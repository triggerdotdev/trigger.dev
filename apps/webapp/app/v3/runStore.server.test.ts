import { heteroPostgresTest, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { buildRunStore } from "./runStore.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char internal id -> cuid -> LEGACY; v1 body (version "1" at index 25) -> NEW.
const CUID_25 = "c".repeat(25);
const NEW_ID_26 = "k".repeat(24) + "01";

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

function createRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    data: {
      id: params.runId,
      engine: "V2" as const,
      status: "PENDING" as const,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT" as const,
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha"],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2" as const,
      executionStatus: "RUN_CREATED" as const,
      description: "Run was created",
      runStatus: "PENDING" as const,
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT" as const,
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

describe("T24 — findRun resolves run-ops run on dedicated DB", () => {
  heteroRunOpsPostgresTest(
    "split ON: findRun({friendlyId, runtimeEnvironmentId}, {select}) finds a run-ops run on the new store",
    async ({ prisma14, prisma17 }) => {
      const ENV_ID = "env_t24_runops_probe";
      const WORKER_ID = "worker_t24_lock";
      await prisma17.taskRun.create({
        data: {
          id: NEW_ID_26,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: `run_${NEW_ID_26}`,
          runtimeEnvironmentId: ENV_ID,
          environmentType: "DEVELOPMENT",
          organizationId: "org_t24",
          projectId: "proj_t24",
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace_t24",
          spanId: "span_t24",
          queue: "task/my-task",
          lockedToVersionId: WORKER_ID,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      });

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const run = await store.findRun(
        { friendlyId: `run_${NEW_ID_26}`, runtimeEnvironmentId: ENV_ID },
        { select: { lockedToVersionId: true } }
      );

      expect(run).not.toBeNull();
      expect(run?.lockedToVersionId).toBe(WORKER_ID);
      expect(await prisma14.taskRun.findUnique({ where: { id: NEW_ID_26 } })).toBeNull();
    }
  );
});

describe("buildRunStore", () => {
  heteroPostgresTest(
    "split OFF returns a passthrough PostgresRunStore that writes only to the single DB",
    async ({ prisma14, prisma17 }) => {
      // Single-DB: every handle is prisma14. prisma17 must stay untouched.
      const store = buildRunStore({
        splitEnabled: false,
        newWriter: prisma14,
        newReplica: prisma14,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      expect(store).toBeInstanceOf(PostgresRunStore);

      const seed = await seedEnvironment(prisma14, "off");
      // A run-ops id (would route to NEW under split) must still land on the single DB.
      const runId = NEW_ID_26;
      await store.createRun(
        createRunInput({
          runId,
          friendlyId: "run_off",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      expect(await prisma14.taskRun.findUnique({ where: { id: runId } })).not.toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: runId } })).toBeNull();
    }
  );

  heteroPostgresTest(
    "split ON routes a NEW-classified create to the new store and a LEGACY-classified create to the legacy store",
    async ({ prisma14, prisma17 }) => {
      // legacy = PG14, new = PG17.
      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      expect(store).toBeInstanceOf(RoutingRunStore);

      const seedNew = await seedEnvironment(prisma17, "on_new");
      const seedLegacy = await seedEnvironment(prisma14, "on_legacy");

      // run-ops id -> NEW (PG17)
      await store.createRun(
        createRunInput({
          runId: NEW_ID_26,
          friendlyId: "run_new",
          organizationId: seedNew.organization.id,
          projectId: seedNew.project.id,
          runtimeEnvironmentId: seedNew.environment.id,
        })
      );
      expect(await prisma17.taskRun.findUnique({ where: { id: NEW_ID_26 } })).not.toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: NEW_ID_26 } })).toBeNull();

      // cuid -> LEGACY (PG14)
      await store.createRun(
        createRunInput({
          runId: CUID_25,
          friendlyId: "run_legacy",
          organizationId: seedLegacy.organization.id,
          projectId: seedLegacy.project.id,
          runtimeEnvironmentId: seedLegacy.environment.id,
        })
      );
      expect(await prisma14.taskRun.findUnique({ where: { id: CUID_25 } })).not.toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: CUID_25 } })).toBeNull();
    }
  );

  heteroPostgresTest(
    "split ON keeps a write on a LEGACY-classified id on the legacy store",
    async ({ prisma14, prisma17 }) => {
      // Routing is pure id-shape, so a cuid write stays LEGACY.
      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const seedLegacy = await seedEnvironment(prisma14, "no_marker_legacy");
      // The run lives on LEGACY (PG14); seed it directly.
      await prisma14.taskRun.create({
        data: {
          id: CUID_25,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_no_marker",
          runtimeEnvironmentId: seedLegacy.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seedLegacy.organization.id,
          projectId: seedLegacy.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: "t",
          spanId: "s",
          queue: "task/my-task",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      });

      const updated = await store.updateMetadata(
        CUID_25,
        {
          metadata: '{"k":"v"}',
          metadataType: "application/json",
          metadataVersion: { increment: 1 },
          updatedAt: new Date("2024-01-02T00:00:00.000Z"),
        },
        {}
      );
      expect(updated.count).toBe(1);

      const onLegacy = await prisma14.taskRun.findUnique({ where: { id: CUID_25 } });
      expect(onLegacy?.metadata).toBe('{"k":"v"}');
      expect(await prisma17.taskRun.findUnique({ where: { id: CUID_25 } })).toBeNull();
    }
  );
});
