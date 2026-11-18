import { containerTest } from "@internal/testcontainers";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import type { CreateBackgroundWorkerRequestBody, TaskResource } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { NoopTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { CreateDeploymentBackgroundWorkerServiceV4 } from "~/v3/services/createDeploymentBackgroundWorkerV4.server";

vi.setConfig({ testTimeout: 30_000 });

async function seedDeployment(prisma: PrismaClient, cliVersion: string | null) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const suffix = Math.random().toString(36).slice(2, 10);

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${suffix}`,
      shortCode: suffix,
      contentHash: `hash_${suffix}`,
      status: "BUILDING",
      version: "20260529.1",
      projectId: environment.projectId,
      environmentId: environment.id,
      cliVersion,
    },
  });

  return { environment, deployment };
}

function manifest(
  cliPackageVersion: string | undefined,
  tasks: TaskResource[] = []
): CreateBackgroundWorkerRequestBody {
  return {
    localOnly: false,
    metadata: {
      contentHash: `hash_${Math.random().toString(36).slice(2, 10)}`,
      packageVersion: "4.1.0",
      cliPackageVersion,
      tasks,
      queues: [],
      sourceFiles: [],
      runtime: "node",
      runtimeVersion: "24.0.0",
    },
    engine: "V2",
    supportsLazyAttempts: true,
  };
}

function service(prisma: PrismaClient) {
  return new CreateDeploymentBackgroundWorkerServiceV4(
    prisma,
    prisma,
    new NoopTaskMetadataCache(),
    undefined,
    null
  );
}

async function registerWorker(
  prisma: PrismaClient,
  cliVersionAtInit: string | null,
  cliPackageVersion: string | undefined
) {
  const { environment, deployment } = await seedDeployment(prisma, cliVersionAtInit);

  await service(prisma).call(environment, deployment.friendlyId, manifest(cliPackageVersion));

  return prisma.workerDeployment.findFirstOrThrow({ where: { id: deployment.id } });
}

describe("CreateDeploymentBackgroundWorkerServiceV4 cliVersion", () => {
  // Catches: a deploy initialized without a CLI version never getting one recorded.
  containerTest(
    "stamps the manifest's CLI version on a deployment initialized without one",
    async ({ prisma }) => {
      const deployment = await registerWorker(prisma, null, "4.8.2");

      expect(deployment.status).toBe("DEPLOYING");
      expect(deployment.workerId).toBeTruthy();
      expect(deployment.cliVersion).toBe("4.8.2");
    }
  );

  // Catches: worker registration overwriting the CLI version recorded at initialization.
  containerTest("keeps the CLI version stamped at initialization", async ({ prisma }) => {
    const deployment = await registerWorker(prisma, "4.7.0", "4.8.2");

    expect(deployment.status).toBe("DEPLOYING");
    expect(deployment.cliVersion).toBe("4.7.0");
  });

  // Catches: a manifest without a CLI version failing registration or storing a value.
  containerTest("leaves the CLI version null when the manifest has none", async ({ prisma }) => {
    const deployment = await registerWorker(prisma, null, undefined);

    expect(deployment.status).toBe("DEPLOYING");
    expect(deployment.cliVersion).toBeNull();
  });

  // Catches: the manifest storing a CLI version longer than initialization accepts.
  containerTest("ignores an over-long manifest CLI version", async ({ prisma }) => {
    const deployment = await registerWorker(prisma, null, "4".repeat(129));

    expect(deployment.status).toBe("DEPLOYING");
    expect(deployment.cliVersion).toBeNull();
  });

  // Catches: a deployment failed during worker registration losing the manifest's CLI version.
  containerTest(
    "stamps the manifest's CLI version when worker registration fails",
    async ({ prisma }) => {
      const { environment, deployment } = await seedDeployment(prisma, null);
      const duplicateTask = { id: "dup", filePath: "src/dup.ts" };

      await expect(
        service(prisma).call(
          environment,
          deployment.friendlyId,
          manifest("4.8.2", [duplicateTask, duplicateTask])
        )
      ).rejects.toBeInstanceOf(ServiceValidationError);

      const failed = await prisma.workerDeployment.findFirstOrThrow({
        where: { id: deployment.id },
      });
      expect(failed.status).toBe("FAILED");
      expect(failed.cliVersion).toBe("4.8.2");
    }
  );
});
