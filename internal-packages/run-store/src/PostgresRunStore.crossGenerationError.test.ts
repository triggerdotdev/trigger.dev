// Cross-generation Prisma error normalization LOCK.
//
// The store can be backed by the run-ops `@internal/run-ops-database` client, a SEPARATELY
// generated Prisma client with its OWN `PrismaClientKnownRequestError` class object (distinct
// module identity from `@trigger.dev/database`'s, even at the same version). A P2002 raised by
// the run-ops client is therefore NOT `instanceof` the control-plane
// `Prisma.PrismaClientKnownRequestError` — so the webapp's uniform P2002→422 conversion
// (`error instanceof Prisma.PrismaClientKnownRequestError`) is skipped and a raw 500 escapes.
//
// PostgresRunStore normalizes at its write boundary: a routed NEW-client P2002 surfaces such
// that a control-plane `instanceof` catch (the 422 path) sees it. This test drives a REAL
// duplicate-key on the REAL run-ops-generation client (prisma17) through the store and asserts
// the surfaced error is recognized by the control-plane class — the exact predicate every
// routed-write caller uses. Fails before the normalization (raw foreign error ⇒ instanceof false).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { Prisma } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateBatchTaskRunData } from "./types.js";

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function batchData(overrides: Partial<CreateBatchTaskRunData> = {}): CreateBatchTaskRunData {
  return {
    id: `batch_${"x".repeat(24)}`,
    friendlyId: "batch_dup_friendly",
    runtimeEnvironmentId: "env_cgerr",
    status: "PENDING",
    runCount: 1,
    expectedCount: 1,
    batchVersion: "runengine:v2",
    sealed: false,
    ...overrides,
  };
}

describe("PostgresRunStore — cross-generation Prisma error normalization", () => {
  heteroRunOpsPostgresTest(
    "a routed NEW-client P2002 surfaces as a control-plane instanceof Prisma.PrismaClientKnownRequestError",
    async ({ prisma17 }) => {
      const store = makeDedicatedStore(prisma17);

      // First create succeeds; second collides on the unique friendlyId → NEW-generation P2002.
      await store.createBatchTaskRun(batchData({ id: `batch_${"a".repeat(24)}` }));

      let caught: unknown;
      try {
        await store.createBatchTaskRun(batchData({ id: `batch_${"b".repeat(24)}` }));
      } catch (error) {
        caught = error;
      }

      // The control-plane `instanceof` catch (the P2002→422 path the webapp uses) must see it.
      expect(caught instanceof Prisma.PrismaClientKnownRequestError).toBe(true);
      const known = caught as Prisma.PrismaClientKnownRequestError;
      expect(known.code).toBe("P2002");
      // code/message/meta are preserved through the normalization.
      expect(typeof known.message).toBe("string");
      expect(known.message.length).toBeGreaterThan(0);
      expect(known.clientVersion).toBeTruthy();
    }
  );

  heteroRunOpsPostgresTest(
    "a NEW-client P2002 inside runInTransaction is also normalized to the control-plane class",
    async ({ prisma17 }) => {
      const store = makeDedicatedStore(prisma17);

      await store.createBatchTaskRun(batchData({ id: `batch_${"c".repeat(24)}` }));

      let caught: unknown;
      try {
        await store.runInTransaction(undefined, async (txStore) => {
          await txStore.createBatchTaskRun(batchData({ id: `batch_${"d".repeat(24)}` }));
        });
      } catch (error) {
        caught = error;
      }

      expect(caught instanceof Prisma.PrismaClientKnownRequestError).toBe(true);
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    }
  );

  heteroRunOpsPostgresTest(
    "a successful NEW-client write is untouched by the normalization wrapper",
    async ({ prisma17 }) => {
      const store = makeDedicatedStore(prisma17);

      const created = await store.createBatchTaskRun(batchData({ id: `batch_${"e".repeat(24)}` }));

      expect(created.id).toBe(`batch_${"e".repeat(24)}`);
      expect(created.friendlyId).toBe("batch_dup_friendly");
    }
  );
});
