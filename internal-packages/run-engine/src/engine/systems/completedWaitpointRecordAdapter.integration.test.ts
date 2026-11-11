// The completed-waitpoint resolver driven through the REAL production WaitpointSystem: a real
// WaitpointSystem, a real Postgres run store, and a real MemoryDB coordinator, so this exercises the
// actual reader wiring — the enabled COMPLETED filter and the optional store-reader — not a
// test-local copy of it. Removing either from production turns a test here red. No mocks
// (testcontainers). Reaching a full Redis-primary cycle would need the whole snapshot/engine stack, so
// this drives the resolver seam WaitpointSystem builds for that cycle directly.
import {
  containerTest,
  containerTestWithIsolatedRedis as engineTest,
} from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { describe, expect, vi } from "vitest";
import { enhanceExecutionSnapshotWithWaitpoints } from "./executionSnapshotSystem.js";
import {
  buildCompletedWaitpointRecords,
  expandCompletedWaitpointRecords,
} from "./completedWaitpointResolver.js";
import {
  resolveCompletedWaitpointRecords,
  UnresolvableCompletedWaitpointRecordsError,
} from "./completedWaitpointRecordAdapter.js";
import { waitpointKeys } from "../waitpointCoordinator/keys.js";
import { routingEngine } from "../tests/utils/waitpointRouting.js";
import {
  WaitpointStoreCoordinator,
  type WaitpointCompletion,
  type WaitpointRecordInput,
} from "../waitpointCoordinator/storeCoordinator.js";

// The production resolver seam WaitpointSystem builds for a redis-primary resume. TS-private on the
// class, reached here through a structural cast so the test drives the real method, not a copy.
type ResumeResolver = {
  resolveResumeCompletedWaitpointRecords(
    runId: string,
    blockingWaitpoints: { waitpoint: { id: string } }[],
    organizationId?: string
  ): Promise<CompletedWaitpointRecord[]>;
};

function makeWaitpointSystem(
  fixtures: Array<{ quit(): Promise<void> }>,
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  opts: { withStore: boolean; enabled?: boolean; resolveEnabled?: () => boolean | Promise<boolean> }
): { system: ResumeResolver; store?: WaitpointStoreCoordinator } {
  const store = opts.withStore ? new WaitpointStoreCoordinator({ redisOptions }) : undefined;
  const instance = routingEngine(prisma, redisOptions, {
    waitpointStore: store,
    waitpointStoreEnabled: opts.resolveEnabled ?? (() => opts.enabled ?? true),
  });
  fixtures.push({
    quit: async () => {
      try {
        await instance.quit();
      } finally {
        await store?.quit();
      }
    },
  });
  const system = instance.waitpointSystem as unknown as ResumeResolver;
  return {
    system: {
      resolveResumeCompletedWaitpointRecords: (runId, blockers) =>
        system.resolveResumeCompletedWaitpointRecords(runId, blockers, "test-org"),
    },
    store,
  };
}

async function quitFixtures(fixtures: Array<{ quit(): Promise<void> }>) {
  const results = await Promise.allSettled(fixtures.map((fixture) => fixture.quit()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

const LEGACY_ID = "clq" + "legacywaitpoint00000001";

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

function storeRecordInput(
  id: string,
  overrides: Partial<WaitpointRecordInput> = {}
): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: "env_1",
    projectId: "proj_1",
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

async function seedCompletedStoreWaitpoint(
  store: WaitpointStoreCoordinator,
  id: string,
  record: Partial<WaitpointRecordInput>,
  completion: WaitpointCompletion
) {
  await store.createIfAbsent({ record: storeRecordInput(id, record), status: "PENDING" });
  await store.complete({ waitpointId: id, completion });
}

const blockers = (...ids: string[]) => ids.map((id) => ({ waitpoint: { id } }));

describe("completed-waitpoint resolver through the real WaitpointSystem", () => {
  engineTest(
    "resolves a mixed legacy + store-format cycle into one complete, ordered record set",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const { system, store } = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: true,
      });
      try {
        const env = await seedEnv(prisma, "mixed");

        await prisma.waitpoint.create({
          data: {
            id: LEGACY_ID,
            friendlyId: `waitpoint_${LEGACY_ID}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date("2026-08-21T10:00:00.000Z"),
            idempotencyKey: "idem_legacy",
            userProvidedIdempotencyKey: true,
            output: '{"legacy":true}',
            outputType: "application/json",
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const storeId = generateWaitpointId("RUN");
        await seedCompletedStoreWaitpoint(
          store!,
          storeId,
          { type: "RUN", completedByTaskRunId: "run_child_tri_13441" },
          {
            completedAt: "2026-08-21T11:00:00.000Z",
            outputType: "application/json",
            outputIsError: false,
            output: { inline: '{"store":true}' },
          }
        );

        const records = await system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(LEGACY_ID, storeId, storeId, LEGACY_ID)
        );

        expect(records.map((r) => r.id)).toEqual([LEGACY_ID, storeId]);

        const legacy = records.find((r) => r.id === LEGACY_ID)!;
        expect(legacy.output).toEqual({ inline: '{"legacy":true}' });
        expect(legacy.completedAt).toBe("2026-08-21T10:00:00.000Z");
        expect(legacy.idempotencyKey).toBe("idem_legacy");

        const storeRec = records.find((r) => r.id === storeId)!;
        expect(storeRec.type).toBe("RUN");
        expect(storeRec.completedByTaskRunId).toBe("run_child_tri_13441");
        expect(storeRec.output).toEqual({ deriveFromRun: true });

        // Ordered, duplicate-preserving references and their indexes survive the read-time enhancement.
        const snapshot = {
          id: "snap_1",
          runId: "run_reader",
          batchId: "batch_1",
          checkpoint: null,
        } as never;
        const order = [storeId, LEGACY_ID, storeId];
        const rows = expandCompletedWaitpointRecords(
          {
            runId: "run_reader",
            batchId: "batch_1",
            pointer: { cycleSeq: 1, count: order.length },
            order,
            records,
          },
          () => '{"store":true}'
        );
        const enhanced = enhanceExecutionSnapshotWithWaitpoints(
          snapshot,
          rows,
          order
        ).completedWaitpoints;
        expect(enhanced.filter((r) => r.id === storeId).map((r) => r.index)).toEqual([0, 2]);
        expect(enhanced.find((r) => r.id === LEGACY_ID)!.index).toBe(1);
      } finally {
        await quitFixtures(fixtures);
        await store?.quit();
      }
    }
  );

  engineTest(
    "resolves a store-format id only because the store reader is wired in (guards the optional wiring)",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const withStore = makeWaitpointSystem(fixtures, prisma, redisOptions, { withStore: true });
      const withoutStore = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: false,
      });
      try {
        await seedEnv(prisma, "store-wiring");
        const storeId = generateWaitpointId("MANUAL");
        await seedCompletedStoreWaitpoint(
          withStore.store!,
          storeId,
          {},
          {
            completedAt: "2026-08-21T11:00:00.000Z",
            outputType: "application/json",
            outputIsError: false,
            output: { inline: '{"ok":true}' },
          }
        );

        // Wired: the store-format id resolves.
        const records = await withStore.system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(storeId)
        );
        expect(records.map((r) => r.id)).toEqual([storeId]);

        // Not wired: preserve the original Postgres lookup, where this ID has no row.
        await expect(
          withoutStore.system.resolveResumeCompletedWaitpointRecords(
            "run_reader",
            blockers(storeId)
          )
        ).resolves.toEqual([]);
      } finally {
        await quitFixtures(fixtures);
        await withStore.store?.quit();
      }
    }
  );

  engineTest(
    "filters PENDING legacy waitpoints only when the store reader is enabled",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const { system, store } = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: true,
      });
      try {
        const env = await seedEnv(prisma, "pending");
        await prisma.waitpoint.create({
          data: {
            id: LEGACY_ID,
            friendlyId: `waitpoint_${LEGACY_ID}`,
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: "idem_pending",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });

        const disabled = makeWaitpointSystem(fixtures, prisma, redisOptions, {
          withStore: false,
          enabled: false,
        });
        const enabledWithoutReader = makeWaitpointSystem(fixtures, prisma, redisOptions, {
          withStore: false,
          enabled: true,
        });
        // This PR cannot activate the stricter adapter before its reader is wired.
        const unchanged = await enabledWithoutReader.system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(LEGACY_ID, "missing_legacy")
        );
        expect(unchanged.map((r) => r.id)).toEqual([LEGACY_ID]);
        const flagReader = createRedisClient(redisOptions);
        await flagReader.quit();
        const unavailableFlagWithoutReader = makeWaitpointSystem(fixtures, prisma, redisOptions, {
          withStore: false,
          resolveEnabled: async () => (await flagReader.get("waitpoint-flag")) === "1",
        });
        await expect(
          unavailableFlagWithoutReader.system.resolveResumeCompletedWaitpointRecords(
            "run_reader",
            blockers(LEGACY_ID, "missing_legacy")
          )
        ).resolves.toMatchObject([{ id: LEGACY_ID }]);
        await expect(
          unavailableFlagWithoutReader.system.resolveResumeCompletedWaitpointRecords(
            "run_reader",
            blockers(generateWaitpointId("RUN"))
          )
        ).resolves.toEqual([]);
        const baseline = await disabled.system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(LEGACY_ID)
        );
        expect(baseline.map((r) => r.id)).toEqual([LEGACY_ID]);
        await expect(
          disabled.system.resolveResumeCompletedWaitpointRecords(
            "run_reader",
            blockers("missing_legacy")
          )
        ).resolves.toEqual([]);
        await expect(
          system.resolveResumeCompletedWaitpointRecords("run_reader", blockers(LEGACY_ID))
        ).rejects.toBeInstanceOf(UnresolvableCompletedWaitpointRecordsError);
      } finally {
        await quitFixtures(fixtures);
        await store?.quit();
      }
    }
  );

  engineTest(
    "fails loud and publishes nothing when a store record is missing",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const { system, store } = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: true,
      });
      try {
        const env = await seedEnv(prisma, "missing");
        const presentId = generateWaitpointId("MANUAL");
        const missingId = generateWaitpointId("MANUAL");
        await seedCompletedStoreWaitpoint(
          store!,
          presentId,
          {},
          {
            completedAt: "2026-08-21T11:00:00.000Z",
            outputType: "application/json",
            outputIsError: false,
            output: null,
          }
        );

        // A matching Postgres row must never be used as fallback for a Redis-format ID.
        await prisma.waitpoint.create({
          data: {
            id: missingId,
            friendlyId: `waitpoint_${missingId}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            idempotencyKey: "shadow-store-record",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });
        await expect(
          system.resolveResumeCompletedWaitpointRecords(
            "run_reader",
            blockers(presentId, missingId)
          )
        ).rejects.toThrow(/No store waitpoint record/);
        const withoutStore = makeWaitpointSystem(fixtures, prisma, redisOptions, {
          withStore: false,
        });
        // Unwired readers preserve the original Postgres mapping, including this matching row.
        const legacyRecords = await withoutStore.system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(presentId, missingId)
        );
        expect(legacyRecords.map((record) => record.id)).toEqual([missingId]);
        expect(legacyRecords[0]).toMatchObject({
          type: "MANUAL",
          idempotencyKey: undefined,
          output: null,
        });
        await store!.quit();
        await expect(
          system.resolveResumeCompletedWaitpointRecords("run_reader", blockers(missingId))
        ).rejects.toThrow(/Connection is closed/);
      } finally {
        await quitFixtures(fixtures);
        await store?.quit();
      }
    }
  );

  engineTest(
    "legacy-only validation needs no Redis reads and rejects incomplete coverage",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const { system, store } = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: true,
      });
      try {
        const env = await seedEnv(prisma, "legacy-only");
        await prisma.waitpoint.create({
          data: {
            id: LEGACY_ID,
            friendlyId: `waitpoint_${LEGACY_ID}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            idempotencyKey: "legacy-only",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.environment.id,
          },
        });
        await store!.quit();
        const records = await system.resolveResumeCompletedWaitpointRecords(
          "run_reader",
          blockers(LEGACY_ID, LEGACY_ID)
        );
        expect(records.map((r) => r.id)).toEqual([LEGACY_ID]);
        for (const missing of ["missing_legacy", "!!! not an id !!!"]) {
          await expect(
            system.resolveResumeCompletedWaitpointRecords(
              "run_reader",
              blockers(LEGACY_ID, missing)
            )
          ).rejects.toThrow(/No completed legacy waitpoint record/);
        }
      } finally {
        await quitFixtures(fixtures);
        await store?.quit();
      }
    }
  );

  engineTest(
    "rejects pending, incomplete, and mismatched records read from Redis",
    async ({ prisma, redisOptions }) => {
      const fixtures: Array<{ quit(): Promise<void> }> = [];
      const { system, store } = makeWaitpointSystem(fixtures, prisma, redisOptions, {
        withStore: true,
      });
      const probe = createRedisClient(redisOptions);
      try {
        const id = generateWaitpointId("MANUAL");
        const record = storeRecordInput(id);
        await store!.createIfAbsent({ record, status: "PENDING" });
        await expect(
          system.resolveResumeCompletedWaitpointRecords("run_reader", blockers(id))
        ).rejects.toThrow(/not COMPLETED/);
        // Corrupt actual persisted state: exercise the production reader and adapter together.
        await probe.hset(waitpointKeys(id).record, "status", "COMPLETED");
        await expect(
          system.resolveResumeCompletedWaitpointRecords("run_reader", blockers(id))
        ).rejects.toThrow(/no completion envelope/);
        await probe.hset(
          waitpointKeys(id).record,
          "r",
          JSON.stringify({ ...record, id: generateWaitpointId("MANUAL") })
        );
        await expect(
          system.resolveResumeCompletedWaitpointRecords("run_reader", blockers(id))
        ).rejects.toThrow(/for requested id/);
      } finally {
        await quitFixtures(fixtures);
        probe.disconnect();
        await store?.quit();
      }
    }
  );

  containerTest(
    "uses one effective time and one Redis read per distinct ID",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const probe = createRedisClient(redisOptions);
      try {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
        vi.setSystemTime(now);
        const ids = [generateWaitpointId("MANUAL"), generateWaitpointId("MANUAL")];
        for (const [index, id] of ids.entries()) {
          await seedCompletedStoreWaitpoint(
            store,
            id,
            {
              userProvidedIdempotencyKey: true,
              idempotencyKey: `key-${index}`,
              idempotencyKeyExpiresAt: new Date(now + 1).toISOString(),
            },
            {
              completedAt: new Date(now).toISOString(),
              outputType: "application/json",
              outputIsError: false,
              output: null,
            }
          );
        }
        const hmgetCalls = async () =>
          Number((await probe.info("commandstats")).match(/cmdstat_hmget:calls=(\d+)/)?.[1] ?? 0);
        const before = await hmgetCalls();
        let clockCalls = 0;
        vi.setSystemTime(now);
        const records = await resolveCompletedWaitpointRecords({
          requestedIds: [ids[0]!, ids[1]!, ids[0]!],
          legacyReader: async (requested) =>
            buildCompletedWaitpointRecords(
              await prisma.waitpoint.findMany({ where: { id: { in: requested } } })
            ),
          storeReader: (requested) => store.readCompletedRecords(requested),
          now: () => {
            clockCalls++;
            return Date.now();
          },
        });
        expect(clockCalls).toBe(1);
        expect(records.map((r) => r.idempotencyKey)).toEqual(["key-0", "key-1"]);
        expect((await hmgetCalls()) - before).toBe(2);
      } finally {
        vi.useRealTimers();
        probe.disconnect();
        await store.quit();
      }
    }
  );
});
