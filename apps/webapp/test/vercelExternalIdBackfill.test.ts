import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { backfillVercelExternalIds } from "~/v3/services/vercelExternalIdBackfill.server";

let seedCounter = 0;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type SeedOptions = {
  vercelConnected?: boolean;
  environmentType?: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
};

async function seedEnv(prisma: PrismaClient, slug: string, options: SeedOptions = {}) {
  const { vercelConnected = true, environmentType = "PRODUCTION" } = options;
  const n = seedCounter++;

  const organization = await prisma.organization.create({
    data: { title: `Org ${slug}`, slug: `org-${slug}-${n}` },
  });

  const project = await prisma.project.create({
    data: {
      name: `Proj ${slug}`,
      slug: `proj-${slug}-${n}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}-${n}`,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}-${n}`,
      type: environmentType,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `api-${slug}-${n}`,
      pkApiKey: `pk-${slug}-${n}`,
      shortcode: `sc-${slug}-${n}`,
    },
  });

  if (vercelConnected) {
    const tokenReference = await prisma.secretReference.create({
      data: { key: `secret-${slug}-${n}` },
    });

    const organizationIntegration = await prisma.organizationIntegration.create({
      data: {
        friendlyId: `oi-${slug}-${n}`,
        service: "VERCEL",
        integrationData: {},
        tokenReferenceId: tokenReference.id,
        organizationId: organization.id,
      },
    });

    await prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: organizationIntegration.id,
        projectId: project.id,
        externalEntityId: `vercel-project-${n}`,
        integrationData: {},
      },
    });
  }

  return { organization, project, environment };
}

type SeedCtx = Awaited<ReturnType<typeof seedEnv>>;

type DeploymentOptions = {
  version: string;
  commitSHA?: string | null;
  externalId?: string | null;
  status?: "DEPLOYED" | "FAILED" | "BUILDING";
  withWorker?: boolean;
  createdAt?: Date;
};

async function seedDeployment(prisma: PrismaClient, ctx: SeedCtx, options: DeploymentOptions) {
  const {
    version,
    commitSHA = SHA_A,
    externalId = null,
    status = "DEPLOYED",
    withWorker = true,
    createdAt,
  } = options;
  const n = seedCounter++;

  let workerId: string | undefined;
  if (withWorker) {
    const worker = await prisma.backgroundWorker.create({
      data: {
        friendlyId: `worker-${n}`,
        contentHash: `hash-${n}`,
        projectId: ctx.project.id,
        runtimeEnvironmentId: ctx.environment.id,
        version,
        metadata: {},
      },
    });
    workerId = worker.id;
  }

  return prisma.workerDeployment.create({
    data: {
      contentHash: `hash-${n}`,
      friendlyId: `deployment-${n}`,
      shortCode: `short-${n}`,
      version,
      status,
      projectId: ctx.project.id,
      environmentId: ctx.environment.id,
      commitSHA,
      externalId,
      workerId,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

function run(
  prisma: PrismaClient,
  overrides: Partial<Parameters<typeof backfillVercelExternalIds>[0]> = {}
) {
  return backfillVercelExternalIds({
    prisma,
    replica: prisma,
    limit: 100,
    recentPerEnvironment: 10,
    parallelism: 5,
    dryRun: false,
    ...overrides,
  });
}

describe("backfillVercelExternalIds", () => {
  postgresTest("copies commitSHA into externalId for a Vercel deployment", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "copy");
    const deployment = await seedDeployment(prisma, ctx, { version: "20260101.1" });

    const result = await run(prisma);

    expect(result.deployments.written).toBe(1);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBe(SHA_A);
  });

  postgresTest("a dry run reports the work and writes nothing", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "dry");
    const deployment = await seedDeployment(prisma, ctx, { version: "20260101.1" });

    const result = await run(prisma, { dryRun: true });

    expect(result.summary.would_update).toBe(1);
    expect(result.deployments.eligible).toBe(1);
    expect(result.deployments.written).toBe(0);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest("never overwrites an existing externalId", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "keep");
    const deployment = await seedDeployment(prisma, ctx, {
      version: "20260101.1",
      commitSHA: SHA_A,
      externalId: SHA_B,
    });

    const result = await run(prisma);

    expect(result.deployments.written).toBe(0);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBe(SHA_B);
  });

  postgresTest("skips projects with no Vercel integration", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "novercel", { vercelConnected: false });
    const deployment = await seedDeployment(prisma, ctx, { version: "20260101.1" });

    const result = await run(prisma);

    expect(result.environments.find((e) => e.id === ctx.environment.id)).toBeUndefined();

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest("skips development environments", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "dev", { environmentType: "DEVELOPMENT" });
    const deployment = await seedDeployment(prisma, ctx, { version: "20260101.1" });

    await run(prisma);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest("skips deployments that are not DEPLOYED", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "failed");
    const deployment = await seedDeployment(prisma, ctx, {
      version: "20260101.1",
      status: "FAILED",
    });

    await run(prisma);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest("skips deployments with no usable commitSHA", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "nosha");
    const missing = await seedDeployment(prisma, ctx, { version: "20260101.1", commitSHA: null });
    const blank = await seedDeployment(prisma, ctx, { version: "20260101.2", commitSHA: "   " });
    const tooLong = await seedDeployment(prisma, ctx, {
      version: "20260101.3",
      commitSHA: "c".repeat(129),
    });

    const result = await run(prisma);

    expect(result.deployments.written).toBe(0);
    for (const deployment of [missing, blank, tooLong]) {
      const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
      expect(after?.externalId).toBeNull();
    }
  });

  postgresTest("skips deployments with no worker", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "noworker");
    const deployment = await seedDeployment(prisma, ctx, {
      version: "20260101.1",
      withWorker: false,
    });

    await run(prisma);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest(
    "recentPerEnvironment bounds the window, and current is always included",
    async ({ prisma }) => {
      const ctx = await seedEnv(prisma, "window");

      const oldest = await seedDeployment(prisma, ctx, {
        version: "20260101.1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      const newest = await seedDeployment(prisma, ctx, {
        version: "20260101.2",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      });

      // Promote the oldest, so it can only be reached via the promotion arm.
      await prisma.workerDeploymentPromotion.create({
        data: {
          label: "current",
          deploymentId: oldest.id,
          environmentId: ctx.environment.id,
        },
      });

      const result = await run(prisma, { recentPerEnvironment: 1 });

      expect(result.deployments.written).toBe(2);

      const afterOldest = await prisma.workerDeployment.findFirst({ where: { id: oldest.id } });
      const afterNewest = await prisma.workerDeployment.findFirst({ where: { id: newest.id } });
      expect(afterOldest?.externalId).toBe(SHA_A);
      expect(afterNewest?.externalId).toBe(SHA_A);
    }
  );

  postgresTest(
    "recentPerEnvironment 0 backfills only the current promotion",
    async ({ prisma }) => {
      const ctx = await seedEnv(prisma, "currentonly");

      const promoted = await seedDeployment(prisma, ctx, { version: "20260101.1" });
      const other = await seedDeployment(prisma, ctx, { version: "20260101.2" });

      await prisma.workerDeploymentPromotion.create({
        data: {
          label: "current",
          deploymentId: promoted.id,
          environmentId: ctx.environment.id,
        },
      });

      const result = await run(prisma, { recentPerEnvironment: 0 });

      expect(result.deployments.written).toBe(1);

      const afterPromoted = await prisma.workerDeployment.findFirst({ where: { id: promoted.id } });
      const afterOther = await prisma.workerDeployment.findFirst({ where: { id: other.id } });
      expect(afterPromoted?.externalId).toBe(SHA_A);
      expect(afterOther?.externalId).toBeNull();
    }
  );

  postgresTest("is idempotent across a second run", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "idem");
    await seedDeployment(prisma, ctx, { version: "20260101.1" });

    const first = await run(prisma);
    const second = await run(prisma);

    expect(first.deployments.written).toBe(1);
    expect(second.deployments.written).toBe(0);
  });

  postgresTest("paginates by connected project and reports done at the end", async ({ prisma }) => {
    const first = await seedEnv(prisma, "page-a");
    const second = await seedEnv(prisma, "page-b");
    await seedDeployment(prisma, first, { version: "20260101.1" });
    await seedDeployment(prisma, second, { version: "20260101.1" });

    const integrations = await prisma.organizationProjectIntegration.findMany({
      where: { projectId: { in: [first.project.id, second.project.id] } },
      select: { id: true, projectId: true },
      orderBy: { id: "asc" },
    });
    expect(integrations).toHaveLength(2);

    const page = await run(prisma, { limit: 1, dryRun: true });
    expect(page.projects).toBe(1);
    expect(page.next).toBe(integrations[0]?.id);

    const firstPageProject = integrations[0]?.projectId;
    const expectedEnvironment =
      firstPageProject === first.project.id ? first.environment.id : second.environment.id;
    expect(page.environments.map((e) => e.id)).toEqual([expectedEnvironment]);

    const secondPage = await run(prisma, { limit: 1, cursor: page.next, dryRun: true });
    expect(secondPage.projects).toBe(1);
    expect(secondPage.environments.map((e) => e.id)).not.toEqual([expectedEnvironment]);

    const exhausted = await run(prisma, { cursor: secondPage.next, dryRun: true });
    expect(exhausted.done).toBe(true);
    expect(exhausted.environments).toHaveLength(0);
  });

  postgresTest("a project with two connection rows is not walked twice", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "dupe");
    const deployment = await seedDeployment(prisma, ctx, { version: "20260101.1" });

    // Reconnecting leaves the earlier row in place.
    const existing = await prisma.organizationProjectIntegration.findFirst({
      where: { projectId: ctx.project.id },
      select: { organizationIntegrationId: true },
    });
    await prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: existing!.organizationIntegrationId,
        projectId: ctx.project.id,
        externalEntityId: "vercel-project-dupe",
        integrationData: {},
      },
    });

    const result = await run(prisma, { dryRun: true });

    expect(result.projects).toBe(1);
    expect(result.environments.filter((e) => e.id === ctx.environment.id)).toHaveLength(1);
    expect(result.deployments.eligible).toBe(1);

    const after = await prisma.workerDeployment.findFirst({ where: { id: deployment.id } });
    expect(after?.externalId).toBeNull();
  });

  postgresTest("a failed environment lookup does not cost the page", async ({ prisma }) => {
    const first = await seedEnv(prisma, "fail-a");
    const second = await seedEnv(prisma, "fail-b");
    await seedDeployment(prisma, first, { version: "20260101.1" });
    await seedDeployment(prisma, second, { version: "20260101.1" });

    // pMap rejects the whole call when a mapper throws, even with
    // stopOnError: false, so the lookup has to convert its own failures.
    const replica = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "runtimeEnvironment") {
          return {
            findMany: async () => {
              throw new Error("simulated replica failure");
            },
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    const result = await backfillVercelExternalIds({
      prisma,
      replica,
      limit: 100,
      recentPerEnvironment: 10,
      parallelism: 5,
      dryRun: false,
    });

    expect(result.projects).toBeGreaterThanOrEqual(2);
    expect(result.next).toBeDefined();
    expect(result.summary.error).toBe(result.projects);
    expect(result.environments.every((e) => e.scope === "project")).toBe(true);
    expect(result.environments.every((e) => e.error === "simulated replica failure")).toBe(true);
    expect(result.deployments.written).toBe(0);
  });
});
