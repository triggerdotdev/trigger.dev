import { containerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
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

  containerTest(
    "propagates non-P2002 errors immediately without retrying",
    async ({ prisma }) => {
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
    }
  );

  containerTest(
    "wraps exhausted retries in DeploymentVersionCollisionError with the P2002 as cause",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);

      const concurrency = 4;
      // maxRetries: 0 → no retry path. Concurrent racers all attempt the same
      // version; one wins, the rest must surface the wrapped collision error
      // (not a raw P2002) so Sentry can distinguish exhaustion from any other
      // unique-constraint violation.
      const settled = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, i) =>
          createDeploymentWithNextVersion(
            prisma,
            environment.id,
            (nextVersion) => ({
              projectId: project.id,
              friendlyId: `deployment_${i}_${nextVersion}`,
              shortCode: `short_${i}_${nextVersion}`,
              contentHash: `hash_${i}`,
            }),
            { maxRetries: 0 }
          )
        )
      );

      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === "rejected"
      );

      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(rejected.length).toBeGreaterThanOrEqual(1);

      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(DeploymentVersionCollisionError);
        const err = r.reason as DeploymentVersionCollisionError;
        expect(err.environmentId).toBe(environment.id);
        expect(err.attempts).toBe(1);
        expect(err.lastAttemptedVersion).toMatch(/^\d{8}\.\d+$/);
        expect((err.cause as { code?: string }).code).toBe("P2002");
      }
    }
  );
});
