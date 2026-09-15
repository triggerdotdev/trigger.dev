import { PostgresRunStore } from "@internal/run-store";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { beforeEach, describe, expect, vi } from "vitest";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const H = vi.hoisted(() => ({
  handlers: [] as Array<{ config: any; handler: any }>,
  store: undefined as any,
  prisma: undefined as any,
  engineCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/db.server", () => {
  const prisma = new Proxy(
    {},
    {
      get(_target, property) {
        const value = H.prisma[property];
        return typeof value === "object" && value !== null
          ? new Proxy(value, { get: (_delegate, method) => H.prisma[property][method] })
          : value;
      },
    }
  );

  return {
    prisma,
    $replica: prisma,
    runOpsLegacyReplica: prisma,
    runOpsNewPrisma: prisma,
    runOpsNewReplica: prisma,
    runOpsSplitReadEnabled: false,
  };
});

vi.mock("~/env.server", () => ({
  env: {
    RUN_OPS_SPLIT_ENABLED: false,
    RUN_OPS_SHARDS: [],
  },
}));

vi.mock("~/v3/runOpsMigration/shardHandles.server", () => ({
  runOpsShardReplicas: new Map(),
  runOpsShardWriters: new Map(),
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_target, property) {
        const value = H.store[property];
        return typeof value === "function" ? value.bind(H.store) : value;
      },
    }
  ),
}));

vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: (config: any, handler: any) => {
    H.handlers.push({ config, handler });
    return { action: vi.fn() };
  },
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    blockRunWithWaitpoint: vi.fn(async (args: Record<string, unknown>) => {
      H.engineCalls.push(args);
      return {};
    }),
  },
}));

vi.mock("~/services/logger.server", () => ({
  logger: { error: vi.fn() },
}));

async function routeHandler() {
  await import("~/routes/engine.v1.runs.$runFriendlyId.waitpoints.tokens.$waitpointFriendlyId.wait");
  const entry = H.handlers.find(
    ({ config }) =>
      config?.params?.shape?.runFriendlyId && config?.params?.shape?.waitpointFriendlyId
  );
  if (!entry) throw new Error("waitpoint wait route handler was not captured");
  return entry.handler as (args: any) => Promise<Response>;
}

async function seedRun(
  prisma: PrismaClient,
  environment: { id: string; projectId: string; organizationId: string }
) {
  const run = RunId.generate();
  await prisma.taskRun.create({
    data: {
      id: run.id,
      friendlyId: run.friendlyId,
      engine: "V2",
      taskIdentifier: "authorization-test",
      payload: "{}",
      traceId: `trace_${run.id}`,
      spanId: `span_${run.id}`,
      queue: "task/authorization-test",
      projectId: environment.projectId,
      runtimeEnvironmentId: environment.id,
      organizationId: environment.organizationId,
      environmentType: "DEVELOPMENT",
      runTags: [],
    },
  });
  return run;
}

async function seedWaitpoint(prisma: PrismaClient, environmentId: string, projectId: string) {
  const waitpoint = WaitpointId.generate();
  await prisma.waitpoint.create({
    data: {
      id: waitpoint.id,
      friendlyId: waitpoint.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: waitpoint.id,
      userProvidedIdempotencyKey: false,
      environmentId,
      projectId,
    },
  });
  return waitpoint;
}

beforeEach(() => {
  H.engineCalls = [];
});

describe("waitpoint-token wait run authorization", () => {
  postgresTest("rejects a run from another runtime environment", async ({ prisma }) => {
    const seed = await seedTestEnvironment(prisma);
    const foreignEnvironment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "staging",
        type: "DEVELOPMENT",
        apiKey: `tr_dev_foreign_${seed.environment.id}`,
        pkApiKey: `pk_dev_foreign_${seed.environment.id}`,
        shortcode: `foreign_${seed.environment.id}`,
        projectId: seed.project.id,
        organizationId: seed.organization.id,
      },
    });
    const run = await seedRun(prisma, foreignEnvironment);
    const waitpoint = await seedWaitpoint(prisma, seed.environment.id, seed.project.id);

    H.prisma = prisma;
    H.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const handler = await routeHandler();

    const response = await handler({
      authentication: {
        environment: {
          ...seed.environment,
          project: seed.project,
          organization: seed.organization,
        },
      },
      params: {
        runFriendlyId: run.friendlyId,
        waitpointFriendlyId: waitpoint.friendlyId,
      },
    }).then(
      (result) => result,
      (error) => error
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("You don't have permissions for this run");
    expect(H.engineCalls).toHaveLength(0);
  });

  postgresTest(
    "attaches a waitpoint to a run in the authenticated environment",
    async ({ prisma }) => {
      const seed = await seedTestEnvironment(prisma);
      const run = await seedRun(prisma, seed.environment);
      const waitpoint = await seedWaitpoint(prisma, seed.environment.id, seed.project.id);

      H.prisma = prisma;
      H.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const handler = await routeHandler();

      const response = await handler({
        authentication: {
          environment: {
            ...seed.environment,
            project: seed.project,
            organization: seed.organization,
          },
        },
        params: {
          runFriendlyId: run.friendlyId,
          waitpointFriendlyId: waitpoint.friendlyId,
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(H.engineCalls).toEqual([
        {
          runId: run.id,
          waitpoints: [waitpoint.id],
          projectId: seed.project.id,
          organizationId: seed.organization.id,
        },
      ]);
    }
  );
});
