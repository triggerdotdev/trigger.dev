import { redisTest } from "@internal/testcontainers";
import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { SimpleQueue } from "./queue.js";
import { Logger } from "@trigger.dev/core/logger";

describe("SimpleQueue", () => {
  redisTest("enqueue/dequeue", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-1",
      schema: {
        test: {
          schema: z.object({
            value: z.number(),
          }),
          defaultVisibilityTimeoutMs: 2000,
        },
      },
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await queue.enqueue({ id: "1", job: "test", item: { value: 1 } });
      expect(await queue.size()).toBe(1);

      await queue.enqueue({ id: "2", job: "test", item: { value: 2 } });
      expect(await queue.size()).toBe(2);

      const first = await queue.dequeue();
      expect(first).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 2000,
      });
      expect(await queue.size()).toBe(1);
      expect(await queue.size({ includeFuture: true })).toBe(2);

      await queue.ack(first!.id);
      expect(await queue.size({ includeFuture: true })).toBe(1);

      const second = await queue.dequeue();
      expect(second).toEqual({
        id: "2",
        job: "test",
        item: { value: 2 },
        visibilityTimeoutMs: 2000,
      });

      await queue.ack(second!.id);
      expect(await queue.size({ includeFuture: true })).toBe(0);
    } finally {
      await queue.close();
    }
  });

  redisTest("no items", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-1",
      schema: {
        test: {
          schema: z.object({
            value: z.number(),
          }),
          defaultVisibilityTimeoutMs: 2000,
        },
      },
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      const missOne = await queue.dequeue();
      expect(missOne).toBeNull();

      await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 2000 });
      const hitOne = await queue.dequeue();
      expect(hitOne).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 2000,
      });

      const missTwo = await queue.dequeue();
      expect(missTwo).toBeNull();
    } finally {
      await queue.close();
    }
  });

  redisTest("future item", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-1",
      schema: {
        test: {
          schema: z.object({
            value: z.number(),
          }),
          defaultVisibilityTimeoutMs: 2000,
        },
      },
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await queue.enqueue({
        id: "1",
        job: "test",
        item: { value: 1 },
        availableAt: new Date(Date.now() + 50),
      });

      const miss = await queue.dequeue();
      expect(miss).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const first = await queue.dequeue();
      expect(first).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 2000,
      });
    } finally {
      await queue.close();
    }
  });

  redisTest("invisibility timeout", { timeout: 20_000 }, async ({ redisContainer }) => {
    const queue = new SimpleQueue({
      name: "test-1",
      schema: {
        test: {
          schema: z.object({
            value: z.number(),
          }),
          defaultVisibilityTimeoutMs: 2000,
        },
      },
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      logger: new Logger("test", "log"),
    });

    try {
      await queue.enqueue({ id: "1", job: "test", item: { value: 1 }, visibilityTimeoutMs: 1_000 });

      const first = await queue.dequeue();
      expect(first).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 1_000,
      });

      const missImmediate = await queue.dequeue();
      expect(missImmediate).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const second = await queue.dequeue();
      expect(second).toEqual({
        id: "1",
        job: "test",
        item: { value: 1 },
        visibilityTimeoutMs: 1_000,
      });
    } finally {
      await queue.close();
    }
  });
});
