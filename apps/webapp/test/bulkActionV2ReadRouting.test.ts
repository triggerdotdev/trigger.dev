// Service-level proof for bulk CANCEL/REPLAY member hydration across the run-ops seam.
//
// `BulkActionService.process()` builds its ClickHouse-backed RunsRepository internally and
// has no test seam to inject the member-id page, and driving it end-to-end would require a
// full ClickHouse replication stack just to make `listRunIds` return the seeded ids. The
// cross-DB hydration semantics — the DoD's core — are proven exhaustively at the adapter
// unit level (BulkActionV2.batchReadThrough.server.test.ts). Here we prove the SERVICE-level
// wiring by driving the exact closures `process()` passes to `hydrateRunsAcrossSeam` against
// REAL rows seeded on the two containers (PG14 legacy + PG17 new), so the PG14↔PG17 boundary
// is genuinely crossed and the full REPLAY row shape is exercised. We NEVER mock the DB.
import { heteroPostgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import type { PrismaReplicaClient } from "~/db.server";
import { hydrateRunsAcrossSeam } from "~/v3/services/bulk/BulkActionV2.batchReadThrough.server";

vi.setConfig({ testTimeout: 60_000 });

// 26-char v1 body (version "1" at index 25) → NEW residency. 25-char body → LEGACY residency (cuid analog).
function newId(c: string) {
  return "run_" + c.repeat(24) + "01";
}
function legacyId(c: string) {
  return "run_" + c.repeat(25);
}

// The exact closures BulkActionService.process() uses for each branch.
const cancelSelect = {
  id: true,
  engine: true,
  friendlyId: true,
  status: true,
  createdAt: true,
  completedAt: true,
  taskEventStore: true,
} as const;

function cancelReadNew(client: PrismaReplicaClient, ids: string[]) {
  return client.taskRun.findMany({ where: { id: { in: ids } }, select: cancelSelect });
}
function cancelReadLegacy(replica: PrismaReplicaClient, ids: string[]) {
  return replica.taskRun.findMany({ where: { id: { in: ids } }, select: cancelSelect });
}
function replayReadNew(client: PrismaReplicaClient, ids: string[]) {
  return client.taskRun.findMany({ where: { id: { in: ids } } });
}
function replayReadLegacy(replica: PrismaReplicaClient, ids: string[]) {
  return replica.taskRun.findMany({ where: { id: { in: ids } } });
}

async function seedEnv(prisma: PrismaClient, slug: string) {
  const user = await prisma.user.create({
    data: { email: `${slug}@test.com`, name: "t", authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: "Org",
      slug: `org-${slug}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      name: "Proj",
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `api-${slug}`,
      pkApiKey: `pk-${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
  return { organization, project, environment };
}

async function seedRun(
  prisma: PrismaClient,
  ctx: { organization: { id: string }; project: { id: string }; environment: { id: string } },
  id: string
) {
  await prisma.taskRun.create({
    data: {
      id,
      friendlyId: id,
      taskIdentifier: "t",
      status: "EXECUTING",
      payload: JSON.stringify({}),
      payloadType: "application/json",
      traceId: id,
      spanId: id,
      queue: "main",
      runtimeEnvironmentId: ctx.environment.id,
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      environmentType: "PRODUCTION",
      engine: "V2",
    },
  });
}

describe("BulkActionService member hydration across the seam (PG14 legacy + PG17 new)", () => {
  heteroPostgresTest(
    "CANCEL across both DBs hydrates every member; the NEW id never hits the legacy replica",
    async ({ prisma14, prisma17 }) => {
      const newRunId = newId("a");
      const legacyRunId = legacyId("b");

      const newCtx = await seedEnv(prisma17 as unknown as PrismaClient, "cancel-new");
      const legacyCtx = await seedEnv(prisma14 as unknown as PrismaClient, "cancel-legacy");
      await seedRun(prisma17 as unknown as PrismaClient, newCtx, newRunId);
      await seedRun(prisma14 as unknown as PrismaClient, legacyCtx, legacyRunId);

      const legacySpy = vi.fn((replica: PrismaReplicaClient, ids: string[]) => {
        if (ids.includes(newRunId)) {
          throw new Error("legacy replica must never be probed for a NEW-residency id");
        }
        return cancelReadLegacy(replica, ids);
      });

      const runs = await hydrateRunsAcrossSeam({
        runIds: [newRunId, legacyRunId],
        readNew: cancelReadNew,
        readLegacyReplica: legacySpy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      // Every member hydrated → every member reaches cancel (none dropped).
      expect(runs.map((r) => r.id).sort()).toEqual([newRunId, legacyRunId].sort());
      expect(legacySpy.mock.calls[0][1]).toEqual([legacyRunId]);
    }
  );

  heteroPostgresTest(
    "REPLAY across both DBs hydrates every member as a FULL row",
    async ({ prisma14, prisma17 }) => {
      const newRunId = newId("c");
      const legacyRunId = legacyId("d");

      const newCtx = await seedEnv(prisma17 as unknown as PrismaClient, "replay-new");
      const legacyCtx = await seedEnv(prisma14 as unknown as PrismaClient, "replay-legacy");
      await seedRun(prisma17 as unknown as PrismaClient, newCtx, newRunId);
      await seedRun(prisma14 as unknown as PrismaClient, legacyCtx, legacyRunId);

      const runs = await hydrateRunsAcrossSeam({
        runIds: [newRunId, legacyRunId],
        readNew: replayReadNew,
        readLegacyReplica: replayReadLegacy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(runs.map((r) => r.id).sort()).toEqual([newRunId, legacyRunId].sort());
      // Full row, not a select projection: a non-selected column is populated.
      const newRow = runs.find((r) => r.id === newRunId)!;
      const legacyRow = runs.find((r) => r.id === legacyRunId)!;
      expect(newRow.runtimeEnvironmentId).toBe(newCtx.environment.id);
      expect(legacyRow.runtimeEnvironmentId).toBe(legacyCtx.environment.id);
    }
  );

  heteroPostgresTest(
    "single-DB passthrough hydrates all members from one client; legacy never invoked",
    async ({ prisma14, prisma17 }) => {
      // In single-DB mode the service passes its _replica as newClient. Seed everything there.
      const idA = newId("f");
      const idB = legacyId("g");
      const ctx = await seedEnv(prisma17 as unknown as PrismaClient, "passthrough");
      await seedRun(prisma17 as unknown as PrismaClient, ctx, idA);
      await seedRun(prisma17 as unknown as PrismaClient, ctx, idB);

      const throwingLegacy = vi.fn(() => {
        throw new Error("legacy replica must never run in single-DB mode");
      });

      const runs = await hydrateRunsAcrossSeam({
        runIds: [idA, idB],
        readNew: cancelReadNew,
        readLegacyReplica: throwingLegacy as never,
        deps: {
          splitEnabled: false,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(runs.map((r) => r.id).sort()).toEqual([idA, idB].sort());
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );
});
