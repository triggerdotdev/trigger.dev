import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

// DELETE /api/v1/orgs/:orgParam against a real database, a real RunEngine and Redis, and the real
// service and RBAC fallback. The billing client is the one external seam (as in
// deleteOrganization.test.ts); the db and engine singletons are pointed at the containers.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  engine: undefined as unknown,
  getCurrentPlanOrThrow: async (_orgId: string): Promise<unknown> => undefined,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, $transaction: vi.fn(), sqlDatabaseSchema: undefined };
});
vi.mock("~/v3/runEngine.server", () => ({
  get engine() {
    return ctx.engine;
  },
}));
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-delete-org-route",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      RBAC_FORCE_FALLBACK: true,
    }),
  };
});
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, getCurrentPlanOrThrow: (orgId: string) => ctx.getCurrentPlanOrThrow(orgId) };
});
vi.mock("~/v3/commonWorker.server", () => ({ commonWorker: { enqueue: async () => undefined } }));
vi.mock("~/services/realtime/environmentSignals.server", () => ({
  deleteEnvironmentSignalStreams: async () => undefined,
}));

import { createRedisClient } from "@internal/redis";
import { RunEngine } from "@internal/run-engine";
import { postgresAndRedisTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { action } from "~/routes/api.v1.orgs.$orgParam";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";
import { seedTestPAT } from "./helpers/seedTestPAT";

async function seed(prisma: PrismaClient) {
  ctx.prisma = prisma;
  const seeded = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: seeded.project.id,
    organizationId: seeded.organization.id,
    type: "PRODUCTION",
  });
  const pat = await seedTestPAT(prisma, seeded.user.id);
  return { ...seeded, environment, token: pat.token };
}

async function deleteOrg(orgParam: string, token: string) {
  const response = await action({
    request: new Request(`https://api.trigger.dev/api/v1/orgs/${orgParam}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
    params: { orgParam },
    context: {},
  } as any);
  return { status: response.status, body: (await response.json()) as any };
}

async function isDeleted(prisma: PrismaClient, id: string) {
  const org = await prisma.organization.findFirstOrThrow({ where: { id } });
  return org.deletedAt !== null;
}

describe("DELETE /api/v1/orgs/:orgParam", () => {
  // Catches: everything answering 500, hiding the deliberate billing errors from the caller.
  postgresAndRedisTest(
    "answers 400 with the message when billing cannot be verified",
    async ({ prisma }) => {
      const { organization, token } = await seed(prisma);
      ctx.getCurrentPlanOrThrow = async () => {
        throw new Error("billing down");
      };

      expect(await deleteOrg(organization.slug, token)).toEqual({
        status: 400,
        body: { error: "Couldn't verify billing state, try again" },
      });
      expect(await isDeleted(prisma, organization.id)).toBe(false);
    }
  );

  // Catches: the blanket 400, and leaking the raw error, for a failure the service did not raise.
  postgresAndRedisTest(
    "answers 500 and keeps the org when removing its queues fails",
    async ({ prisma, redisOptions }) => {
      const { organization, project, environment, token } = await seed(prisma);
      ctx.getCurrentPlanOrThrow = async () => undefined;

      const admin = createRedisClient(redisOptions);
      await admin.acl("SETUSER", "nozrem", "on", ">secret", "~*", "&*", "+@all", "-zrem");
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: { ...redisOptions, keyPrefix: "t:", username: "nozrem", password: "secret" },
          masterQueueConsumersDisabled: true,
        },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      ctx.engine = engine;

      try {
        const { keys } = engine.runQueue;
        await admin.zadd(
          `t:runqueue:${keys.masterQueueKeyForEnvironment(environment.id, 2)}`,
          0,
          keys.queueKey(organization.id, project.id, environment.id, "queue1")
        );

        await admin.acl("LOG", "RESET");
        expect(await deleteOrg(organization.slug, token)).toEqual({
          status: 500,
          body: { error: "Internal Server Error" },
        });
        expect(await isDeleted(prisma, organization.id)).toBe(false);

        // The request reached the denied removal, not an earlier failure.
        const denied = ((await admin.acl("LOG")) as unknown[][]).map((entry) => entry.join(" "));
        expect(denied.some((e) => e.includes("object zrem") && e.includes("username nozrem"))).toBe(
          true
        );
      } finally {
        await engine.quit();
        await admin.quit();
      }
    }
  );
});
