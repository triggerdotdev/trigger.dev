// Replica-lag properties for the AI-session + batch DASHBOARD presenters. Drives the REAL exported
// presenter classes (SessionListPresenter, SessionPresenter, BatchPresenter) end-to-end via `.call()`
// against a real Postgres (heteroPostgresTest) whose READ replica is FROZEN via the shared
// `laggingReplica` primitive (run/batch row on the primary, not yet replicated); only orthogonal
// peripherals are mocked (ClickHouse session list, displayable-env, worker-deployment probe, presign).

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ~/db.server: the two proxies the run-store / control-plane singletons read from point at our
// per-test holders (never mocks the DB itself — the proxies forward to a real testcontainer client).
// Run-ops split handles left undefined => runStore.server builds the single-DB passthrough store
// (writer = `prisma`, replica = `$replica`), the exact webapp single-DB topology these reads live in.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// ---- Orthogonal peripherals ---------------------------------------------------------------------

// A stub displayable environment (control-plane resolve, orthogonal to the run-ops run/batch read).
const STUB_ENV = {
  id: "env_stub",
  type: "DEVELOPMENT" as const,
  slug: "dev",
  organizationId: "org_stub",
  projectId: "proj_stub",
  userId: undefined,
  branchName: null,
  git: null,
};

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findDisplayableEnvironment: async () => STUB_ENV,
}));

// SessionListPresenter's possibleTasks probe — orthogonal; no worker seeded -> empty task list.
vi.mock("~/v3/models/workerDeployment.server", () => ({
  findCurrentWorkerFromEnvironment: async () => null,
}));

// SessionListPresenter's session list comes from ClickHouse via SessionsRepository — orthogonal to
// its run-store run read. The mock returns a controlled session whose currentRunId points at the run
// we seed on the primary only, so that findRuns read is exercised for real against the lag.
const sessionListHolder = vi.hoisted(() => ({ sessions: [] as any[] }));
vi.mock("~/services/sessionsRepository/sessionsRepository.server", () => ({
  LEGACY_PLAYGROUND_TAG: "__playground__",
  SessionsRepository: class {
    constructor(_deps: any) {}
    async listSessions() {
      return {
        sessions: sessionListHolder.sessions,
        pagination: { nextCursor: null, previousCursor: null },
      };
    }
  },
}));

// SessionPresenter snapshot presign — orthogonal object-store call; a miss is handled gracefully.
vi.mock("~/v3/objectStore.server", () => ({
  generatePresignedUrl: async () => ({ success: false as const, error: "stub" }),
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
// The REAL callers under guard.
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { SessionPresenter } from "~/presenters/v3/SessionPresenter.server";
import { BatchPresenter } from "~/presenters/v3/BatchPresenter.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
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
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

describe("session/batch dashboard presenters under replica lag", () => {
  // Read 1 — SessionListPresenter findRuns.
  heteroPostgresTest(
    "SessionListPresenter.call renders the list row with currentRunFriendlyId undefined under lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sesslist_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // Seed the current run on the PRIMARY only.
      const runId = `run_sesslist_${suffix}`;
      const runFriendlyId = `run_sl_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: runFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // ClickHouse session list (mocked) yields ONE session pointing at that run.
      sessionListHolder.sessions = [
        {
          id: `sess_${suffix}`,
          friendlyId: `session_${suffix}`,
          externalId: null,
          type: "chat",
          taskIdentifier: "my-agent",
          isTest: false,
          tags: [],
          closedAt: null,
          closedReason: null,
          expiresAt: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          currentRunId: runId,
        },
      ];

      // A REAL lagging replica: taskRun reads miss; everything else forwards to the real container.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      const presenter = new SessionListPresenter(replica.client as any, {} as any);
      const result = await presenter.call(seed.organization.id, seed.environment.id, {
        projectId: seed.project.id,
      });

      // The run read really hit the (lagging) replica.
      expect(replica.wasHit("taskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the session still renders; the run-link is simply absent under lag.
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe(`sess_${suffix}`);
      expect(result.sessions[0].currentRunFriendlyId).toBeUndefined();

      // The omission is pure replica lag: the run exists on the PRIMARY.
      const onPrimary = await prisma.taskRun.findFirst({ where: { id: runId } });
      expect(onPrimary?.friendlyId).toBe(runFriendlyId);
    }
  );

  // Read 2 — SessionPresenter findRuns + findRun (currentRun fallback).
  heteroPostgresTest(
    "SessionPresenter.call returns the detail with currentRun and history run null under lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sessdetail_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // Seed the run on the PRIMARY only.
      const runId = `run_sessdetail_${suffix}`;
      const runFriendlyId = `run_sd_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: runFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // Seed the Session (currentRunId -> the run) + a SessionRun history row (runId -> the run).
      const sessionFriendlyId = `session_${suffix}`;
      const session = await prisma.session.create({
        data: {
          friendlyId: sessionFriendlyId,
          type: "chat",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed.organization.id,
          taskIdentifier: "my-agent",
          triggerConfig: { basePayload: {} },
          currentRunId: runId,
        },
      });
      await prisma.sessionRun.create({
        data: { sessionId: session.id, runId, reason: "initial" },
      });

      // taskRun frozen-missing on the replica; Session + SessionRun forward to the primary.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      const presenter = new SessionPresenter(replica.client as any);
      const result = await presenter.call({
        userId: "user_x",
        environmentId: seed.environment.id,
        sessionParam: sessionFriendlyId,
        projectExternalRef: seed.project.externalRef,
        environmentSlug: "dev",
      });

      // The run reads really hit the (lagging) replica.
      expect(replica.wasHit("taskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the detail resolves (session found via the forwarding replica)...
      expect(result).not.toBeNull();
      expect(result!.friendlyId).toBe(sessionFriendlyId);
      // ...currentRun link self-heals to null under lag (both the map read AND the fallback miss)...
      expect(result!.currentRun).toBeNull();
      // ...and the history row renders with a null run summary.
      expect(result!.runs).toHaveLength(1);
      expect(result!.runs[0].run).toBeNull();

      // The nulls are pure replica lag: the run exists on the PRIMARY.
      const onPrimary = await prisma.taskRun.findFirst({ where: { id: runId } });
      expect(onPrimary?.friendlyId).toBe(runFriendlyId);
    }
  );

  // Read 3 — BatchPresenter findBatchTaskRunByFriendlyId (recovered via primary re-read).
  heteroPostgresTest(
    "BatchPresenter.call returns a live batch under lag via the primary re-read",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `batch_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // Seed the batch on the PRIMARY only.
      const batchId = `batch_${suffix}`;
      const batchFriendlyId = `batch_fr_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createBatchTaskRun({
        id: batchId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: seed.environment.id,
      });

      // batchTaskRun frozen-missing on the replica.
      const replica = laggingReplica(prisma, [{ model: "batchTaskRun", mode: "missing" }]);

      // BatchPresenter reads via an INJECTED real store: writer = primary, read-replica = lagging.
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client as any });
      const presenter = new BatchPresenter(
        prisma as any, // _prisma  -> the owning primary (the re-read target)
        replica.client as any, // _replica -> the lagging replica (the read under test)
        { resolveDisplayableEnvironment: async () => STUB_ENV as any },
        store
      );

      const result = await presenter.call({
        environmentId: seed.environment.id,
        batchId: batchFriendlyId,
        userId: "user_x",
      });

      // The read really hit the (lagging) replica (the read-your-writes hazard was exercised)...
      expect(replica.wasHit("batchTaskRun")).toBe(true);

      // ...and the presenter returned the LIVE batch via the primary re-read, not "Batch not found".
      expect(result.id).toBe(batchId);
      expect(result.friendlyId).toBe(batchFriendlyId);

      // The row is genuinely on the PRIMARY (so the recovery is a real primary read, not the replica).
      const onPrimary = await prisma.batchTaskRun.findFirst({ where: { id: batchId } });
      expect(onPrimary?.friendlyId).toBe(batchFriendlyId);
    }
  );
});
