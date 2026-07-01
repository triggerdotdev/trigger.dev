import { describe, expect, afterEach, vi } from "vitest";

// These tests exercise the store-routed engine create/get seam and the
// residency-keyed id contract (the same id-shaping the create route's response
// uses). They do NOT drive the route's HTTP action — only the engine create/get
// seam behind it.

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import {
  WaitpointId,
  setKsuidMintEnabled,
  ownerEngine,
  KSUID_LENGTH,
} from "@trigger.dev/core/v3/isomorphic";
import { Prisma } from "@trigger.dev/database";
import { trace } from "@opentelemetry/api";
import { nanoid } from "nanoid";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  // Never let the ksuid mint mode leak into other webapp tests.
  setKsuidMintEnabled(false);
});

function buildEngine(opts: {
  prisma: any;
  redisOptions: any;
  store?: ConstructorParameters<typeof RunEngine>[0]["store"];
}) {
  return new RunEngine({
    prisma: opts.prisma,
    ...(opts.store ? { store: opts.store } : {}),
    worker: {
      redis: opts.redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: opts.redisOptions,
    },
    runLock: {
      redis: opts.redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("waitpoint-token create engine seam — residency-keyed id contract", () => {
  // Test A: the create seam mints a KSUID WaitpointId on the run-ops engine.
  containerTest(
    "create mints a KSUID WaitpointId on the run-ops engine",
    async ({ prisma, redisOptions }) => {
      setKsuidMintEnabled(true);

      const engine = buildEngine({ prisma, redisOptions });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() + 60_000),
        });

        // `WaitpointId.generate()` returns a bare (un-prefixed) internal id, so
        // result.waitpoint.id is the raw 27-char ksuid body.
        expect(result.waitpoint.id.length).toBe(KSUID_LENGTH);
        expect(result.waitpoint.type).toBe("MANUAL");

        // The waitpoint row exists on the run-ops store (single-DB: the container prisma).
        const row = await prisma.waitpoint.findUnique({ where: { id: result.waitpoint.id } });
        expect(row).not.toBeNull();
        expect(row?.environmentId).toBe(env.id);

        // The exact response body id, computed as the route computes it.
        const responseId = WaitpointId.toFriendlyId(result.waitpoint.id);
        expect(responseId.startsWith("waitpoint_")).toBe(true);
        expect(responseId).toBe("waitpoint_" + result.waitpoint.id);
        expect(WaitpointId.fromFriendlyId(responseId)).toBe(result.waitpoint.id);

        // The id a client receives stays residency-classifiable to the owning
        // store — the contract the completion route relies on to resolve the token.
        expect(ownerEngine(WaitpointId.fromFriendlyId(responseId))).toBe("NEW");
      } finally {
        await engine.quit();
      }
    }
  );

  // Test B: the token id classifies to the owning (new) run-ops store and resolves back.
  containerTest(
    "token id classifies to the owning run-ops store and resolves back",
    async ({ prisma, redisOptions }) => {
      setKsuidMintEnabled(true);

      const engine = buildEngine({ prisma, redisOptions });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() + 60_000),
        });

        // A ksuid token id classifies to the NEW (run-ops) store.
        expect(ownerEngine(result.waitpoint.id)).toBe("NEW");

        // getWaitpoint resolves via this.runStore.findWaitpoint and returns the exact row.
        const resolved = await engine.getWaitpoint({
          waitpointId: result.waitpoint.id,
          environmentId: env.id,
          projectId: env.project.id,
        });
        expect(resolved).not.toBeNull();
        expect(resolved?.id).toBe(result.waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Test C: the control-plane WaitpointTag write stays control-plane — it cannot
  // route through the run-ops store, which exposes no tag-write surface at all.
  containerTest(
    "control-plane WaitpointTag write stays control-plane, not on the run-ops store",
    async ({ prisma, redisOptions }) => {
      setKsuidMintEnabled(true);

      // A run-ops store that counts every waitpoint write that passes through it.
      // Overrides mirror the base PostgresRunStore generics so a base-signature
      // change can't silently detach the counter.
      let waitpointWrites = 0;
      class CountingPostgresRunStore extends PostgresRunStore {
        async upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
          args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
          tx?: Parameters<PostgresRunStore["upsertWaitpoint"]>[1]
        ): Promise<Prisma.WaitpointGetPayload<T>> {
          waitpointWrites++;
          return super.upsertWaitpoint(args, tx);
        }
        async createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
          args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
          tx?: Parameters<PostgresRunStore["createWaitpoint"]>[1]
        ): Promise<Prisma.WaitpointGetPayload<T>> {
          waitpointWrites++;
          return super.createWaitpoint(args, tx);
        }
      }

      const countingStore = new CountingPostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });

      const engine = buildEngine({ prisma, redisOptions, store: countingStore });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Issue the control-plane tag write directly (the same upsert the
        // createWaitpointTag model performs), against the container prisma —
        // control-plane, never the run-ops store.
        await prisma.waitpointTag.upsert({
          where: { environmentId_name: { environmentId: env.id, name: "t1" } },
          create: { name: "t1", environmentId: env.id, projectId: env.project.id },
          update: {},
        });

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          tags: ["t1"],
          timeout: new Date(Date.now() + 60_000),
        });
        expect(result.waitpoint.id.length).toBe(KSUID_LENGTH);

        // The tag landed on the control-plane client.
        const tagRow = await prisma.waitpointTag.findFirst({
          where: { environmentId: env.id, name: "t1" },
        });
        expect(tagRow).not.toBeNull();

        // The waitpoint went through the run-ops store (counting store fired).
        expect(waitpointWrites).toBeGreaterThanOrEqual(1);

        // The run-ops store has no tag-write surface, so the partition rests on the
        // two assertions above: the tag landed on control-plane and the waitpoint went through the store.
      } finally {
        await engine.quit();
      }
    }
  );

  // Test D: a minted KSUID waitpoint resolves only to its owning store across the
  // PG14↔PG17 version boundary. Store-only — no Redis/engine needed.
  heteroPostgresTest(
    "minted WaitpointId resolves only to its owning run-ops store across the version boundary",
    async ({ prisma14, prisma17 }) => {
      setKsuidMintEnabled(true);

      const store17 = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const store14 = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const env = await setupAuthenticatedEnvironment(prisma17, "PRODUCTION");

      const idempotencyKey = nanoid(24);
      const generated = WaitpointId.generate();

      const created = await store17.upsertWaitpoint({
        where: {
          environmentId_idempotencyKey: { environmentId: env.id, idempotencyKey },
        },
        create: {
          ...generated,
          type: "MANUAL",
          idempotencyKey,
          userProvidedIdempotencyKey: false,
          environmentId: env.id,
          projectId: env.project.id,
        },
        update: {},
      });

      const id = created.id;
      expect(id.length).toBe(KSUID_LENGTH);
      expect(ownerEngine(id)).toBe("NEW");

      // Byte-identical id resolves on the PG17 run-ops home.
      const found17 = await store17.findWaitpoint({ where: { id } }, prisma17);
      expect(found17).not.toBeNull();
      expect(found17?.id).toBe(id);

      // Residency invariant: the same id does NOT resolve on the PG14 legacy store.
      const found14 = await store14.findWaitpoint({ where: { id } }, prisma14);
      expect(found14).toBeNull();
    }
  );
});
