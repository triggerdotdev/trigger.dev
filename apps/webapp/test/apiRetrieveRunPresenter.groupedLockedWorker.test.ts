import { postgresTest } from "@internal/testcontainers";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { beforeEach, describe, expect, vi } from "vitest";

// `findRun` reads the module-level `prisma`/`$replica` (control-plane handles) both directly
// and, transitively, via the `runStore`/`controlPlaneResolver` singletons that also import them.
// A lazy Proxy - not a plain value - is captured by those singletons at their own (one-time)
// construction, so pointing it at a real container client after the fact still routes every
// call there. Not a DB mock: every call forwards to a real Postgres container.
const dbHolder = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (!dbHolder.client) throw new Error("dbHolder.client not set for this test");
        return (dbHolder.client as any)[prop];
      },
    }
  );
  return { prisma: proxy, $replica: proxy };
});

vi.mock("~/v3/objectStore.server", () => ({
  generatePresignedUrl: vi.fn(async () => ({ success: false, error: "not-used" })),
}));

import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

vi.setConfig({ testTimeout: 60_000 });

// Wraps a real Prisma client so every `client.<model>.<method>(...)` call is tallied by
// `"<model>.<method>"` before being forwarded, unmodified, to the real delegate.
function createCallCountingProxy(client: PrismaClient): {
  client: PrismaClient;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const wrappedModels = new Map<string, unknown>();

  const wrapModel = (model: string, delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && typeof value === "function") {
          return (...args: unknown[]) => {
            counts.set(`${model}.${prop}`, (counts.get(`${model}.${prop}`) ?? 0) + 1);
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

  return { client: proxy as PrismaClient, counts };
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
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

function authEnv(
  organization: { id: string },
  project: { id: string; externalRef: string },
  runtimeEnvironment: { id: string; slug: string }
): AuthenticatedEnvironment {
  return {
    id: runtimeEnvironment.id,
    slug: runtimeEnvironment.slug,
    organizationId: organization.id,
    organization: { id: organization.id },
    project: { id: project.id, externalRef: project.externalRef },
  } as unknown as AuthenticatedEnvironment;
}

async function seedBackgroundWorker(
  prisma: PrismaClient,
  ctx: { projectId: string; runtimeEnvironmentId: string },
  version: string
) {
  return prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${generateRunOpsId()}`,
      version,
      contentHash: `hash_${generateRunOpsId()}`,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.runtimeEnvironmentId,
      metadata: {},
    },
  });
}

interface SeedRunOpts {
  id: string;
  friendlyId: string;
  runtimeEnvironmentId: string;
  projectId: string;
  organizationId: string;
  lockedToVersionId?: string;
  parentTaskRunId?: string;
  rootTaskRunId?: string;
}

async function seedRun(prisma: PrismaClient, opts: SeedRunOpts) {
  return prisma.taskRun.create({
    data: {
      id: opts.id,
      friendlyId: opts.friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ hello: "world" }),
      payloadType: "application/json",
      traceId: `trace_${opts.id}`,
      spanId: `span_${opts.id}`,
      queue: "task/my-task",
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
      projectId: opts.projectId,
      organizationId: opts.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      lockedToVersionId: opts.lockedToVersionId,
      parentTaskRunId: opts.parentTaskRunId,
      rootTaskRunId: opts.rootTaskRunId,
    },
  });
}

beforeEach(() => {
  dbHolder.client = undefined;
});

describe("ApiRetrieveRunPresenter.findRun locked-worker version resolution", () => {
  postgresTest(
    "resolves run+parent+root+children lockedToVersion with ONE grouped query, not one per id",
    async ({ prisma }) => {
      const proxied = createCallCountingProxy(prisma);
      dbHolder.client = proxied.client;

      const { organization, project, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma,
        "grouped"
      );
      const workerCtx = { projectId: project.id, runtimeEnvironmentId: runtimeEnvironment.id };

      // Two distinct versions - `workerA` is deliberately reused across run/root/one child to
      // prove the pre-existing dedup-by-Set still collapses to the same distinct-id count.
      const workerA = await seedBackgroundWorker(prisma, workerCtx, "2024.1.0");
      const workerB = await seedBackgroundWorker(prisma, workerCtx, "2024.2.0");
      const workerC = await seedBackgroundWorker(prisma, workerCtx, "2024.3.0");

      const rootId = generateRunOpsId();
      const parentId = generateRunOpsId();
      const runId = generateRunOpsId();
      const childId1 = generateRunOpsId();
      const childId2 = generateRunOpsId();

      await seedRun(prisma, {
        id: rootId,
        friendlyId: `run_${rootId}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        lockedToVersionId: workerA.id,
      });
      await seedRun(prisma, {
        id: parentId,
        friendlyId: `run_${parentId}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        rootTaskRunId: rootId,
        lockedToVersionId: workerB.id,
      });
      await seedRun(prisma, {
        id: runId,
        friendlyId: `run_${runId}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        parentTaskRunId: parentId,
        rootTaskRunId: rootId,
        lockedToVersionId: workerA.id,
      });
      await seedRun(prisma, {
        id: childId1,
        friendlyId: `run_${childId1}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        parentTaskRunId: runId,
        rootTaskRunId: rootId,
        lockedToVersionId: workerC.id,
      });
      await seedRun(prisma, {
        id: childId2,
        friendlyId: `run_${childId2}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        parentTaskRunId: runId,
        rootTaskRunId: rootId,
        lockedToVersionId: workerA.id,
      });

      const env = authEnv(organization, project, runtimeEnvironment);
      const found = await ApiRetrieveRunPresenter.findRun(`run_${runId}`, env);

      expect(found).not.toBeNull();
      expect(found!.lockedToVersion?.version).toBe(workerA.version);
      expect(found!.parentTaskRun?.lockedToVersion?.version).toBe(workerB.version);
      expect(found!.rootTaskRun?.lockedToVersion?.version).toBe(workerA.version);
      const versionByChildFriendlyId = new Map(
        found!.childRuns.map((c) => [c.friendlyId, c.lockedToVersion?.version])
      );
      expect(versionByChildFriendlyId.get(`run_${childId1}`)).toBe(workerC.version);
      expect(versionByChildFriendlyId.get(`run_${childId2}`)).toBe(workerA.version);

      // 3 distinct lockedToVersionIds (workerA, workerB, workerC) across 5 rows -> ONE grouped
      // findMany, ZERO per-id findFirst.
      expect(proxied.counts.get("backgroundWorker.findMany") ?? 0).toBe(1);
      expect(proxied.counts.get("backgroundWorker.findFirst") ?? 0).toBe(0);
    }
  );
});
