import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import type { PrismaClient, WorkerDeploymentStatus } from "@trigger.dev/database";
import type { DeploymentChecksController } from "@trigger.dev/plugins";
import type { RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const DIGEST = `sha256:${"d".repeat(64)}`;

// Finalize publishes to the project pub/sub, which reads its Redis from the env at import, so the
// env must point at the container BEFORE the modules load. Hence dynamic imports; vitest runs each
// file in its own fork, so the change can't leak into other suites.
async function load(redisOptions: RedisOptions) {
  process.env.REDIS_HOST = redisOptions.host;
  process.env.REDIS_PORT = String(redisOptions.port);
  process.env.REDIS_TLS_DISABLED = "true";
  const [finalize, environments, checks] = await Promise.all([
    import("~/v3/services/finalizeDeployment.server"),
    import("~/models/runtimeEnvironment.server"),
    import("~/v3/deploymentChecks.server"),
  ]);
  return { ...finalize, ...environments, ...checks };
}

type Loaded = Awaited<ReturnType<typeof load>>;

async function seed(prisma: PrismaClient, loaded: Loaded, status: WorkerDeploymentStatus) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: uniqueId("worker"),
      contentHash: uniqueId("hash"),
      version: "20260101.1",
      metadata: {},
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: uniqueId("deployment"),
      shortCode: uniqueId("short"),
      contentHash: uniqueId("hash"),
      version: "20260101.1",
      projectId: project.id,
      environmentId: environment.id,
      workerId: worker.id,
      status,
      imageReference: "registry.example.com/deployments/proj_test:20260101.1.prod",
    },
  });
  const authenticated = loaded.toAuthenticated(
    await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: environment.id },
      include: loaded.authIncludeBase,
    })
  );
  return { deployment, authenticated };
}

describe("finalize and deployment checks", () => {
  containerTestWithIsolatedRedis(
    "queues a check only once the deployment is DEPLOYED, and never on a repeat or a refused finalize",
    async ({ prisma, redisOptions }) => {
      // Catches: a check queued before the guarded DEPLOYED write, again on a repeated finalize,
      // or for a deployment that never finished.
      const loaded = await load(redisOptions);
      const queue = loaded.createDeploymentChecksWorker({
        redisOptions,
        concurrency: { workers: 1, tasksPerWorker: 1, limit: 1 },
        shutdownTimeoutMs: 1_000,
      });
      const plugin: DeploymentChecksController = {
        decide: async () => ({ plan: "skip", selectedBy: "off" }),
        check: async () => ({ outcome: "pass", id: "check_1", retryable: false }),
      };
      const calls: Array<{ deploymentId: string; status?: WorkerDeploymentStatus }> = [];
      const pending: Promise<void>[] = [];
      const service = new loaded.FinalizeDeploymentService(prisma, (deploymentId) => {
        const queued = (async () => {
          const row = await prisma.workerDeployment.findFirst({ where: { id: deploymentId } });
          calls.push({ deploymentId, status: row?.status });
          await loaded.enqueueDeploymentCheck(queue, deploymentId, async () => plugin);
        })();
        pending.push(queued);
        return queued;
      });

      try {
        const finishing = await seed(prisma, loaded, "DEPLOYING");
        await service.call(finishing.authenticated, finishing.deployment.friendlyId, {
          skipPromotion: true,
          imageDigest: DIGEST,
        });
        await service.call(finishing.authenticated, finishing.deployment.friendlyId, {
          skipPromotion: true,
          imageDigest: DIGEST,
        });

        const failed = await seed(prisma, loaded, "FAILED");
        await expect(
          service.call(failed.authenticated, failed.deployment.friendlyId, {
            skipPromotion: true,
          })
        ).rejects.toThrow("not in DEPLOYING status");

        await Promise.all(pending);

        expect(calls).toEqual([{ deploymentId: finishing.deployment.id, status: "DEPLOYED" }]);
        expect(await queue.queue.size()).toBe(1);
      } finally {
        await queue.stop();
      }
    }
  );
});
