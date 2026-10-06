import { containerTest, postgresTest } from "@internal/testcontainers";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { Prisma } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  deserialiseMollifierSnapshot,
  prepareMollifierReplay,
  serialiseMollifierSnapshot,
} from "../mollifier/mollifierSnapshot.server";
import {
  createSnapshotRolloutResolver,
  type SnapshotRolloutFlags,
} from "./snapshotStoreRollout.server";

postgresTest(
  "snapshotStoreMode uses loaded org flags or one lookup, then the global default",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { title: "Snapshot flags", slug: "snapshot-flags" },
    });
    let reads = 0;
    const observed = prisma.$extends({
      query: {
        organization: {
          async findFirst({ args, query }) {
            reads++;
            return query(args);
          },
        },
      },
    });
    let published: SnapshotRolloutFlags | undefined;
    const rollout = createSnapshotRolloutResolver(() => published, observed);
    expect(await rollout.resolveDial(org.id)).toBe("off");

    for (const mode of ["off", "dual-write", "redis-read", "redis-only"] as const) {
      published = { snapshotStoreMode: "redis-only" };
      const row = await prisma.organization.update({
        where: { id: org.id },
        data: { featureFlags: { snapshotStoreMode: mode } },
      });
      const before = reads;
      expect(await rollout.resolveDial(org.id, row.featureFlags)).toBe(mode);
      expect(reads).toBe(before);
      expect(await rollout.resolveDial(org.id)).toBe(mode);
      expect(reads).toBe(before + 1);
    }

    // Removing the normal org override restores inheritance; no separate enrollment/map to update.
    await prisma.organization.update({
      where: { id: org.id },
      data: { featureFlags: Prisma.DbNull },
    });
    published = { snapshotStoreMode: "dual-write" };
    expect(await rollout.resolveDial(org.id)).toBe("dual-write");
    const before = reads;
    expect(await rollout.resolveDial(org.id, null)).toBe("dual-write");
    expect(await rollout.resolveDial(org.id, {})).toBe("dual-write");
    expect(reads).toBe(before);
    published = { snapshotStoreMode: "off" };
    expect(await rollout.resolveDial(org.id)).toBe("off");
    expect(await rollout.resolveDial(org.id, { snapshotStoreMode: "invalid" })).toBe("off");
  }
);

containerTest(
  "real engine births reuse org flags; later reads follow the live flag without changing residency",
  async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    let published: SnapshotRolloutFlags = { snapshotStoreMode: "redis-only" };
    let lookups = 0;
    const observed = prisma.$extends({
      query: {
        organization: {
          async findFirst({ args, query }) {
            lookups++;
            return query(args);
          },
        },
      },
    });
    const rollout = createSnapshotRolloutResolver(() => published, observed);
    const postgres = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const readSources: string[] = [];
    const store = new TaskRunExecutionSnapshotStore(postgres, {
      store: redis,
      mode: "off",
      resolveDial: rollout.resolveDial,
      logicalRunStoreRoute: "single",
      metrics: { recordWrite() {}, recordReadSource: (source) => readSources.push(source) },
    });
    const engine = new RunEngine({
      prisma,
      store,
      worker: { redis: redisOptions, disabled: true },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("snapshot-org-flags"),
    });
    const input = () => ({
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier: "snapshot-flags",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "trace-flags",
      spanId: "span-flags",
      queue: "task/snapshot-flags",
      isTest: false,
      tags: [],
      // A delayed birth needs no deployed worker and does not release consumers during the test.
      delayUntil: new Date(Date.now() + 60_000),
    });
    try {
      environment.organization.featureFlags = { snapshotStoreMode: "off" };
      await prisma.organization.update({
        where: { id: environment.organization.id },
        data: { featureFlags: environment.organization.featureFlags },
      });
      const offRun = await engine.trigger(input());
      const cancelled = await engine.createCancelledRun({
        snapshot: input(),
        cancelledAt: new Date(),
        cancelReason: "test",
        emitRunCancelledEvent: false,
      });
      expect(lookups).toBe(0);
      for (const run of [offRun, cancelled]) {
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(1);
        expect(await redis.readBirthResidency(run.id)).toBeUndefined();
      }

      environment.organization.featureFlags = { snapshotStoreMode: "dual-write" };
      await prisma.organization.update({
        where: { id: environment.organization.id },
        data: { featureFlags: environment.organization.featureFlags },
      });
      const mirrored = await engine.trigger(input());
      expect(lookups).toBe(0);
      expect(await redis.readBirthResidency(mirrored.id)).toBe("mirrored");

      for (const mode of ["dual-write", "redis-read", "redis-only", "off"] as const) {
        await prisma.organization.update({
          where: { id: environment.organization.id },
          data: { featureFlags: { snapshotStoreMode: mode } },
        });
        const before = lookups;
        const head = await store.findLatestExecutionSnapshot(
          mirrored.id,
          prisma,
          environment.id,
          environment.organization.id
        );
        expect(head).not.toBeNull();
        expect(lookups).toBe(before + 1);
        expect(readSources.at(-1)).toBe(
          mode === "off" || mode === "dual-write" ? "postgres" : "redis"
        );
        expect(await redis.readBirthResidency(mirrored.id)).toBe("mirrored");
      }

      environment.organization.featureFlags = null;
      await prisma.organization.update({
        where: { id: environment.organization.id },
        data: { featureFlags: Prisma.DbNull },
      });
      const before = lookups;
      const primary = await engine.trigger(input());
      expect(lookups).toBe(before);
      expect(await redis.readBirthResidency(primary.id)).toBe("redis-primary");
      published = { snapshotStoreMode: "off" };
      expect(
        (
          await store.findLatestExecutionSnapshot(
            primary.id,
            prisma,
            environment.id,
            environment.organization.id
          )
        )?.runId
      ).toBe(primary.id);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: primary.id } })).toBe(0);

      // The same buffered input feeds both normal and cancelled materialization. Its saved flags
      // must not override a newer org decision; regular (unbuffered) births above still avoid IO.
      for (const mode of ["off", "redis-only"] as const) {
        const staleMode = mode === "off" ? "redis-only" : "off";
        environment.organization.featureFlags = { snapshotStoreMode: staleMode };
        const buffered = deserialiseMollifierSnapshot(serialiseMollifierSnapshot(input()));
        await prisma.organization.update({
          where: { id: environment.organization.id },
          data: { featureFlags: { snapshotStoreMode: mode } },
        });
        const replay = prepareMollifierReplay(buffered) as Parameters<RunEngine["trigger"]>[0];
        const beforeReplay = lookups;
        const replayed = await engine.trigger(replay);
        const cancelledReplay = await engine.createCancelledRun({
          snapshot: { ...replay, friendlyId: generateFriendlyId("run") },
          cancelledAt: new Date(),
          cancelReason: "buffered cancel",
          emitRunCancelledEvent: false,
        });
        for (const run of [replayed, cancelledReplay]) {
          expect(await redis.readBirthResidency(run.id)).toBe(
            mode === "off" ? undefined : "redis-primary"
          );
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(
            mode === "off" ? 1 : 0
          );
        }
        expect(lookups).toBe(beforeReplay + 2);
        expect(replay.environment.organization.featureFlags).toBeUndefined();
        expect(environment.organization.featureFlags).toEqual({ snapshotStoreMode: staleMode });
      }
    } finally {
      await engine.quit();
      await redis.quit();
    }
  }
);
