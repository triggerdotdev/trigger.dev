// Real control-plane (single Postgres) proof that resolving the locked-worker version for many
// runs' distinct `lockedToVersionId`s is a GROUPED query, not one `backgroundWorker.findFirst`
// per id. The DB is never mocked: the call-counting proxy below delegates every call to the
// real Prisma client (the real query still runs against the real container) - it only tallies
// how many times each model.method pair was invoked.
import { postgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import { ControlPlaneCache } from "./controlPlaneCache.server";
import { ControlPlaneResolver } from "./controlPlaneResolver.server";

// Wraps a real Prisma client so every `client.<model>.<method>(...)` call is tallied by
// `"<model>.<method>"` before being forwarded, unmodified, to the real delegate. No behavior is
// faked or short-circuited - this is instrumentation, not a mock.
function createCallCountingProxy<T extends object>(
  client: T
): { client: T; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const wrappedModels = new Map<string, unknown>();

  const wrapModel = (model: string, delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && typeof value === "function") {
          return (...args: unknown[]) => {
            bump(`${model}.${prop}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        value &&
        typeof value === "object" &&
        typeof (value as { findMany?: unknown }).findMany === "function"
      ) {
        if (!wrappedModels.has(prop)) {
          wrappedModels.set(prop, wrapModel(prop, value as object));
        }
        return wrappedModels.get(prop);
      }
      return value;
    },
  });

  return { client: proxy as T, counts };
}

let n = 0;

async function seedEnv(prisma: PrismaClient) {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-${s}`,
      externalRef: `proj_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  return { organization, project, environment };
}

async function seedBackgroundWorker(
  prisma: PrismaClient,
  ctx: { projectId: string; runtimeEnvironmentId: string },
  version: string
) {
  const s = n++;
  return prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${s}`,
      version,
      contentHash: `hash_${s}`,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.runtimeEnvironmentId,
      metadata: {},
    },
  });
}

describe("ControlPlaneResolver.resolveRunLockedWorkersByVersionIds", () => {
  postgresTest(
    "issues ONE grouped findMany and ZERO per-id findFirst for N distinct ids",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma);
      const workers = await Promise.all(
        [0, 1, 2].map((i) =>
          seedBackgroundWorker(
            prisma,
            { projectId: project.id, runtimeEnvironmentId: environment.id },
            `2024010${i}.0`
          )
        )
      );

      const { client: countedReplica, counts } = createCallCountingProxy(prisma);

      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma,
        controlPlaneReplica: countedReplica as unknown as PrismaReplicaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => true,
      });

      const ids = workers.map((w) => w.id);
      const result = await resolver.resolveRunLockedWorkersByVersionIds(ids);

      expect(counts.get("backgroundWorker.findMany") ?? 0).toBe(1);
      expect(counts.get("backgroundWorker.findFirst") ?? 0).toBe(0);

      for (const worker of workers) {
        expect(result.get(worker.id)?.lockedToVersion?.version).toBe(worker.version);
      }
    }
  );

  postgresTest("cache-hit ids issue no query at all", async ({ prisma }) => {
    const { project, environment } = await seedEnv(prisma);
    const worker = await seedBackgroundWorker(
      prisma,
      { projectId: project.id, runtimeEnvironmentId: environment.id },
      "20240101.0"
    );

    const cache = new ControlPlaneCache();
    const { client: countedReplica, counts } = createCallCountingProxy(prisma);

    const resolver = new ControlPlaneResolver({
      controlPlanePrimary: prisma,
      controlPlaneReplica: countedReplica as unknown as PrismaReplicaClient,
      cache,
      splitEnabled: () => true,
    });

    // Warm the cache.
    await resolver.resolveRunLockedWorkersByVersionIds([worker.id]);
    expect(counts.get("backgroundWorker.findMany") ?? 0).toBe(1);

    // Second call for the same id is served entirely from cache - no query at all.
    const result = await resolver.resolveRunLockedWorkersByVersionIds([worker.id]);
    expect(counts.get("backgroundWorker.findMany") ?? 0).toBe(1);
    expect(counts.get("backgroundWorker.findFirst") ?? 0).toBe(0);
    expect(result.get(worker.id)?.lockedToVersion?.version).toBe(worker.version);
  });
});
