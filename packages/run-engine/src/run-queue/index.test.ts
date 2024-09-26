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

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  keysProducer: new RunQueueShortKeyProducer("rq:"),
  queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
  envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
  workers: 1,
  defaultEnvConcurrency: 10,
  enableRebalancing: false,
  logger: new Logger("RunQueue", "debug"),
};

const authenticatedEnv = {
  id: "e1234",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  project: { id: "p1234" },
  organization: { id: "o1234" },
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
        const initial = await queue.getQueueConcurrencyLimit(authenticatedEnv, "task/my-task");
        expect(initial).toBe(undefined);

        //set 20
        const result = await queue.updateQueueConcurrencyLimits(
          authenticatedEnv,
          "task/my-task",
          20
        );
        expect(result).toBe("OK");

        //get 20
        const updated = await queue.getQueueConcurrencyLimit(authenticatedEnv, "task/my-task");
        expect(updated).toBe(20);

        //remove
        const result2 = await queue.removeQueueConcurrencyLimits(authenticatedEnv, "task/my-task");
        expect(result2).toBe(1);

        //get undefined
        const removed = await queue.getQueueConcurrencyLimit(authenticatedEnv, "task/my-task");
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
        const initial = await queue.getEnvConcurrencyLimit(authenticatedEnv);
        expect(initial).toBe(10);

        //set 20
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnv,
          maximumConcurrencyLimit: 20,
        });

        //get 20
        const updated = await queue.getEnvConcurrencyLimit(authenticatedEnv);
        expect(updated).toBe(20);
      } finally {
        await queue.quit();
      }
    }
  );
});
