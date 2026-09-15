// #maybeInfraRetry must charge a blip-retry to the correct budget: replica reads to the replica
// budget (so a replica retry storm can't drain the writer's), writer ops to the writer budget, and a
// caller-transaction client is never retried. Selection is by the stored read-only object OR the
// replica brand, so a routing-layer-forwarded replica wrapper (a fresh object, not the stored one)
// still bills the replica budget. Deterministic one-shot fault injection, real testcontainer DB.
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";
import { withOneShotBlip } from "./testFixtures/oneShotBlip.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

const options = { enabled: true, maxAttempts: 12, backoffMinMs: 20, backoffMaxMs: 120 };

async function seedWaitpoint(prisma: PrismaClient, env: { id: string; projectId: string }) {
  const id = generateInternalId();
  await prisma.waitpoint.create({
    data: {
      id,
      friendlyId: `wp_${id}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${id}`,
      userProvidedIdempotencyKey: false,
      projectId: env.projectId,
      environmentId: env.id,
    },
  });
  return id;
}

postgresTest(
  "a branded replica wrapper (not the stored one) charges its retry to the replica budget",
  async ({ prisma }) => {
    const { env } = await setupSnapshotIdFixture(prisma);
    const wpId = await seedWaitpoint(prisma as PrismaClient, env);

    let writer = 0;
    let replica = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: { options, onRetry: () => writer++ },
      readInfraRetry: { options, onRetry: () => replica++ },
    });

    // A freshly wrapped, branded replica handle: a different object than the stored readOnlyPrisma, so
    // the old identity-only check would have billed the writer. The brand routes it to the replica.
    const branded = markReadReplicaClient(withOneShotBlip(prisma, "waitpoint", "findFirst"));
    const wp = await store.findWaitpoint({ where: { id: wpId } }, branded as never);

    expect(wp?.id).toBe(wpId);
    expect(replica).toBe(1);
    expect(writer).toBe(0);
  }
);

postgresTest(
  "an op through the stored writer charges its retry to the writer budget",
  async ({ prisma }) => {
    const { env } = await setupSnapshotIdFixture(prisma);
    const wpId = await seedWaitpoint(prisma as PrismaClient, env);

    let writer = 0;
    let replica = 0;
    const faultingWriter = withOneShotBlip(prisma, "waitpoint", "updateMany");
    const store = new PostgresRunStore({
      prisma: faultingWriter as never,
      readOnlyPrisma: prisma as never, // distinct stored replica so identity selection is meaningful
      infraRetry: { options, onRetry: () => writer++ },
      readInfraRetry: { options, onRetry: () => replica++ },
    });

    // markWaitpointCompleted is the retried writer op (updateManyWaitpoints is not retried); it runs
    // waitpoint.updateMany on the writer, which the one-shot blip faults once, charging the writer budget.
    await store.markWaitpointCompleted(wpId, {
      output: { value: "{}", type: "application/json", isError: false },
    });

    expect(writer).toBe(1);
    expect(replica).toBe(0);
  }
);

postgresTest(
  "a read through the stored replica charges its retry to the replica budget",
  async ({ prisma }) => {
    const { env } = await setupSnapshotIdFixture(prisma);
    const wpId = await seedWaitpoint(prisma as PrismaClient, env);

    let writer = 0;
    let replica = 0;
    const faultingReplica = withOneShotBlip(prisma, "waitpoint", "findFirst");
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: faultingReplica as never,
      infraRetry: { options, onRetry: () => writer++ },
      readInfraRetry: { options, onRetry: () => replica++ },
    });

    const wp = await store.findWaitpoint({ where: { id: wpId } }); // no client -> stored readOnlyPrisma

    expect(wp?.id).toBe(wpId);
    expect(replica).toBe(1);
    expect(writer).toBe(0);
  }
);

postgresTest(
  "a caller-transaction client is never retried (boundary preserved for both budgets)",
  async ({ prisma }) => {
    const { env } = await setupSnapshotIdFixture(prisma);
    const wpId = await seedWaitpoint(prisma as PrismaClient, env);

    let writer = 0;
    let replica = 0;
    const faulting = withOneShotBlip(prisma, "waitpoint", "findFirst");
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: { options, onRetry: () => writer++ },
      readInfraRetry: { options, onRetry: () => replica++ },
    });

    // A tx client has no `$transaction`, so the op runs exactly once: the blip surfaces and neither
    // budget's onRetry fires.
    await expect(
      (faulting as any).$transaction((tx: any) => store.findWaitpoint({ where: { id: wpId } }, tx))
    ).rejects.toThrow();

    expect(writer).toBe(0);
    expect(replica).toBe(0);
  }
);
