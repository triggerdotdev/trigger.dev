// Real-PG proof for the RunPresenter run-detail read seam. The DB is never mocked:
// the only vi.mock redirects the `~/db.server` module handle (captured by the
// `runStore` singleton at load) to the live testcontainer client via a delegating
// Proxy. Seeding `logsDeletedAt` + `showDeletedLogs: false` makes `showLogs` false,
// so the presenter returns the header EARLY — before the trace path and the
// `user.findFirst` admin read — keeping the test off ClickHouse.
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// Hoisted alongside the vi.mock factory. `setCurrentPrisma` points the delegating
// Proxy at each test's container. The RunStore singleton is built ONCE at import and
// its error-normalizing wrapper memoizes each Prisma model delegate on first access;
// returning `current.taskRun` directly would freeze the store onto the first test's
// container ("Database test_0 does not exist" on later tests). So object-valued
// delegates return a STABLE per-key sub-proxy the store can safely cache, which
// re-delegates to the live `current[key]` on every access; functions/scalars pass
// through to the live client.
const { delegating, setCurrentPrisma } = vi.hoisted(() => {
  let current: any = undefined;
  const subProxyCache = new Map<string, unknown>();

  const getSubProxy = (prop: string) => {
    const cached = subProxyCache.get(prop);
    if (cached) {
      return cached;
    }
    const subProxy = new Proxy(
      {},
      {
        get(_st, key) {
          if (!current) {
            throw new Error("currentPrisma not set");
          }
          const delegate = current[prop];
          const value = delegate?.[key];
          return typeof value === "function" ? value.bind(delegate) : value;
        },
      }
    );
    subProxyCache.set(prop, subProxy);
    return subProxy;
  };

  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (!current) {
          throw new Error("currentPrisma not set");
        }
        if (typeof prop === "string") {
          const value = current[prop];
          if (value != null && typeof value === "object") {
            return getSubProxy(prop);
          }
          return value;
        }
        return current[prop];
      },
    }
  );
  return {
    delegating: proxy,
    setCurrentPrisma: (p: unknown) => {
      current = p;
    },
  };
});

vi.mock("~/db.server", () => ({
  prisma: delegating,
  $replica: delegating,
}));

// Imported AFTER the hoisted vi.mock so the singleton (built from `~/db.server`)
// captures the Proxy as its `readOnlyPrisma`.
import {
  RunEnvironmentMismatchError,
  RunNotInPgError,
  RunPresenter,
} from "~/presenters/v3/RunPresenter.server";

let suffixCounter = 0;
function uniqueSuffix(prefix: string) {
  suffixCounter += 1;
  return `${prefix}-${suffixCounter}-${Date.now()}`;
}

async function seedOrgProjectEnvMember(prisma: PrismaClient, suffix: string) {
  const user = await prisma.user.create({
    data: {
      email: `${suffix}@test.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });

  const organization = await prisma.organization.create({
    data: {
      title: `org-${suffix}`,
      slug: `org-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
    include: { members: true },
  });

  const project = await prisma.project.create({
    data: {
      name: `proj-${suffix}`,
      slug: `proj-${suffix}`,
      organizationId: organization.id,
      externalRef: `ext-${suffix}`,
    },
  });

  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      orgMemberId: organization.members[0]!.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `sc-${suffix}`,
    },
  });

  return { user, organization, project, runtimeEnvironment };
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
      traceId: "trace-1234",
      spanId: "span-1234",
      queue: "test",
      runtimeEnvironmentId: env.runtimeEnvironmentId,
      projectId: env.projectId,
      organizationId: env.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      // logsDeletedAt set → showLogs is false → presenter returns the header
      // EARLY, before the trace path and before the `user.findFirst` admin read.
      logsDeletedAt: new Date(),
    },
  });
}

describe("RunPresenter run read seam (single-DB, real PG)", () => {
  postgresTest(
    "passthrough resolves the run-detail header via the singleton",
    async ({ prisma }) => {
      setCurrentPrisma(prisma);

      const suffix = uniqueSuffix("pt");
      const { user, organization, project, runtimeEnvironment } = await seedOrgProjectEnvMember(
        prisma,
        suffix
      );

      const id = generateKsuidId();
      const friendlyId = `run_${id}`;
      const run = await seedRun(
        prisma,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      const presenter = new RunPresenter(prisma);
      const result = await presenter.call({
        userId: user.id,
        projectSlug: project.slug,
        environmentSlug: runtimeEnvironment.slug,
        runFriendlyId: friendlyId,
        showDeletedLogs: false,
        showDebug: false,
      });

      // Header served through the store seam (singleton → Proxy → real container).
      expect(result.run.id).toBe(id);
      expect(result.run.friendlyId).toBe(friendlyId);
      expect(result.run.number).toBe(run.number);
      expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(result.run.environment.slug).toBe(runtimeEnvironment.slug);
      // logsDeletedAt is set → early return, no trace.
      expect(result.trace).toBeUndefined();
    }
  );

  postgresTest(
    "run read is NOT pinned to the constructor client (served via the seam)",
    async ({ prisma }) => {
      setCurrentPrisma(prisma);

      const suffix = uniqueSuffix("unpinned");
      const { user, organization, project, runtimeEnvironment } = await seedOrgProjectEnvMember(
        prisma,
        suffix
      );

      const id = generateKsuidId();
      const friendlyId = `run_${id}`;
      await seedRun(
        prisma,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      // Sentinel constructor client whose taskRun.findFirst THROWS: if the run read
      // were pinned to this.#prismaClient the call would reject — it resolves because
      // the run read flows through the store seam/singleton instead. The control-plane
      // lookups (project-scope + membership auth; the trace-path admin user.findFirst)
      // are NOT split and correctly use the constructor client, so they are stubbed to
      // succeed while taskRun stays throwing.
      const sentinel = {
        taskRun: {
          findFirst: () => {
            throw new Error("run read must not use constructor client");
          },
        },
        project: {
          findFirst: async () => ({ id: project.id }),
        },
        user: {
          findFirst: async () => user,
        },
      } as unknown as PrismaClient;

      const presenter = new RunPresenter(sentinel);
      const result = await presenter.call({
        userId: user.id,
        projectSlug: project.slug,
        environmentSlug: runtimeEnvironment.slug,
        runFriendlyId: friendlyId,
        showDeletedLogs: false,
        showDebug: false,
      });

      expect(result.run.id).toBe(id);
      expect(result.run.friendlyId).toBe(friendlyId);
      expect(result.trace).toBeUndefined();
    }
  );

  postgresTest("missing run maps to RunNotInPgError", async ({ prisma }) => {
    setCurrentPrisma(prisma);

    const suffix = uniqueSuffix("notfound");
    const { user, project, runtimeEnvironment } = await seedOrgProjectEnvMember(prisma, suffix);

    const missingFriendlyId = `run_${generateKsuidId()}`;

    const presenter = new RunPresenter(prisma);
    await expect(
      presenter.call({
        userId: user.id,
        projectSlug: project.slug,
        environmentSlug: runtimeEnvironment.slug,
        runFriendlyId: missingFriendlyId,
        showDeletedLogs: false,
        showDebug: false,
      })
    ).rejects.toThrow(RunNotInPgError);
  });

  postgresTest("environment mismatch maps to RunEnvironmentMismatchError", async ({ prisma }) => {
    setCurrentPrisma(prisma);

    const suffix = uniqueSuffix("mismatch");
    const { user, organization, project, runtimeEnvironment } = await seedOrgProjectEnvMember(
      prisma,
      suffix
    );

    const id = generateKsuidId();
    const friendlyId = `run_${id}`;
    await seedRun(
      prisma,
      { id, friendlyId },
      {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
      }
    );

    const presenter = new RunPresenter(prisma);
    await expect(
      presenter.call({
        userId: user.id,
        projectSlug: project.slug,
        // Seeded env slug is `env-${suffix}`; pass a different slug.
        environmentSlug: `other-${suffix}`,
        runFriendlyId: friendlyId,
        showDeletedLogs: false,
        showDebug: false,
      })
    ).rejects.toThrow(RunEnvironmentMismatchError);
  });
});
