import { containerTest } from "@internal/testcontainers";
import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { findOrCreateBackgroundWorker } from "~/v3/services/createDeploymentBackgroundWorkerV4/findOrCreateBackgroundWorker.server";

vi.setConfig({ testTimeout: 30_000 });

async function seedDeployment(prisma: PrismaClient, version = "20260528.1") {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });

  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: slug,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: slug,
      pkApiKey: slug,
      shortcode: slug,
    },
  });

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${slug}`,
      shortCode: slug,
      contentHash: "h_initial",
      status: "BUILDING",
      version,
      projectId: project.id,
      environmentId: environment.id,
    },
  });

  // The helper only reads `id` and `projectId`; the rest of the type is
  // unused here so we cast a partial.
  const authEnv = { id: environment.id, projectId: project.id } as AuthenticatedEnvironment;

  return { project, environment, deployment, authEnv };
}

function bodyWithHash(contentHash: string): CreateBackgroundWorkerRequestBody {
  return {
    localOnly: false,
    metadata: {
      contentHash,
      packageVersion: "0.0.0",
      cliPackageVersion: "0.0.0",
      tasks: [],
      queues: [],
      sourceFiles: [],
      runtime: "node",
      runtimeVersion: "21.0.0",
    },
    engine: "V2",
    supportsLazyAttempts: true,
  };
}

describe("findOrCreateBackgroundWorker", () => {
  containerTest("creates a new BackgroundWorker on the first call", async ({ prisma }) => {
    const { authEnv, deployment } = await seedDeployment(prisma);

    const worker = await findOrCreateBackgroundWorker(
      authEnv,
      deployment,
      bodyWithHash("h1"),
      prisma
    );

    expect(worker.projectId).toBe(authEnv.projectId);
    expect(worker.runtimeEnvironmentId).toBe(authEnv.id);
    expect(worker.version).toBe(deployment.version);
    expect(worker.contentHash).toBe("h1");

    const rowCount = await prisma.backgroundWorker.count({
      where: { projectId: authEnv.projectId, version: deployment.version },
    });
    expect(rowCount).toBe(1);
  });

  containerTest(
    "returns the existing row on a second call with the same contentHash (no duplicate)",
    async ({ prisma }) => {
      const { authEnv, deployment } = await seedDeployment(prisma);

      const first = await findOrCreateBackgroundWorker(
        authEnv,
        deployment,
        bodyWithHash("h1"),
        prisma
      );
      const second = await findOrCreateBackgroundWorker(
        authEnv,
        deployment,
        bodyWithHash("h1"),
        prisma
      );

      expect(second.id).toBe(first.id);

      const rowCount = await prisma.backgroundWorker.count({
        where: { projectId: authEnv.projectId, version: deployment.version },
      });
      expect(rowCount).toBe(1);
    }
  );

  containerTest(
    "throws 409 ServiceValidationError when an existing row has a different contentHash",
    async ({ prisma }) => {
      const { authEnv, deployment } = await seedDeployment(prisma);

      await findOrCreateBackgroundWorker(authEnv, deployment, bodyWithHash("h1"), prisma);

      await expect(
        findOrCreateBackgroundWorker(authEnv, deployment, bodyWithHash("h2"), prisma)
      ).rejects.toMatchObject({
        name: "ServiceValidationError",
        status: 409,
      });

      // Also assert the constructor so callers can `catch (e instanceof ServiceValidationError)`.
      await expect(
        findOrCreateBackgroundWorker(authEnv, deployment, bodyWithHash("h2"), prisma)
      ).rejects.toBeInstanceOf(ServiceValidationError);
    }
  );

  containerTest(
    "concurrent create race surfaces as plain Error (not ServiceValidationError)",
    async ({ prisma }) => {
      // The class distinction matters: the V4 service uses `instanceof ServiceValidationError`
      // to decide whether to fail-deploy. A transient race must not fail-deploy.
      const { authEnv, deployment } = await seedDeployment(prisma);

      const [first, second] = await Promise.allSettled([
        findOrCreateBackgroundWorker(authEnv, deployment, bodyWithHash("h-race"), prisma),
        findOrCreateBackgroundWorker(authEnv, deployment, bodyWithHash("h-race"), prisma),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
      const rejected = [first, second].filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );

      // Exactly one row in the database regardless of who won.
      const rowCount = await prisma.backgroundWorker.count({
        where: { projectId: authEnv.projectId, version: deployment.version },
      });
      expect(rowCount).toBe(1);

      // If the schedule produced an actual race (one wins, one loses), the loser
      // must surface a non-SVE error. If the schedule serialised them by accident,
      // both fulfilled is also acceptable — this test is about the error *class*,
      // not the rate of races.
      if (rejected.length > 0) {
        expect(fulfilled).toHaveLength(1);
        for (const r of rejected) {
          expect(r.reason).not.toBeInstanceOf(ServiceValidationError);
          expect((r.reason as Error).message).toMatch(/concurrent/i);
        }
      } else {
        expect(fulfilled).toHaveLength(2);
      }
    }
  );
});
