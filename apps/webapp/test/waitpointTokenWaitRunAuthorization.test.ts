import { PostgresRunStore, RoutingRunStore, type RunStore } from "@internal/run-store";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateRunOpsIdV2, RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildJwtAbility } from "@trigger.dev/plugins";
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
    // Split reads on, so a gen-2 waitpoint id reaches the read-through's unconfigured-shard
    // branch. Every client is the one test database, so the cuid cases read the same rows.
    runOpsSplitReadEnabled: true,
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
  scopeAuthorizationError: () => "Missing permission",
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

async function seedWaitpoint(
  prisma: PrismaClient,
  environmentId: string,
  projectId: string,
  id?: string
) {
  const waitpoint = id ? { id, friendlyId: WaitpointId.toFriendlyId(id) } : WaitpointId.generate();
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
  it("cannot wait for a token without permission to read its output", async () => {
    const handler = await routeHandler();
    const response = await handler({
      ability: buildJwtAbility(["write:runs:run_self", "read:waitpoints:waitpoint_other"]),
      params: { runFriendlyId: "run_self", waitpointFriendlyId: "waitpoint_target" },
    });
    expect(response.status).toBe(403);
    expect(H.engineCalls).toHaveLength(0);
  });

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
      ability: buildJwtAbility(["admin"]),
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
        ability: buildJwtAbility(["admin"]),
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

  // Catches: the wait route, with split reads on, reading a waitpoint id on shard m or z from a gen-1
  // store (a row with that id there would attach) or answering it with anything but a retryable 404.
  postgresTest(
    "answers a waitpoint id on shard m or z with a retryable 404",
    async ({ prisma }) => {
      const seed = await seedTestEnvironment(prisma);
      const run = await seedRun(prisma, seed.environment);

      H.prisma = prisma;
      H.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const handler = await routeHandler();

      for (const shard of ["m", "z"]) {
        // A matching row in the one gen-1 database: a read of any gen-1 store finds it and attaches.
        const waitpoint = await seedWaitpoint(
          prisma,
          seed.environment.id,
          seed.project.id,
          generateRunOpsIdV2(shard)
        );
        const response = await handler({
          ability: buildJwtAbility(["admin"]),
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
        expect(response.status).toBe(404);
        expect(response.headers.get("x-should-retry")).toBe("true");
        expect(await response.json()).toEqual({ error: "Waitpoint not found" });
      }
      expect(H.engineCalls).toHaveLength(0);
    }
  );

  // Catches: a change in how the wait route answers a run id whose shard has no store.
  it("answers a run id on shard m or z with its own 500", async () => {
    const unreachable = new Proxy(
      {},
      {
        get() {
          throw new Error("no sub-store should be reached for an unconfigured shard key");
        },
      }
    ) as RunStore;
    H.store = new RoutingRunStore({ new: unreachable, legacy: unreachable });
    const handler = await routeHandler();

    for (const shard of ["m", "z"]) {
      const response = await handler({
        ability: buildJwtAbility(["admin"]),
        authentication: {
          environment: { id: "env_1", project: { id: "proj_1" }, organization: { id: "org_1" } },
        },
        params: {
          runFriendlyId: `run_${generateRunOpsIdV2(shard)}`,
          waitpointFriendlyId: "waitpoint_target",
        },
      }).then(
        (result) => result,
        (error) => error
      );

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(500);
      expect(response.headers.get("x-should-retry")).toBeNull();
      expect(await response.json()).toEqual({ error: "Failed to wait for waitpoint token" });
    }
    expect(H.engineCalls).toHaveLength(0);
  });
});
