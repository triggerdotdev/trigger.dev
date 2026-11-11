import { createRedisClient, type RedisOptions } from "@internal/redis";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  SnapshotResidencyResolver,
} from "@internal/run-store";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { generateInternalId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { SnapshotManager } from "../../../../../packages/cli-v3/src/entryPoints/managed/snapshot.js";
import { ConsoleRunLogger } from "../../../../../packages/cli-v3/src/entryPoints/managed/logger.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../run-store/src/testFixtures/snapshotIdFixture.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import {
  WaitpointSystem,
  cycleAnchorSnapshotId,
  type WaitpointSystemOptions,
} from "../systems/waitpointSystem.js";
import { WaitpointFanoutWorker } from "../waitpointCoordinator/fanoutWorker.js";
import { runBlockKeys } from "../waitpointCoordinator/keys.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { routingEngine } from "./utils/waitpointRouting.js";

async function harness(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  enabled = true,
  nativeSnapshots = false
) {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const pg = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  let failSnapshot = false;
  let failNativeAck = false;
  const snapshots = new RedisSnapshotStore({
    redisOptions,
    beforeCommand: async (operation) => {
      if (failSnapshot && (operation === "append" || operation === "prepare"))
        throw new Error("snapshot dispatch interrupted");
    },
  });
  const runStore = nativeSnapshots
    ? new TaskRunExecutionSnapshotStore(pg, {
        store: snapshots,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({ store: snapshots }),
        resolveCompletedWaitpoints: createCompletedWaitpointResolver(pg),
        logicalRunStoreRoute: "logical:1",
      })
    : pg;
  await runStore.createRun({
    data: {
      ...buildCreateRunData(runId, env),
      status: "EXECUTING",
      attemptNumber: 1,
      annotations: { waitpointsOnStore: true },
    },
    snapshot: {
      id: generateInternalId(),
      createdAt: new Date(),
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Executing",
      runStatus: "EXECUTING",
      attemptNumber: 1,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  });
  let commands = 0;
  const store = new WaitpointStoreCoordinator({
    redisOptions,
    beforeCommand: async () => {
      commands++;
      if (
        failNativeAck &&
        (await prisma.taskRunWaitpoint.count({ where: { taskRunId: runId } })) === 0
      )
        throw new Error("native acknowledgement interrupted");
    },
  });
  const probe = createRedisClient(redisOptions);
  const engine = routingEngine(prisma, redisOptions, {
    store: runStore,
    waitpointStore: store,
    waitpointStoreEnabled: () => enabled,
  });
  // #852 wires this supported adapter. Use the engine's real resources at this foundation.
  const existing = engine.waitpointSystem as unknown as { options: WaitpointSystemOptions };
  engine.waitpointSystem = new WaitpointSystem({
    ...existing.options,
    waitpointRouting: { store: new StoreWaitpointCoordinator({ store }) },
  });
  const context = { runId, organizationId: env.organizationId };
  return {
    engine,
    store,
    probe,
    runStore,
    snapshots,
    runId,
    env,
    context,
    commands: () => commands,
    failSnapshot: (value: boolean) => {
      failSnapshot = value;
    },
    failNativeAck: (value: boolean) => {
      failNativeAck = value;
    },
    async legacy() {
      return (
        await engine.createManualWaitpoint({ environmentId: env.id, projectId: env.projectId })
      ).waitpoint.id;
    },
    async native() {
      const id = generateWaitpointId("DATETIME");
      const now = new Date().toISOString();
      await store.createIfAbsent({
        record: {
          id,
          friendlyId: `waitpoint_${id}`,
          type: "DATETIME",
          environmentId: env.id,
          organizationId: env.organizationId,
          projectId: env.projectId,
          createdAt: now,
          updatedAt: now,
          userProvidedIdempotencyKey: false,
          tags: [],
        },
        status: "PENDING",
      });
      return id;
    },
    async block(ids: string[]) {
      const latest = (await runStore.findLatestExecutionSnapshot(runId))!;
      return engine.blockRunWithWaitpoint({
        ...context,
        projectId: env.projectId,
        waitpoints: ids,
        blockOperation: {
          id: generateInternalId(),
          absorptionId: generateInternalId(),
          cycleAnchor: cycleAnchorSnapshotId(latest),
        },
      });
    },
    async completeLegacy(id: string) {
      await prisma.waitpoint.update({
        where: { id },
        data: { status: "COMPLETED", completedAt: new Date(), output: "{}" },
      });
    },
    async completeNative(id: string) {
      await store.complete({
        waitpointId: id,
        organizationId: env.organizationId,
        completion: {
          completedAt: new Date().toISOString(),
          outputType: "application/json",
          outputIsError: false,
          output: null,
        },
      });
      const fanout = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        observeBacklog: false,
      });
      try {
        await fanout.visit(id);
      } finally {
        await fanout.dispose();
      }
    },
    resume: () => engine.waitpointSystem.continueRunIfUnblocked(context),
    data: () => engine.getRunExecutionData(context),
    edges: () => prisma.taskRunWaitpoint.count({ where: { taskRunId: runId } }),
    async close() {
      await engine.quit();
      await store.quit();
      await snapshots.quit();
      probe.disconnect();
    },
  };
}

containerTestWithIsolatedRedis.for([false, true])(
  "uncommitted legacy block retains its edge on a marked run (enabled=%s)",
  async (enabled, { prisma, redisOptions }) => {
    const h = await harness(prisma, redisOptions, enabled);
    try {
      const id = await h.legacy();
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION reject_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."executionStatus" = 'EXECUTING_WITH_WAITPOINTS' THEN RAISE EXCEPTION 'blocked snapshot rejected'; END IF; RETURN NEW; END $$`
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER reject_block BEFORE INSERT ON "TaskRunExecutionSnapshot" FOR EACH ROW EXECUTE FUNCTION reject_block()`
      );
      await expect(h.block([id])).rejects.toThrow("blocked snapshot rejected");
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_block ON "TaskRunExecutionSnapshot"`);
      expect(await h.edges()).toBe(1);
      const before = await h.data();
      await h.completeLegacy(id);
      await h.resume();
      expect(await h.data()).toEqual(before);
      expect(await h.edges()).toBe(1);
      if (!enabled) expect(h.commands()).toBe(0);
    } finally {
      await h.close();
    }
  }
);

containerTestWithIsolatedRedis(
  "native resume IDs stay ordered through a second wait for the unchanged managed runner",
  async ({ prisma, redisOptions }) => {
    const h = await harness(prisma, redisOptions, true, true);
    try {
      const initial = (await h.data())!;
      const runner = new SnapshotManager({
        runFriendlyId: initial.run.friendlyId,
        runnerId: "test-runner",
        initialSnapshotId: initial.snapshot.friendlyId,
        initialStatus: initial.snapshot.executionStatus,
        logger: new ConsoleRunLogger(),
        onSnapshotChange: async () => {},
        onSuspendable: async () => {},
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        const id = await h.native();
        await h.block([id]);
        const blocked = (await h.data())!;
        await runner.handleSnapshotChanges([blocked]);
        expect(runner.snapshotId).toBe(blocked.snapshot.friendlyId);
        await h.completeNative(id);
        await h.resume();
        const resumed = (await h.data())!;
        expect(resumed.snapshot.executionStatus).toBe("EXECUTING");
        expect(resumed.snapshot.friendlyId > blocked.snapshot.friendlyId).toBe(true);
        await runner.handleSnapshotChanges([resumed]);
        expect(runner.snapshotId).toBe(resumed.snapshot.friendlyId);
        expect(await h.store.currentBlockId(h.runId)).toBeUndefined();
        expect(await h.probe.hget(runBlockKeys(h.runId).state, "rp")).toBeNull();
      }
    } finally {
      await h.close();
    }
  }
);

containerTestWithIsolatedRedis.for([false, true])(
  "failed legacy acknowledgement retains proof until cleanup succeeds (mixed=%s)",
  async (mixed, { prisma, redisOptions }) => {
    const h = await harness(prisma, redisOptions, true, true);
    try {
      const legacy = await h.legacy();
      const native = mixed ? await h.native() : undefined;
      await h.block(native ? [legacy, native] : [legacy]);
      await h.completeLegacy(legacy);
      if (native) await h.completeNative(native);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'edge delete rejected'; END $$`
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER reject_ack BEFORE DELETE ON "TaskRunWaitpoint" FOR EACH ROW EXECUTE FUNCTION reject_ack()`
      );
      await expect(h.resume()).rejects.toThrow("edge delete rejected");
      const resumed = (await h.data())!;
      expect(resumed.snapshot.executionStatus).toBe("EXECUTING");
      expect(await h.edges()).toBe(1);
      expect(await h.probe.hget(runBlockKeys(h.runId).state, "rp")).not.toBeNull();
      if (native) expect(await h.store.currentBlockId(h.runId)).toBeDefined();
      const previous = (await h.runStore.findLatestExecutionSnapshot(h.runId))!;
      await h.engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run: { id: h.runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "Later execution snapshot" },
        previousSnapshotId: previous.id,
        previousSnapshot: previous,
        environmentId: h.env.id,
        environmentType: h.env.type,
        projectId: h.env.projectId,
        organizationId: h.env.organizationId,
      });
      const advanced = (await h.data())!;
      expect(advanced.snapshot.friendlyId > resumed.snapshot.friendlyId).toBe(true);
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_ack ON "TaskRunWaitpoint"`);
      if (mixed) {
        h.failNativeAck(true);
        await expect(h.resume()).rejects.toThrow("native acknowledgement interrupted");
        expect(await h.edges()).toBe(0);
        h.failNativeAck(false);
      }
      await h.resume();
      expect(await h.data()).toEqual(advanced);
      expect(await h.edges()).toBe(0);
      expect(await h.store.currentBlockId(h.runId)).toBeUndefined();
      expect(await h.probe.hget(runBlockKeys(h.runId).state, "rp")).toBeNull();
    } finally {
      await h.close();
    }
  }
);

containerTestWithIsolatedRedis(
  "a prepared native resume cannot acknowledge before its snapshot commits",
  async ({ prisma, redisOptions }) => {
    const h = await harness(prisma, redisOptions, true, true);
    try {
      const id = await h.native();
      await h.block([id]);
      await h.completeNative(id);
      h.failSnapshot(true);
      await expect(h.resume()).rejects.toThrow("snapshot dispatch interrupted");
      const intent = JSON.parse((await h.probe.hget(runBlockKeys(h.runId).state, "rp"))!);
      expect(await h.snapshots.getById(h.runId, intent.snapshotId)).toBeNull();
      expect(await h.store.currentBlockId(h.runId)).toBeDefined();
      h.failSnapshot(false);
      await h.resume();
      const resumed = (await h.data())!;
      expect(resumed.snapshot.friendlyId).toBe(`snapshot_${intent.snapshotId}`);
      expect(await h.store.currentBlockId(h.runId)).toBeUndefined();
    } finally {
      await h.close();
    }
  }
);
