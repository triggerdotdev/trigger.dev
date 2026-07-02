// Real PG14 (legacy) + PG17 (new) proof for the dev-session-cancel TaskRun read.
// The DB is never mocked: reads hit the two real containers. Only the pure
// splitEnabled boundary and recording client wrappers are injected.
import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { CancelDevSessionRunsService } from "~/v3/services/cancelDevSessionRuns.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char cuid body (length-disjoint from the 27-char KSUID) → LEGACY residency.
function generateLegacyCuid() {
  const suffix = Array.from(
    { length: 24 },
    () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]
  ).join("");
  return `c${suffix}`;
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
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

async function seedRun(
  prisma: PrismaClient,
  ids: { id: string; friendlyId: string },
  env: { runtimeEnvironmentId: string; projectId: string; organizationId: string }
) {
  return prisma.taskRun.create({
    data: {
      id: ids.id,
      friendlyId: ids.friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ foo: "bar" }),
      payloadType: "application/json",
      traceId: "1234",
      spanId: "1234",
      queue: "test",
      runtimeEnvironmentId: env.runtimeEnvironmentId,
      projectId: env.projectId,
      organizationId: env.organizationId,
      environmentType: "DEVELOPMENT",
      // V1 so the (best-effort, error-swallowed) cancel does not require the V2 engine;
      // the unit under test is the READ resolution, not the cancel side effect.
      engine: "V1",
      status: "EXECUTING",
    },
  });
}

// A read client whose taskRun.findFirst is recorded; throws if used after being marked
// forbidden, so we can prove a store was NEVER read.
function recording(client: PrismaClient, opts: { forbidden?: boolean } = {}) {
  const calls: unknown[] = [];
  const taskRun = {
    findFirst: (args: unknown) => {
      calls.push(args);
      if (opts.forbidden) {
        throw new Error("this store must never be read");
      }
      return (client as unknown as PrismaReplicaClient).taskRun.findFirst(args as never);
    },
  };
  return { handle: { ...client, taskRun } as unknown as PrismaReplicaClient, calls };
}

describe("CancelDevSessionRunsService store routing (hetero)", () => {
  heteroPostgresTest(
    "a NEW run (ksuid) resolves on the new store via read-through, by friendlyId and by id",
    async ({ prisma17, prisma14 }) => {
      const id = generateKsuidId();
      expect(id.length).toBe(27);
      const friendlyId = `run_${id}`;

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "new"
      );
      await seedRun(
        prisma17,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      // by friendlyId
      {
        const newClient = recording(prisma17);
        const legacy = recording(prisma14, { forbidden: true });
        const service = new CancelDevSessionRunsService({
          prisma: prisma17,
          readThroughDeps: {
            splitEnabled: true,
            newClient: newClient.handle,
            legacyReplica: legacy.handle,
          },
        });
        await service.call({
          runIds: [friendlyId],
          cancelledAt: new Date(),
          reason: "test",
        });
        // ksuid → NEW: new store served the read, legacy never touched.
        expect(newClient.calls.length).toBe(1);
        expect(legacy.calls.length).toBe(0);
      }

      // by internal id
      {
        const newClient = recording(prisma17);
        const legacy = recording(prisma14, { forbidden: true });
        const service = new CancelDevSessionRunsService({
          prisma: prisma17,
          readThroughDeps: {
            splitEnabled: true,
            newClient: newClient.handle,
            legacyReplica: legacy.handle,
          },
        });
        await service.call({
          runIds: [id],
          cancelledAt: new Date(),
          reason: "test",
        });
        expect(newClient.calls.length).toBe(1);
        expect(legacy.calls.length).toBe(0);
      }
    }
  );

  heteroPostgresTest(
    "an OLD in-retention run (cuid) resolves off the LEGACY replica, never a legacy primary",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      expect(id.length).toBe(25);
      const friendlyId = `run_${id}`;

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "legacy"
      );
      await seedRun(
        prisma14,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      const newClient = recording(prisma17);
      const legacy = recording(prisma14);
      const service = new CancelDevSessionRunsService({
        prisma: prisma14,
        readThroughDeps: {
          splitEnabled: true,
          newClient: newClient.handle,
          legacyReplica: legacy.handle,
        },
      });

      await service.call({
        runIds: [id],
        cancelledAt: new Date(),
        reason: "test",
      });

      // NEW first (miss) → resolved off the LEGACY REPLICA handle (no primary handle exists).
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(1);
    }
  );
});

describe("CancelDevSessionRunsService passthrough (single-DB)", () => {
  postgresTest(
    "with no read-through deps, the run is read from the single DB and session reads stay on it",
    async ({ prisma }) => {
      const id = generateKsuidId();
      const friendlyId = `run_${id}`;

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(prisma, "pt");
      await seedRun(
        prisma,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      const session = await prisma.runtimeEnvironmentSession.create({
        data: { environmentId: runtimeEnvironment.id, ipAddress: "127.0.0.1" },
      });

      // splitEnabled=false → single plain read against the one client; the session
      // control-plane read runs on the same prisma.
      const service = new CancelDevSessionRunsService({
        prisma,
        replica: prisma,
        readThroughDeps: {
          splitEnabled: false,
          newClient: prisma as unknown as PrismaReplicaClient,
        },
      });

      await service.call({
        runIds: [id],
        cancelledAt: new Date(),
        reason: "test",
        cancelledSessionId: session.id,
      });

      // Run found + handed to cancel against the single DB; confirm the row is present.
      const row = await prisma.taskRun.findFirst({ where: { id } });
      expect(row).not.toBeNull();
      expect(row?.friendlyId).toBe(friendlyId);
    }
  );
});
