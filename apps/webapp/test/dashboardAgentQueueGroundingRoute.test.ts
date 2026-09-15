import type { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { buildGroundingTestEngine } from "./helpers/dashboardAgentQueueGroundingTestHelpers";

// Real route, real Postgres and Redis behind it; only the module seams hand it the containers.

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  engine: undefined as unknown as RunEngine,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/v3/runEngine.server", () => ({
  get engine() {
    return ctx.engine;
  },
}));

process.env.SESSION_SECRET = "test-session-secret-for-queue-grounding-route";

const { loader } = await import("~/routes/api.v1.dashboard-agent.queues.$queueParam.grounding");

vi.setConfig({ testTimeout: 60_000 });

describe("queue grounding route", () => {
  postgresAndRedisTest(
    "answers the gate counts for the named queue",
    async ({ prisma, redisOptions }) => {
      ctx.prisma = prisma;
      const engine = buildGroundingTestEngine(prisma, redisOptions);
      ctx.engine = engine;

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION", "V2");
        await prisma.taskQueue.create({
          data: {
            friendlyId: "queue_task_my_task",
            name: "task/my-task",
            orderableName: "task/my-task",
            type: "VIRTUAL",
            projectId: environment.project.id,
            runtimeEnvironmentId: environment.id,
          },
        });
        await engine.runQueue.updateEnvConcurrencyLimits(environment);

        const response = (await (loader as any)({
          request: new Request(
            "https://api.trigger.dev/api/v1/dashboard-agent/queues/my-task/grounding?type=task",
            { headers: { Authorization: `Bearer ${environment.apiKey}` } }
          ),
          params: { queueParam: "my-task" },
          context: {},
        })) as Response;

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          queue: {
            queued: 0,
            admitted: 0,
            keyed: false,
            paused: false,
            displayed: 0,
            limit: null,
            enforcedLimit: 10,
          },
          env: { admitted: 0, limit: 10, effectiveLimit: 20, displayed: 0 },
          holders: { availability: "unavailable" },
        });

        const missing = (await (loader as any)({
          request: new Request(
            "https://api.trigger.dev/api/v1/dashboard-agent/queues/nope/grounding",
            { headers: { Authorization: `Bearer ${environment.apiKey}` } }
          ),
          params: { queueParam: "nope" },
          context: {},
        })) as Response;

        expect(missing.status).toBe(200);
        expect(await missing.json()).toEqual({
          status: "unresolved",
          reason: "queue_not_found",
        });
      } finally {
        await engine.quit().catch(() => {});
      }
    }
  );
});
