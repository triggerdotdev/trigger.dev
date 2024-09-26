import {
  Span,
  SpanKind,
  SpanOptions,
  Tracer,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import { describe } from "node:test";
import { redisTest } from "../test/containerTest.js";
import { RunQueue } from "./index.js";
import { RunQueueShortKeyProducer } from "./keyProducer.js";
import { SimpleWeightedChoiceStrategy } from "./simpleWeightedPriorityStrategy.js";
import { logger } from "@trigger.dev/core/v3";
import { Logger } from "@trigger.dev/core/logger";
import { MessagePayload } from "./types.js";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  keysProducer: new RunQueueShortKeyProducer("rq:"),
  queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
  envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
  workers: 1,
  defaultEnvConcurrency: 10,
  enableRebalancing: false,
  logger: new Logger("RunQueue", "warn"),
};

const authenticatedEnvProd = {
  id: "e1234",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const messageProd: MessagePayload = {
  version: "1" as const,
  runId: "r1234",
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e1234",
  environmentType: "PRODUCTION",
  queue: "task/my-task",
  timestamp: Date.now(),
};

const messageDev: MessagePayload = {
  version: "1" as const,
  runId: "r4321",
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e4321",
  environmentType: "DEVELOPMENT",
  queue: "task/my-task",
  timestamp: Date.now(),
};

describe("RunQueue", () => {
  redisTest(
    "Get/set Queue concurrency limit",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        //initial value
        const initial = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
        expect(initial).toBe(undefined);

        //set 20
        const result = await queue.updateQueueConcurrencyLimits(
          authenticatedEnvProd,
          "task/my-task",
          20
        );
        expect(result).toBe("OK");

        //get 20
        const updated = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
        expect(updated).toBe(20);

        //remove
        const result2 = await queue.removeQueueConcurrencyLimits(
          authenticatedEnvProd,
          "task/my-task"
        );
        expect(result2).toBe(1);

        //get undefined
        const removed = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
        expect(removed).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Update env concurrency limits",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        //initial value
        const initial = await queue.getEnvConcurrencyLimit(authenticatedEnvProd);
        expect(initial).toBe(10);

        //set 20
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvProd,
          maximumConcurrencyLimit: 20,
        });

        //get 20
        const updated = await queue.getEnvConcurrencyLimit(authenticatedEnvProd);
        expect(updated).toBe(20);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Enqueue/Dequeue a message in env (no concurrency key)",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        const result = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result).toBe(0);

        const oldestScore = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
        expect(oldestScore).toBe(undefined);

        await queue.enqueueMessage({ env: authenticatedEnvDev, message: messageDev });

        const result2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result2).toBe(1);

        const oldestScore2 = await queue.oldestMessageInQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(oldestScore2).toBe(messageDev.timestamp);

        const dequeued = await queue.dequeueMessageInEnv(authenticatedEnvDev);
        expect(dequeued?.messageId).toEqual(messageDev.runId);
      } finally {
        await queue.quit();
      }
    }
  );
});
