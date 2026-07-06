import { heteroRunOpsPostgresTest, postgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { resolveWaitpointThroughReadThrough } from "~/runEngine/concerns/resolveWaitpointThroughReadThrough.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char cuid (no v1 version marker) -> LEGACY residency.
function generateLegacyCuid() {
  const suffix = Array.from(
    { length: 24 },
    () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]
  ).join("");
  return `c${suffix}`;
}

function recording(client: PrismaClient | RunOpsPrismaClient, opts: { forbidden?: boolean } = {}) {
  const calls: unknown[] = [];
  const waitpoint = {
    findFirst: (args: unknown) => {
      calls.push(args);
      if (opts.forbidden) {
        throw new Error("this store must never be read");
      }
      return (client as unknown as PrismaReplicaClient).waitpoint.findFirst(args as never);
    },
  };
  return { handle: { ...client, waitpoint } as unknown as PrismaReplicaClient, calls };
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `apikey-${suffix}`,
      pkApiKey: `pk-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, environment };
}

async function seedWaitpoint(
  prisma: PrismaClient | RunOpsPrismaClient,
  id: string,
  env: { id: string; projectId: string }
) {
  return prisma.waitpoint.create({
    data: {
      id,
      friendlyId: `waitpoint_${id}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem-${id}`,
      userProvidedIdempotencyKey: false,
      projectId: env.projectId,
      environmentId: env.id,
    },
  });
}

const read = (waitpointId: string, environmentId: string) => (client: PrismaReplicaClient) =>
  client.waitpoint.findFirst({
    where: { id: waitpointId, environmentId },
    select: { id: true, status: true, projectId: true, environmentId: true },
  });

describe("resolveWaitpointThroughReadThrough (hetero PG14 legacy + dedicated run-ops PG17)", () => {
  heteroRunOpsPostgresTest(
    "run-ops waitpoint resolves on the dedicated run-ops client; legacy replica never touched",
    async ({ prisma17, prisma14 }) => {
      const id = generateRunOpsId();
      expect(id.length).toBe(26);

      // The dedicated run-ops DB has no control-plane tables; the waitpoint's
      // environment/project FKs are synthetic scalar ids.
      const environmentId = generateRunOpsId();
      const projectId = generateRunOpsId();
      const seeded = await seedWaitpoint(prisma17, id, { id: environmentId, projectId });

      const newClient = recording(prisma17);
      const legacy = recording(prisma14, { forbidden: true });

      const result = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId,
        read: read(id, environmentId),
        deps: {
          splitEnabled: true,
          newClient: newClient.handle,
          legacyReplica: legacy.handle,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(seeded.id);
      expect(result!.projectId).toBe(projectId);
      expect(result!.environmentId).toBe(environmentId);
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "cuid waitpoint resolves off the LEGACY replica (new probed first, miss)",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      expect(id.length).toBe(25);

      const { project, environment } = await seedOrgProjectEnv(prisma14, "legacy");
      const seeded = await seedWaitpoint(prisma14, id, {
        id: environment.id,
        projectId: project.id,
      });

      const newClient = recording(prisma17);
      const legacy = recording(prisma14);

      const result = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId: environment.id,
        read: read(id, environment.id),
        deps: {
          splitEnabled: true,
          newClient: newClient.handle,
          legacyReplica: legacy.handle,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(seeded.id);
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(1);
    }
  );

  // Read-your-writes: a token completed immediately after mint may not be on the replicas yet. The
  // replica-only read-through misses, and without a primary fallback we 404 a valid token (the
  // authoritative completeWaitpoint never runs). The primary fallback must find it.
  heteroRunOpsPostgresTest(
    "a NEW-resident token missing on both replicas is found on the run-ops primary (no spurious 404)",
    async ({ prisma17, prisma14 }) => {
      // A NEW-resident token lives on the run-ops DB (prisma17); its cuid id fans new-then-legacy.
      // Both replicas here lack it (pointed at prisma14), so only the run-ops primary can serve it.
      const id = generateLegacyCuid();
      const environmentId = generateRunOpsId();
      const projectId = generateRunOpsId();
      const seeded = await seedWaitpoint(prisma17, id, { id: environmentId, projectId });

      const newClient = recording(prisma14);
      const legacyReplica = recording(prisma14);
      const newPrimary = recording(prisma17);

      const result = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId,
        read: read(id, environmentId),
        deps: {
          splitEnabled: true,
          newClient: newClient.handle,
          legacyReplica: legacyReplica.handle,
          newPrimary: newPrimary.handle,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(seeded.id);
      // Both replicas probed and missed; the fallback read the run-ops primary (never control-plane).
      expect(newClient.calls.length).toBe(1);
      expect(legacyReplica.calls.length).toBe(1);
      expect(newPrimary.calls.length).toBe(1);
    }
  );

  heteroRunOpsPostgresTest(
    "bare caller (no deps) resolves a NEW-resident waitpoint via the safe run-ops defaults",
    async ({ prisma17, prisma14 }) => {
      // The bare wait route passes NO `deps`; the `defaults` DI seam models old vs new
      // fallback against containers, avoiding the real db.server topology.
      const id = generateRunOpsId();
      expect(id.length).toBe(26);
      const environmentId = generateRunOpsId();
      const projectId = generateRunOpsId();
      const seeded = await seedWaitpoint(prisma17, id, { id: environmentId, projectId });

      // FAIL-BEFORE: old default pinned newClient to control-plane ($replica ≈ prisma14) → miss.
      const oldDefaultResult = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId,
        read: read(id, environmentId),
        defaults: {
          newClient: prisma14 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          // Primaries also miss the NEW-resident waitpoint, so the miss stays a miss.
          newPrimary: prisma14 as unknown as PrismaReplicaClient,
          splitEnabled: true,
        },
      });
      expect(oldDefaultResult).toBeNull();

      // PASS-AFTER: safe default routes newClient to the run-ops replica (runOpsNewReplica ≈ prisma17).
      const safeDefaultResult = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId,
        read: read(id, environmentId),
        defaults: {
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          newPrimary: prisma17 as unknown as PrismaReplicaClient,
          splitEnabled: true,
        },
      });

      expect(safeDefaultResult).not.toBeNull();
      expect(safeDefaultResult!.id).toBe(seeded.id);
      expect(safeDefaultResult!.projectId).toBe(projectId);
      expect(safeDefaultResult!.environmentId).toBe(environmentId);
    }
  );

  heteroRunOpsPostgresTest("not-found maps to null (no throw)", async ({ prisma17, prisma14 }) => {
    const id = generateLegacyCuid();
    const { environment } = await seedOrgProjectEnv(prisma14, "nf");

    const result = await resolveWaitpointThroughReadThrough({
      waitpointId: id,
      environmentId: environment.id,
      read: read(id, environment.id),
      deps: {
        splitEnabled: true,
        newClient: recording(prisma17).handle,
        legacyReplica: recording(prisma14).handle,
        // The run-ops-primary fallback also misses this never-seeded token; inject a container client
        // so it does not reach for the unconnectable production singleton.
        newPrimary: recording(prisma17).handle,
      },
    });

    expect(result).toBeNull();
  });

  postgresTest(
    "passthrough (single-DB): one plain read; legacy never invoked",
    async ({ prisma }) => {
      const id = generateRunOpsId();
      const { project, environment } = await seedOrgProjectEnv(prisma, "pt");
      const seeded = await seedWaitpoint(prisma, id, {
        id: environment.id,
        projectId: project.id,
      });

      const single = recording(prisma);
      const legacy = recording(prisma, { forbidden: true });

      const result = await resolveWaitpointThroughReadThrough({
        waitpointId: id,
        environmentId: environment.id,
        read: read(id, environment.id),
        deps: {
          splitEnabled: false,
          newClient: single.handle,
          legacyReplica: legacy.handle,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(seeded.id);
      expect(single.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(0);
    }
  );
});
