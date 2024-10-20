import { redisTest } from "@internal/testcontainers";
import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { MessageQueue } from "./queue.js";
import { Logger } from "@trigger.dev/core/logger";

describe("MessageQueue", () => {
  redisTest("publish/consume", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new MessageQueue({
      name: "test-1",
      schema: {
        test: z.object({
          value: z.number(),
        }),
      },
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await queue.publish({
        key: "a",
        valueType: "test",
        value: { value: 1 },
        visibilityTimeoutMs: 2000,
      });
      await queue.publish({
        key: "a",
        valueType: "test",
        value: { value: 2 },
        visibilityTimeoutMs: 2000,
      });
      await queue.publish({
        key: "b",
        valueType: "test",
        value: { value: 3 },
        visibilityTimeoutMs: 2000,
      });
      await queue.publish({
        key: "b",
        valueType: "test",
        value: { value: 4 },
        visibilityTimeoutMs: 2000,
      });
      //todo
      // expect(await queue.size()).toBe(4);

      const items = await queue.consume({ keys: ["a", "b"], count: 10 });
      expect(items.length).toBe(2);
      expect(items).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 2000,
        attempt: 0,
      });
      expect(await queue.size()).toBe(1);
      expect(await queue.size({ includeFuture: true })).toBe(2);

      // await queue.ack(first.id);
      // expect(await queue.size({ includeFuture: true })).toBe(1);

      // const [second] = await queue.dequeue(1);
      // expect(second).toEqual({
      //   id: "2",
      //   job: "test",
      //   item: { value: 2 },
      //   visibilityTimeoutMs: 2000,
      //   attempt: 0,
      // });

      // await queue.ack(second.id);
      // expect(await queue.size({ includeFuture: true })).toBe(0);
    } finally {
      await queue.close();
    }
  });

  // redisTest("no items", { timeout: 20_000 }, async ({ redisContainer }) => {
  //   const queue = new SimpleQueue({
  //     name: "test-1",
  //     schema: {
  //       test: z.object({
  //         value: z.number(),
  //       }),
  //     },
  //     redisOptions: {
  //       host: redisContainer.getHost(),
  //       port: redisContainer.getPort(),
  //       password: redisContainer.getPassword(),
  //     },
  //     logger: new Logger("test", "log"),
  //   });

  //   try {
  //     const missOne = await queue.dequeue(1);
  //     expect(missOne).toEqual([]);

  //     await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 2000 });
  //     const [hitOne] = await queue.dequeue(1);
  //     expect(hitOne).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });

  //     const missTwo = await queue.dequeue(1);
  //     expect(missTwo).toEqual([]);
  //   } finally {
  //     await queue.close();
  //   }
  // });

  // redisTest("future item", { timeout: 20_000 }, async ({ redisContainer }) => {
  //   const queue = new SimpleQueue({
  //     name: "test-1",
  //     schema: {
  //       test: z.object({
  //         value: z.number(),
  //       }),
  //     },
  //     redisOptions: {
  //       host: redisContainer.getHost(),
  //       port: redisContainer.getPort(),
  //       password: redisContainer.getPassword(),
  //     },
  //     logger: new Logger("test", "log"),
  //   });

  //   try {
  //     await queue.enqueue({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       availableAt: new Date(Date.now() + 50),
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });

  //     const miss = await queue.dequeue(1);
  //     expect(miss).toEqual([]);

  //     await new Promise((resolve) => setTimeout(resolve, 50));

  //     const [first] = await queue.dequeue();
  //     expect(first).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });
  //   } finally {
  //     await queue.close();
  //   }
  // });

  // redisTest("invisibility timeout", { timeout: 20_000 }, async ({ redisContainer }) => {
  //   const queue = new SimpleQueue({
  //     name: "test-1",
  //     schema: {
  //       test: z.object({
  //         value: z.number(),
  //       }),
  //     },
  //     redisOptions: {
  //       host: redisContainer.getHost(),
  //       port: redisContainer.getPort(),
  //       password: redisContainer.getPassword(),
  //     },
  //     logger: new Logger("test", "log"),
  //   });

  //   try {
  //     await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 1_000 });

  //     const [first] = await queue.dequeue();
  //     expect(first).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 1_000,
  //       attempt: 0,
  //     });

  //     const missImmediate = await queue.dequeue(1);
  //     expect(missImmediate).toEqual([]);

  //     await new Promise((resolve) => setTimeout(resolve, 1_000));

  //     const [second] = await queue.dequeue();
  //     expect(second).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 1_000,
  //       attempt: 0,
  //     });
  //   } finally {
  //     await queue.close();
  //   }
  // });

  // redisTest("dequeue multiple items", { timeout: 20_000 }, async ({ redisContainer }) => {
  //   const queue = new SimpleQueue({
  //     name: "test-1",
  //     schema: {
  //       test: z.object({
  //         value: z.number(),
  //       }),
  //     },
  //     redisOptions: {
  //       host: redisContainer.getHost(),
  //       port: redisContainer.getPort(),
  //       password: redisContainer.getPassword(),
  //     },
  //     logger: new Logger("test", "log"),
  //   });

  //   try {
  //     await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 2000 });
  //     await queue.enqueue({ id: "2", job: "test", item: { value: 2 }, visibilityTimeoutMs: 2000 });
  //     await queue.enqueue({ id: "3", job: "test", item: { value: 3 }, visibilityTimeoutMs: 2000 });

  //     expect(await queue.size()).toBe(3);

  //     const dequeued = await queue.dequeue(2);
  //     expect(dequeued).toHaveLength(2);
  //     expect(dequeued[0]).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });
  //     expect(dequeued[1]).toEqual({
  //       id: "2",
  //       job: "test",
  //       item: { value: 2 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });

  //     expect(await queue.size()).toBe(1);
  //     expect(await queue.size({ includeFuture: true })).toBe(3);

  //     await queue.ack(dequeued[0].id);
  //     await queue.ack(dequeued[1].id);

  //     expect(await queue.size({ includeFuture: true })).toBe(1);

  //     const [last] = await queue.dequeue(1);
  //     expect(last).toEqual({
  //       id: "3",
  //       job: "test",
  //       item: { value: 3 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });

  //     await queue.ack(last.id);
  //     expect(await queue.size({ includeFuture: true })).toBe(0);
  //   } finally {
  //     await queue.close();
  //   }
  // });

  // redisTest("Dead Letter Queue", { timeout: 20_000 }, async ({ redisContainer }) => {
  //   const queue = new SimpleQueue({
  //     name: "test-dlq",
  //     schema: {
  //       test: z.object({
  //         value: z.number(),
  //       }),
  //     },
  //     redisOptions: {
  //       host: redisContainer.getHost(),
  //       port: redisContainer.getPort(),
  //       password: redisContainer.getPassword(),
  //     },
  //     logger: new Logger("test", "log"),
  //   });

  //   try {
  //     // Enqueue an item
  //     await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 2000 });
  //     expect(await queue.size()).toBe(1);
  //     expect(await queue.sizeOfDeadLetterQueue()).toBe(0);

  //     // Move item to DLQ
  //     await queue.moveToDeadLetterQueue("1", "Test error message");
  //     expect(await queue.size()).toBe(0);
  //     expect(await queue.sizeOfDeadLetterQueue()).toBe(1);

  //     // Attempt to dequeue from the main queue should return empty
  //     const dequeued = await queue.dequeue(1);
  //     expect(dequeued).toEqual([]);

  //     // Redrive item from DLQ
  //     await queue.redriveFromDeadLetterQueue("1");
  //     expect(await queue.size()).toBe(1);
  //     expect(await queue.sizeOfDeadLetterQueue()).toBe(0);

  //     // Dequeue the redriven item
  //     const [redrivenItem] = await queue.dequeue(1);
  //     expect(redrivenItem).toEqual({
  //       id: "1",
  //       job: "test",
  //       item: { value: 1 },
  //       visibilityTimeoutMs: 2000,
  //       attempt: 0,
  //     });

  //     // Acknowledge the item
  //     await queue.ack(redrivenItem.id);
  //     expect(await queue.size()).toBe(0);
  //     expect(await queue.sizeOfDeadLetterQueue()).toBe(0);
  //   } finally {
  //     await queue.close();
  //   }
  // });
});
