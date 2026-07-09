// Proves the dev-session-cancel read is grouped into a constant number of queries
// instead of one findFirst per run id (N+1). Real Postgres via testcontainers — the
// DB is never mocked. A call-counting proxy sits over the REAL Prisma client: it
// tallies findFirst/findMany per delegate and forwards every call unchanged, so the
// real query still runs against the real database. This is instrumentation, not a
// mock.
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { CancelDevSessionRunsService } from "~/v3/services/cancelDevSessionRuns.server";

vi.setConfig({ testTimeout: 60_000 });

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

// Call-counting instrumentation over the REAL Prisma client. Every findFirst/findMany
// invocation is tallied per delegate and then forwarded to the real underlying method
// (`target[key].apply(target, args)`), so the real query still executes against the
// real container. Every other property passes through untouched.
function countingClient(client: PrismaClient) {
  const counts = { findFirst: 0, findMany: 0 };
  const realTaskRun = client.taskRun;
  const taskRunProxy = new Proxy(realTaskRun, {
    get(target, prop, receiver) {
      if (prop === "findFirst" || prop === "findMany") {
        const key = prop as "findFirst" | "findMany";
        return (...args: unknown[]) => {
          counts[key]++;
          return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const clientProxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "taskRun") {
        return taskRunProxy;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { handle: clientProxy as unknown as PrismaReplicaClient, counts };
}

describe("CancelDevSessionRunsService grouped reads", () => {
  postgresTest(
    "reads N runs in a constant number of grouped queries instead of one findFirst per run id",
    async ({ prisma }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma,
        "grouped"
      );

      const seeded = await Promise.all(
        ["a", "b", "c"].map((suffix) =>
          seedRun(
            prisma,
            { id: `run-internal-${suffix}`, friendlyId: `run_run-internal-${suffix}` },
            {
              runtimeEnvironmentId: runtimeEnvironment.id,
              projectId: project.id,
              organizationId: organization.id,
            }
          )
        )
      );

      const counting = countingClient(prisma);

      const service = new CancelDevSessionRunsService({
        prisma,
        replica: prisma,
        readThroughDeps: {
          splitEnabled: false,
          newClient: counting.handle,
        },
      });

      await service.call({
        runIds: seeded.map((r) => r.id),
        cancelledAt: new Date(),
        reason: "test",
      });

      // The N+1 fix: one grouped findMany for the whole id batch, zero per-run findFirst calls.
      expect(counting.counts.findMany).toBe(1);
      expect(counting.counts.findFirst).toBe(0);
    }
  );

  postgresTest(
    "a single run id still resolves correctly (grouped read collapses to the same single read)",
    async ({ prisma }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma,
        "single"
      );

      const run = await seedRun(
        prisma,
        { id: "run-internal-solo", friendlyId: "run_run-internal-solo" },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      const counting = countingClient(prisma);

      const service = new CancelDevSessionRunsService({
        prisma,
        replica: prisma,
        readThroughDeps: {
          splitEnabled: false,
          newClient: counting.handle,
        },
      });

      await service.call({
        runIds: [run.id],
        cancelledAt: new Date(),
        reason: "test",
      });

      expect(counting.counts.findFirst).toBe(1);
      expect(counting.counts.findMany).toBe(0);
    }
  );
});
