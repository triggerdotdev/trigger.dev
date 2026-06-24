import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment } from "./setup.js";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";

vi.setConfig({ testTimeout: 60_000 });

const WORKER_QUEUE_LENGTH_METRIC = "runqueue.workerQueue.length";
const WORKER_QUEUE_ATTRIBUTE = "runqueue.workerQueue";

describe("RunEngine worker queue observation", () => {
  containerTest(
    "reports worker queue length from WorkerInstanceGroup records without any dequeue",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();

      // Seeds a MANAGED WorkerInstanceGroup with masterQueue "default" (no cloud provider).
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // A hidden worker group should still be observed.
      await prisma.workerInstanceGroup.create({
        data: {
          name: "hidden-region",
          masterQueue: "hidden-region",
          type: "MANAGED",
          hidden: true,
          cloudProvider: "aws",
          token: { create: { tokenHash: "hidden_region_token_hash" } },
        },
      });

      // A DigitalOcean worker group should be excluded from observation.
      await prisma.workerInstanceGroup.create({
        data: {
          name: "do-region",
          masterQueue: "do-region",
          type: "MANAGED",
          hidden: true,
          cloudProvider: "digitalocean",
          token: { create: { tokenHash: "do_region_token_hash" } },
        },
      });

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        meter,
        workerQueueObserver: {
          enabled: true,
          intervalMs: 60_000,
          additionalQueueSuffixes: [":scheduled"],
          excludedCloudProviders: ["digitalocean"],
        },
      });

      const enqueueTo = async (workerQueue: string, count: number, prefix: string) => {
        for (let i = 0; i < count; i++) {
          await engine.runQueue.enqueueMessage({
            env: authenticatedEnvironment,
            message: {
              runId: `${prefix}_${i}`,
              taskIdentifier: "task/my-task",
              orgId: authenticatedEnvironment.organization.id,
              projectId: authenticatedEnvironment.project.id,
              environmentId: authenticatedEnvironment.id,
              environmentType: "PRODUCTION",
              queue: "task/my-task",
              timestamp: Date.now(),
              attempt: 0,
            },
            workerQueue,
            skipDequeueProcessing: true,
          });
        }
      };

      const lengthOf = (workerQueue: string) =>
        getCounterValue(WORKER_QUEUE_LENGTH_METRIC, {
          [WORKER_QUEUE_ATTRIBUTE]: workerQueue,
        });

      try {
        // Keep the total under the environment concurrency limit (10) so every message moves
        // into its worker queue list (processMasterQueueForEnvironment is concurrency-gated).
        const defaultBacklog = 3;
        const scheduledBacklog = 2;
        const hiddenBacklog = 2;
        const doBacklog = 2;

        // Build a backlog across several worker queues, then move them into the worker queue
        // lists, but never dequeue.
        await enqueueTo("default", defaultBacklog, "r_default");
        await enqueueTo("default:scheduled", scheduledBacklog, "r_scheduled");
        await enqueueTo("hidden-region", hiddenBacklog, "r_hidden");
        await enqueueTo("do-region", doBacklog, "r_do");
        await engine.runQueue.processMasterQueueForEnvironment(
          authenticatedEnvironment.id,
          defaultBacklog + scheduledBacklog + hiddenBacklog + doBacklog
        );

        // Observe the worker queues derived from the WorkerInstanceGroup records. No dequeue
        // has happened, so this is the only thing that registers them for observation.
        await engine.refreshWorkerQueueObservation();

        // Reported: the default queue, its scheduled split variant, and the hidden group.
        expect(await lengthOf("default")).toBe(defaultBacklog);
        expect(await lengthOf("default:scheduled")).toBe(scheduledBacklog);
        expect(await lengthOf("hidden-region")).toBe(hiddenBacklog);

        // Excluded: the DigitalOcean group is not observed even though it has a backlog.
        expect(await lengthOf("do-region")).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
