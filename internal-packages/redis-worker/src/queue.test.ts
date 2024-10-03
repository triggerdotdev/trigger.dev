import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { redisTest } from "@internal/testcontainers";
import { SimpleQueue } from "./queue.js";

describe("SimpleQueue", () => {
  redisTest("enqueue/dequeue", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-1",
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
      await queue.enqueue("2", { value: 2 });

      const first = await queue.dequeue();
      expect(first).toEqual({ id: "1", item: { value: 1 } });

      const second = await queue.dequeue();
      expect(second).toEqual({ id: "2", item: { value: 2 } });
    } finally {
      await queue.close();
    }
  });

  redisTest("no items", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-2",
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
      const missOne = await queue.dequeue();
      expect(missOne).toBeNull();

      await queue.enqueue("1", { value: 1 });
      const hitOne = await queue.dequeue();
      expect(hitOne).toEqual({ id: "1", item: { value: 1 } });

      const missTwo = await queue.dequeue();
      expect(missTwo).toBeNull();
    } finally {
      await queue.close();
    }
  });

  redisTest("future item", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-3",
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
      await queue.enqueue("1", { value: 1 }, new Date(Date.now() + 50));

      const miss = await queue.dequeue();
      expect(miss).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const first = await queue.dequeue();
      expect(first).toEqual({ id: "1", item: { value: 1 } });
    } finally {
      await queue.close();
    }
  });
});
