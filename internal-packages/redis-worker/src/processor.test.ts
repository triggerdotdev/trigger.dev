import { expect, it } from "vitest";
import { z } from "zod";
import { redisTest } from "@internal/testcontainers";
import { SimpleQueue } from "./queue.js";
import { describe } from "node:test";
import { createQueueProcessor } from "./processor.js";

describe("SimpleQueue processor", () => {
  redisTest("Read items", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "processor-1",
      schema: z.object({
        value: z.number(),
      }),
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
    });

    try {
      let itemCount = 10;
      for (let i = 0; i < itemCount; i++) {
        await queue.enqueue(i.toString(), { value: i });
      }

      let itemsProcessed = 0;

      const processor = createQueueProcessor(queue, {
        onItem: async (id, item) => {
          expect(item).toEqual({ value: parseInt(id) });
          itemsProcessed++;
        },
      });

      processor.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(itemsProcessed).toEqual(itemCount);
      processor.stop();
    } finally {
      await queue.close();
    }
  });

  redisTest("Retrying", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "processor-2",
      schema: z.object({
        value: z.number(),
      }),
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
    });

    try {
      await queue.enqueue("1", { value: 1 });

      let attempts = 0;
      let itemsProcessed = 0;

      const processor = createQueueProcessor(queue, {
        retry: {
          delay: {
            initial: 10,
            factor: 1,
          },
          maxAttempts: 2,
        },
        onItem: async (id, item) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("Test retry");
          }
          expect(item).toEqual({ value: parseInt(id) });
          itemsProcessed++;
        },
      });

      processor.start();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(itemsProcessed).toEqual(1);
      processor.stop();
    } finally {
      await queue.close();
    }
  });
});
