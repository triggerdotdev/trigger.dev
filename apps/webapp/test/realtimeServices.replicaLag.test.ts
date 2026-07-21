// Replica-lag guards for the realtime-services reads.
//
// Drives the REAL exported callers end-to-end against a real Postgres (heteroPostgresTest) whose
// replica is FROZEN via the shared `laggingReplica` primitive (taskRun mode:"missing"), asserting a
// concrete observable on each caller's output. Every read here is a DISPLAY / probe resolve with a
// real tolerance the caller owns — none is a read-your-writes gate a stale read corrupts:
//
//   1. RunHydrator.hydrateByIds (findRuns on $replica) — under lag the un-replicated row is OMITTED
//      from the frame ([] returned, no throw); the feed self-heals on the next hydrate tick.
//   2. RunHydrator.getRunById / #fetch (findRun on $replica) — returns null ("not yet visible"), no
//      throw; the short-TTL cache re-fetches. A read-only display resolve, never a decision.
//   3. ensureRunForSession → getRunStatusAndFriendlyId (findRun on $replica) — the replica probe
//      misses the live currentRun, the caller's WRITER re-probe recovers it, and the run is reused
//      (triggered:false) without a second trigger.
//   4. swapSessionRun → resolveRunFriendlyId (findRun on $replica) — the replica misses the calling
//      run's friendlyId and the caller falls back to the cuid (?? runId); the swap still COMPLETES
//      (swapped:true).
//   5. serializeSessionWithFriendlyRunId (client-less findRun → replica) — a pre-existing
//      currentRunId pointer resolves to null on the wire (safe degraded direction); GET/PATCH only
//      serialize pre-existing pointers, so this display staleness self-heals on the next GET.
//   6. serializeSessionsWithFriendlyRunIds (client-less findRuns → replica) — the un-replicated run
//      drops out of the id→friendlyId map so that session's currentRunId serializes null. Same
//      self-healing display resolve, batched.
//
// Only webapp singletons orthogonal to the read (db.server handles, the runStore singleton, logger,
// the downstream Trigger/Cancel services) are mocked; the read path and the found/not-found +
// fallback decisions are the genuine article. Reads 1/2 and 5/6 take their store/replica by
// injection, so they drive the real caller with NO module mocking.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient, Session } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// --- Holders wired per-test into the mocked sessionRunManager singletons (reads 3 & 4 only). --------
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));
// Records every TriggerTaskService.call so read 3 can assert NO double-trigger and read 4 can assert
// which previousRunId the resolveRunFriendlyId fallback forwarded.
const triggerState = vi.hoisted(() => ({
  calls: [] as Array<{ taskIdentifier: string; body: any; options: any }>,
  result: { run: { id: "", friendlyId: "" } } as { run: { id: string; friendlyId: string } },
}));

// db.server: two lazy proxies forwarding to the per-test holders. Never mocks the DB — the proxies
// forward to real testcontainer clients (primary = writer, replica = the frozen lagging client).
vi.mock("~/db.server", () => {
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
  };
});

// runStore singleton: a stable Proxy forwarding every method to the per-test real PostgresRunStore.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: storeHolder.store not set before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Downstream trigger is engine work, not the read under test: record the call, return the seeded run.
vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    async call(taskIdentifier: string, _environment: any, body: any, options: any) {
      triggerState.calls.push({ taskIdentifier, body, options });
      return triggerState.result;
    }
  },
}));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call() {}
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
// The REAL exported callers under guard.
import { RunHydrator } from "~/services/realtime/runReader.server";
import { ensureRunForSession, swapSessionRun } from "~/services/realtime/sessionRunManager.server";
import {
  serializeSessionWithFriendlyRunId,
  serializeSessionsWithFriendlyRunIds,
} from "~/services/realtime/sessions.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

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
  status?: CreateRunInput["data"]["status"];
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: p.status ?? "PENDING",
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
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: p.status ?? "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// A cuid-shaped run id (Session.currentRunId stores the internal cuid).
const cuidRunId = (suffix: string) => `run_${suffix.padEnd(24, "x").slice(0, 24)}`;

describe("realtime-svc — replica-lag guards", () => {
  // RunHydrator.hydrateByIds
  heteroPostgresTest(
    "hydrateByIds omits an un-replicated run from the frame ([]), never throws",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `rr_hydrate_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const runId = cuidRunId(`h${seq}`);
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      // The hydrator holds the real store; hydrateByIds passes `options.replica` as the read client.
      const hydrator = new RunHydrator({
        replica: replica.client as PrismaClient,
        runStore: writerStore,
        cacheTtlMs: 0,
      });

      const rows = await hydrator.hydrateByIds(seed.environment.id, [runId]);

      // Observable: the frame is empty (row not visible on the replica), no throw.
      expect(rows).toEqual([]);
      expect(replica.wasHit("taskRun")).toBe(true);

      // The row IS on the primary — the next hydrate tick (writer/primary) recovers it.
      const onPrimary = await writerStore.findRuns(
        {
          where: { runtimeEnvironmentId: seed.environment.id, id: { in: [runId] } },
          select: { id: true, friendlyId: true },
        },
        prisma
      );
      expect(onPrimary).toHaveLength(1);
      expect(onPrimary[0]!.friendlyId).toBe(friendlyId);
    }
  );

  // RunHydrator.getRunById / #fetch
  heteroPostgresTest(
    "getRunById returns null for an un-replicated run (absent frame), never throws",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `rr_fetch_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const runId = cuidRunId(`f${seq}`);
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const hydrator = new RunHydrator({
        replica: replica.client as PrismaClient,
        runStore: writerStore,
        cacheTtlMs: 0,
      });

      const row = await hydrator.getRunById(seed.environment.id, runId);

      // Observable: null (not yet visible), no throw.
      expect(row).toBeNull();
      expect(replica.wasHit("taskRun")).toBe(true);

      const onPrimary = await writerStore.findRunOnPrimary(
        { id: runId, runtimeEnvironmentId: seed.environment.id },
        { select: { friendlyId: true } }
      );
      expect(onPrimary?.friendlyId).toBe(friendlyId);
    }
  );

  // ensureRunForSession → getRunStatusAndFriendlyId
  heteroPostgresTest(
    "ensureRunForSession reuses a live run whose row missed the replica (writer re-probe) — NO double-trigger",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `srm_ensure_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // The live current run — PENDING (non-final) — present on the PRIMARY only.
      const runId = cuidRunId(`e${seq}`);
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING",
        })
      );

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      primaryHolder.client = prisma; // the mocked `prisma` (writer re-probe target)
      replicaHolder.client = replica.client; // the mocked `$replica` (probe target — lags)
      storeHolder.store = writerStore;
      triggerState.calls.length = 0;
      triggerState.result = { run: { id: cuidRunId(`e2${seq}`), friendlyId: `run_${suffix}_2` } };

      const session = {
        id: `session_${suffix}`,
        friendlyId: `session_${suffix}`,
        taskIdentifier: "my-task",
        triggerConfig: { basePayload: {} },
        currentRunId: runId,
        currentRunVersion: 0,
      } as unknown as Pick<
        Session,
        | "id"
        | "friendlyId"
        | "taskIdentifier"
        | "triggerConfig"
        | "currentRunId"
        | "currentRunVersion"
      >;

      const result = await ensureRunForSession({
        session,
        environment: { id: seed.environment.id } as unknown as AuthenticatedEnvironment,
        reason: "manual",
      });

      // Observable: the writer re-probe recovered the live run → reuse it, do NOT trigger a second run.
      expect(result).toEqual({ runId, triggered: false });
      expect(triggerState.calls).toHaveLength(0);
      // The replica WAS consulted first (and, frozen, missed) — proving the recovery is the writer
      // re-probe, not a lucky replica hit.
      expect(replica.wasHit("taskRun")).toBe(true);

      // Proof the run is a live row on the primary (writer read returns it non-final).
      const onPrimary = await writerStore.findRunOnPrimary(
        { id: runId },
        { select: { status: true, friendlyId: true } }
      );
      expect(onPrimary?.status).toBe("PENDING");
    }
  );

  // swapSessionRun → resolveRunFriendlyId
  heteroPostgresTest(
    "swapSessionRun completes under lag; resolveRunFriendlyId falls back to the cuid for previousRunId",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `srm_swap_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // The calling run — present on the PRIMARY only; its friendlyId will NOT be visible on the replica.
      const callingRunId = cuidRunId(`s${seq}`);
      const callingFriendlyId = `run_${suffix}_calling`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId: callingRunId,
          friendlyId: callingFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // A real Session row whose optimistic claim (currentRunId === callingRunId, version 0) can succeed.
      const sessionRow = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed.organization.id,
          taskIdentifier: "my-task",
          triggerConfig: { basePayload: {} },
          currentRunId: callingRunId,
          currentRunVersion: 0,
        },
      });

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;
      storeHolder.store = writerStore;
      triggerState.calls.length = 0;
      const newRunId = cuidRunId(`sn${seq}`);
      const newFriendlyId = `run_${suffix}_new`;
      triggerState.result = { run: { id: newRunId, friendlyId: newFriendlyId } };

      const result = await swapSessionRun({
        session: sessionRow,
        callingRunId,
        environment: { id: seed.environment.id } as unknown as AuthenticatedEnvironment,
        reason: "upgrade",
      });

      // Observable 1: the swap COMPLETED — the replica miss did not fail it.
      expect(result).toEqual({ runId: newRunId, swapped: true });

      // Observable 2: resolveRunFriendlyId missed on the replica and degraded to the cuid, so the
      // previousRunId forwarded to the triggered run is the calling run's cuid (documented fallback).
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.body.payload.previousRunId).toBe(callingRunId);
      expect(replica.wasHit("taskRun")).toBe(true);

      // Proof the null was lag-induced: the primary holds the resolvable friendlyId (≠ the cuid).
      const onPrimary = await writerStore.findRunOnPrimary(
        { id: callingRunId },
        { select: { friendlyId: true } }
      );
      expect(onPrimary?.friendlyId).toBe(callingFriendlyId);
      expect(callingFriendlyId).not.toBe(callingRunId);

      // Wait for the fire-and-forget SessionRun audit write (keyed by the new runId) to land before
      // teardown, so it can't race a closing pool. Poll for the row rather than sleep a fixed interval.
      await vi.waitFor(async () => {
        expect(await prisma.sessionRun.findFirst({ where: { runId: newRunId } })).not.toBeNull();
      });
    }
  );

  // serializeSessionWithFriendlyRunId
  heteroPostgresTest(
    "serializeSessionWithFriendlyRunId serializes currentRunId=null when the run row lags the replica",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sess_one_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const runId = cuidRunId(`o${seq}`);
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const sessionRow = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed.organization.id,
          taskIdentifier: "my-task",
          triggerConfig: { basePayload: {} },
          currentRunId: runId,
          currentRunVersion: 0,
        },
      });

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      // Inject a store whose REPLICA lags; the serializer's client-less findRun reads it.
      const laggingStore = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client });

      const item = await serializeSessionWithFriendlyRunId(sessionRow, laggingStore);

      // Observable: the pre-existing currentRunId pointer resolves to null (safe degraded direction).
      expect(item.currentRunId).toBeNull();
      expect(replica.wasHit("taskRun")).toBe(true);
      expect(item.id).toBe(sessionRow.friendlyId);

      // Proof the row exists on the primary — the client's next GET (replica caught up) resolves it.
      const onPrimary = await writerStore.findRunOnPrimary(
        { id: runId, projectId: seed.project.id, runtimeEnvironmentId: seed.environment.id },
        { select: { friendlyId: true } }
      );
      expect(onPrimary?.friendlyId).toBe(friendlyId);
    }
  );

  // serializeSessionsWithFriendlyRunIds
  heteroPostgresTest(
    "serializeSessionsWithFriendlyRunIds serializes currentRunId=null for a session whose run lags the replica",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sess_list_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const runId = cuidRunId(`l${seq}`);
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const sessionRow = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed.organization.id,
          taskIdentifier: "my-task",
          triggerConfig: { basePayload: {} },
          currentRunId: runId,
          currentRunVersion: 0,
        },
      });

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const laggingStore = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client });

      const items = await serializeSessionsWithFriendlyRunIds(
        [sessionRow],
        { projectId: seed.project.id, runtimeEnvironmentId: seed.environment.id },
        laggingStore
      );

      // Observable: the un-replicated run drops out of the id→friendlyId map → currentRunId null.
      expect(items).toHaveLength(1);
      expect(items[0]!.currentRunId).toBeNull();
      expect(replica.wasHit("taskRun")).toBe(true);

      // Proof the row exists on the primary — the next list fetch resolves it.
      const onPrimary = await writerStore.findRuns(
        {
          where: {
            id: { in: [runId] },
            projectId: seed.project.id,
            runtimeEnvironmentId: seed.environment.id,
          },
          select: { id: true, friendlyId: true },
        },
        prisma
      );
      expect(onPrimary).toHaveLength(1);
      expect(onPrimary[0]!.friendlyId).toBe(friendlyId);
    }
  );
});
