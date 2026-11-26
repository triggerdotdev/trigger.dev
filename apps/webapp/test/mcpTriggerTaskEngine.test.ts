import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import plugin from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { describe, expect, onTestFinished, vi } from "vitest";
import { uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    SESSION_SECRET: "test-user-actor-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          mocks.rbac[prop](...args),
    }
  ),
}));

import type { McpIdentity } from "~/mcp/types";
import { createTasksWriteTools } from "~/mcp/tools/tasksWrite.server";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "~/runEngine/services/triggerTask.server";
import { resetConfirmations } from "./helpers/mcpConfirm";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./engine/triggerTaskTestHelpers";

describe("trigger_task through the run engine", () => {
  // Catches: an option dropped or renamed between the tool and the trigger service, or a ttl the caller did not pass replacing the task's own.
  containerTest(
    "stores the run with the options it was triggered with and the task's ttl unless one is passed",
    async ({ prisma, redisOptions }) => {
      mocks.db = prisma as unknown as Record<string | symbol, unknown>;
      mocks.rbac = plugin.create(
        { primary: prisma, replica: prisma },
        { forceFallback: true }
      ) as any;
      resetConfirmations({ autoApprove: true });

      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
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
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "test-task");
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { slug: "prod" },
      });
      await prisma.backgroundWorkerTask.updateMany({
        where: { runtimeEnvironmentId: environment.id, slug: "test-task" },
        data: { ttl: "1h" },
      });
      const service = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const user = await prisma.user.create({
        data: { email: `${uniqueId("user")}@test.com`, authenticationMethod: "MAGIC_LINK" },
      });
      await prisma.orgMember.create({
        data: { userId: user.id, organizationId: environment.organizationId, role: "ADMIN" },
      });
      const pat = `tr_pat_${uniqueId("tok")}`;
      const token = await prisma.personalAccessToken.create({
        data: {
          name: "mcp",
          encryptedToken: {},
          obfuscatedToken: "tr_pat_****",
          hashedToken: createHash("sha256").update(pat).digest("hex"),
          userId: user.id,
        },
      });
      const identity: McpIdentity = { kind: "pat", userId: user.id, tokenId: token.id };
      const request = new Request("https://api.trigger.dev/mcp", {
        headers: { Authorization: `Bearer ${pat}` },
      });

      const trigger = createTasksWriteTools({
        triggerTask: async (taskId, env, body, triggerSource) => {
          const result = await service.call({
            taskId,
            environment: env,
            body,
            options: { triggerSource },
          });
          return result ? { id: result.run.friendlyId } : undefined;
        },
        isDevConnected: async () => true,
      }).find((t) => t.name === "trigger_task")!.handler;

      const stored = async (options: Record<string, unknown>) => {
        const result = await trigger(
          {
            projectRef: environment.project.externalRef,
            environment: "prod",
            taskId: "test-task",
            payload: {},
            options,
          },
          identity,
          request
        );
        const runId = result.content[0]!.text!.match(/ID created: (run_\w+)/)![1];
        return prisma.taskRun.findFirstOrThrow({ where: { friendlyId: runId } });
      };

      const run = await stored({
        metadata: { user: { id: 7 } },
        priority: 30,
        concurrencyKey: "user-7",
      });
      expect(JSON.parse(run.metadata!)).toEqual({ user: { id: 7 } });
      expect(run.priorityMs).toBe(30_000);
      expect(run.concurrencyKey).toBe("user-7");
      expect({ declared: run.ttl, passed: (await stored({ ttl: "5m" })).ttl }).toEqual({
        declared: "1h",
        passed: "5m",
      });
    }
  );
});
