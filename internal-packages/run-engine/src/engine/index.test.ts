import { expect } from "vitest";
import { containerTest } from "../test/containerTest.js";
import { RunEngine } from "./index.js";
import { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";

describe("RunEngine", () => {
  containerTest(
    "Trigger a run",
    { timeout: 15_000 },
    async ({ postgresContainer, prisma, redisContainer }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        redis: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
          enableAutoPipelining: true,
        },
        zodWorker: {
          connectionString: postgresContainer.getConnectionUri(),
          shutdownTimeoutInMs: 100,
        },
      });

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_1234",
          environment: authenticatedEnvironment,
          taskIdentifier: "test-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queueName: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      expect(run).toBeDefined();
      expect(run.friendlyId).toBe("run_1234");

      //check the waitpoint is created
      const runWaitpoint = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpoint.length).toBe(1);
      expect(runWaitpoint[0].type).toBe("RUN");

      //check the queue length
      const queueLength = await engine.runQueue.lengthOfQueue(authenticatedEnvironment, run.queue);
      expect(queueLength).toBe(1);

      //dequeue the run
      const dequeued = await engine.runQueue.dequeueMessageInSharedQueue(
        "test_12345",
        run.masterQueue
      );
      expect(dequeued?.messageId).toBe(run.id);
    }
  );
});

async function setupAuthenticatedEnvironment(prisma: PrismaClient, type: RuntimeEnvironmentType) {
  // Your database setup logic here
  const org = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: org.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: "slug",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key",
      pkApiKey: "pk_api_key",
      shortcode: "short_code",
    },
  });

  return await prisma.runtimeEnvironment.findUniqueOrThrow({
    where: {
      id: environment.id,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });
}
