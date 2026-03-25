import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { WorkerQueueManager } from "../workerQueue.js";
import { DefaultFairQueueKeyProducer } from "../keyProducer.js";
import type { FairQueueKeyProducer } from "../types.js";

describe("WorkerQueueManager", () => {
  let keys: FairQueueKeyProducer;

  describe("push and pop", () => {
    redisTest(
      "should push and pop a single message",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Push a message
        await manager.push("worker-1", "msg-1:queue-1");

        // Pop should return the message
        const result = await manager.pop("worker-1");
        expect(result).not.toBeNull();
        expect(result!.messageKey).toBe("msg-1:queue-1");
        expect(result!.queueLength).toBe(0);

        await manager.close();
      }
    );

    redisTest(
      "should push and pop messages in FIFO order",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Push messages
        await manager.push("worker-1", "msg-1:queue-1");
        await manager.push("worker-1", "msg-2:queue-1");
        await manager.push("worker-1", "msg-3:queue-1");

        // Pop should return in FIFO order
        let result = await manager.pop("worker-1");
        expect(result!.messageKey).toBe("msg-1:queue-1");
        expect(result!.queueLength).toBe(2);

        result = await manager.pop("worker-1");
        expect(result!.messageKey).toBe("msg-2:queue-1");
        expect(result!.queueLength).toBe(1);

        result = await manager.pop("worker-1");
        expect(result!.messageKey).toBe("msg-3:queue-1");
        expect(result!.queueLength).toBe(0);

        // Queue should be empty
        result = await manager.pop("worker-1");
        expect(result).toBeNull();

        await manager.close();
      }
    );

    redisTest("should push batch of messages", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const manager = new WorkerQueueManager({
        redis: redisOptions,
        keys,
      });

      // Push batch
      await manager.pushBatch("worker-1", ["msg-1:queue-1", "msg-2:queue-1", "msg-3:queue-1"]);

      // Check length
      const length = await manager.getLength("worker-1");
      expect(length).toBe(3);

      await manager.close();
    });
  });

  describe("getLength", () => {
    redisTest(
      "should return correct queue length",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Initially empty
        let length = await manager.getLength("worker-1");
        expect(length).toBe(0);

        // Push messages
        await manager.push("worker-1", "msg-1:queue-1");
        await manager.push("worker-1", "msg-2:queue-1");

        length = await manager.getLength("worker-1");
        expect(length).toBe(2);

        // Pop one
        await manager.pop("worker-1");

        length = await manager.getLength("worker-1");
        expect(length).toBe(1);

        await manager.close();
      }
    );
  });

  describe("peek", () => {
    redisTest(
      "should peek at messages without removing them",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Push messages
        await manager.push("worker-1", "msg-1:queue-1");
        await manager.push("worker-1", "msg-2:queue-1");

        // Peek
        const messages = await manager.peek("worker-1");
        expect(messages).toEqual(["msg-1:queue-1", "msg-2:queue-1"]);

        // Messages should still be there
        const length = await manager.getLength("worker-1");
        expect(length).toBe(2);

        await manager.close();
      }
    );
  });

  describe("remove", () => {
    redisTest("should remove a specific message", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const manager = new WorkerQueueManager({
        redis: redisOptions,
        keys,
      });

      // Push messages
      await manager.push("worker-1", "msg-1:queue-1");
      await manager.push("worker-1", "msg-2:queue-1");
      await manager.push("worker-1", "msg-3:queue-1");

      // Remove the middle one
      const removed = await manager.remove("worker-1", "msg-2:queue-1");
      expect(removed).toBe(1);

      // Check remaining
      const messages = await manager.peek("worker-1");
      expect(messages).toEqual(["msg-1:queue-1", "msg-3:queue-1"]);

      await manager.close();
    });
  });

  describe("clear", () => {
    redisTest(
      "should clear all messages from queue",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Push messages
        await manager.push("worker-1", "msg-1:queue-1");
        await manager.push("worker-1", "msg-2:queue-1");

        // Clear
        await manager.clear("worker-1");

        // Should be empty
        const length = await manager.getLength("worker-1");
        expect(length).toBe(0);

        await manager.close();
      }
    );
  });

  describe("separate worker queues", () => {
    redisTest(
      "should maintain separate queues for different workers",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Push to different worker queues
        await manager.push("worker-1", "msg-1-1:queue-1");
        await manager.push("worker-2", "msg-2-1:queue-1");
        await manager.push("worker-1", "msg-1-2:queue-1");
        await manager.push("worker-2", "msg-2-2:queue-1");

        // Each worker should have its own messages
        const worker1Messages = await manager.peek("worker-1");
        expect(worker1Messages).toEqual(["msg-1-1:queue-1", "msg-1-2:queue-1"]);

        const worker2Messages = await manager.peek("worker-2");
        expect(worker2Messages).toEqual(["msg-2-1:queue-1", "msg-2-2:queue-1"]);

        await manager.close();
      }
    );
  });
});
