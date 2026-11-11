import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  createDeploymentWithNextVersion,
  DeploymentVersionCollisionError,
} from "~/v3/services/initializeDeployment/createDeploymentWithNextVersion.server";

vi.setConfig({ testTimeout: 30_000 });

async function seedEnvironment(prisma: PrismaClient) {
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

  return { organization, project, environment };
}

describe("createDeploymentWithNextVersion", () => {
  containerTest("non-preview deployments use only the original queries", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const operations: string[] = [];
    const observed = prisma.$extends({
      query: {
        $allOperations: async ({ model, operation, args, query }) => {
          operations.push(`${model ?? "raw"}.${operation}`);
          return query(args);
        },
      },
    });
    for (const type of ["PRODUCTION", "STAGING", "DEVELOPMENT"] as const) {
      operations.length = 0;
      await createDeploymentWithNextVersion(
        observed as unknown as PrismaClient,
        environment.id,
        () => ({
          projectId: project.id,
          friendlyId: `dark_${type}_${environment.id}`,
          shortCode: `dark_${type}`,
          contentHash: "dark",
        }),
        {
          archiveGuard: {
            type,
          },
        }
      );
      expect(operations).toEqual(["WorkerDeployment.findFirst", "WorkerDeployment.create"]);
    }
  });

  containerTest(
    "assigns unique sequential versions for concurrent calls in the same environment",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);

      const concurrency = 5;

      const results = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          createDeploymentWithNextVersion(prisma, environment.id, (nextVersion) => ({
            projectId: project.id,
            friendlyId: `deployment_${i}_${nextVersion}`,
            shortCode: `short_${i}_${nextVersion}`,
            contentHash: `hash_${i}`,
          }))
        )
      );

      // The property we care about: N concurrent racers all end up with
      // distinct, persistable versions. The retry path is exercised whenever
      // collisions happen (visible in the `Worker deployment version collided`
      // warn logs), and the exhaustion branch is covered deterministically by
      // the maxRetries: 0 test below.
      const versions = results.map((d) => d.version).sort();
      expect(new Set(versions).size).toBe(concurrency);
    }
  );

  containerTest("propagates non-P2002 errors immediately without retrying", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma);

    let buildDataCalls = 0;
    const buildData = () => {
      buildDataCalls++;
      throw new Error("builder boom");
    };

    await expect(
      createDeploymentWithNextVersion(prisma, environment.id, buildData)
    ).rejects.toThrow("builder boom");

    expect(buildDataCalls).toBe(1);
  });

  containerTest(
    "wraps exhausted retries in DeploymentVersionCollisionError with the P2002 as cause",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);

      let collisionVersion = "";
      // Insert the winner after the version is read, before the candidate is
      // inserted, so exhaustion does not depend on concurrent query scheduling.
      const deployment = createDeploymentWithNextVersion(
        prisma,
        environment.id,
        async (nextVersion) => {
          collisionVersion = nextVersion;
          await prisma.workerDeployment.create({
            data: {
              environmentId: environment.id,
              projectId: project.id,
              version: nextVersion,
              friendlyId: `winner_${environment.id}`,
              shortCode: "winner",
              contentHash: "winner",
            },
          });

          return {
            projectId: project.id,
            friendlyId: `candidate_${environment.id}`,
            shortCode: "candidate",
            contentHash: "candidate",
          };
        },
        { maxRetries: 0 }
      );

      await expect(deployment).rejects.toBeInstanceOf(DeploymentVersionCollisionError);
      await expect(deployment).rejects.toMatchObject({
        environmentId: environment.id,
        attempts: 1,
        lastAttemptedVersion: expect.stringMatching(/^\d{8}\.\d+$/),
        cause: { code: "P2002" },
      });
      expect(
        await prisma.workerDeployment.findMany({
          where: { environmentId: environment.id },
          select: { friendlyId: true, version: true },
        })
      ).toEqual([{ friendlyId: `winner_${environment.id}`, version: collisionVersion }]);
    }
  );
});
