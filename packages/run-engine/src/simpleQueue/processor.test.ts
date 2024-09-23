import { expect, it } from "vitest";
import { z } from "zod";
import { redisTest } from "../test/containerTest";
import { SimpleQueue } from "./index";
import { describe } from "node:test";
import { createQueueProcessor } from "./processor";

describe("SimpleQueue processor", () => {
  redisTest("Read 5 items", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue(
      "test-1",
      z.object({
        value: z.number(),
      }),
      {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      }
    );

    try {
      //add 50 items to the queue
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
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(itemsProcessed).toEqual(itemCount);
      processor.stop();
    } finally {
      await queue.close();
    }
  });
});
