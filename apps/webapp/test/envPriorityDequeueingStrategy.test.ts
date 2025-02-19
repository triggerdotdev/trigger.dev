import { describe, expect, it } from "vitest";
import type { EnvQueues, MarQSFairDequeueStrategy } from "~/v3/marqs/types.js";
import { EnvPriorityDequeuingStrategy } from "../app/v3/marqs/envPriorityDequeuingStrategy.server.js";
import { createKeyProducer } from "./utils/marqs.js";

const keyProducer = createKeyProducer("test");

describe("EnvPriorityDequeuingStrategy", () => {
  class TestDelegate implements MarQSFairDequeueStrategy {
    constructor(private queues: EnvQueues[]) {}

    async distributeFairQueuesFromParentQueue(): Promise<Array<EnvQueues>> {
      return this.queues;
    }
  }

  describe("distributeFairQueuesFromParentQueue", () => {
    it("should preserve order when all queues have the same priority", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue2:priority:1",
            "org:org1:env:env1:queue:queue3:priority:1",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result).toEqual(inputQueues);
      expect(result[0].queues).toEqual(inputQueues[0].queues);
    });

    it("should sort queues by priority in descending order", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue2:priority:3",
            "org:org1:env:env1:queue:queue3:priority:2",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:3",
        "org:org1:env:env1:queue:queue3:priority:2",
        "org:org1:env:env1:queue:queue1:priority:1",
      ]);
    });

    it("should handle queues without priority by treating them as priority 0", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1",
            "org:org1:env:env1:queue:queue2:priority:2",
            "org:org1:env:env1:queue:queue3",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:2",
        "org:org1:env:env1:queue:queue1",
        "org:org1:env:env1:queue:queue3",
      ]);
    });

    it("should handle multiple environments", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue2:priority:2",
          ],
        },
        {
          envId: "env2",
          queues: [
            "org:org1:env:env2:queue:queue3:priority:3",
            "org:org1:env:env2:queue:queue4:priority:1",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result).toHaveLength(2);
      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:2",
        "org:org1:env:env1:queue:queue1:priority:1",
      ]);
      expect(result[1].queues).toEqual([
        "org:org1:env:env2:queue:queue3:priority:3",
        "org:org1:env:env2:queue:queue4:priority:1",
      ]);
    });

    it("should handle negative priorities correctly", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:-1",
            "org:org1:env:env1:queue:queue2:priority:1",
            "org:org1:env:env1:queue:queue3:priority:-2",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:1",
        "org:org1:env:env1:queue:queue1:priority:-1",
        "org:org1:env:env1:queue:queue3:priority:-2",
      ]);
    });

    it("should maintain stable sort for mixed priority and non-priority queues", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1",
            "org:org1:env:env1:queue:queue2:priority:1",
            "org:org1:env:env1:queue:queue3",
            "org:org1:env:env1:queue:queue4:priority:1",
            "org:org1:env:env1:queue:queue5",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      // Check that queue2 and queue4 (priority 1) maintain their relative order
      // and queue1, queue3, and queue5 (priority 0) maintain their relative order
      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:1",
        "org:org1:env:env1:queue:queue4:priority:1",
        "org:org1:env:env1:queue:queue1",
        "org:org1:env:env1:queue:queue3",
        "org:org1:env:env1:queue:queue5",
      ]);
    });

    it("should handle empty queue arrays", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result).toEqual(inputQueues);
      expect(result[0].queues).toEqual([]);
    });

    it("should handle empty environments array", async () => {
      const inputQueues: EnvQueues[] = [];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result).toEqual([]);
    });

    it("should handle large priority differences", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue2:priority:1000",
            "org:org1:env:env1:queue:queue3:priority:500",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:1000",
        "org:org1:env:env1:queue:queue3:priority:500",
        "org:org1:env:env1:queue:queue1:priority:1",
      ]);
    });

    it("should handle multiple environments with mixed priority patterns", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1", // priority 0
            "org:org1:env:env1:queue:queue2:priority:2",
          ],
        },
        {
          envId: "env2",
          queues: [
            "org:org1:env:env2:queue:queue3:priority:1",
            "org:org1:env:env2:queue:queue4", // priority 0
          ],
        },
        {
          envId: "env3",
          queues: [
            "org:org1:env:env3:queue:queue5:priority:1",
            "org:org1:env:env3:queue:queue6:priority:1",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result).toHaveLength(3);
      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:priority:2",
        "org:org1:env:env1:queue:queue1",
      ]);
      expect(result[1].queues).toEqual([
        "org:org1:env:env2:queue:queue3:priority:1",
        "org:org1:env:env2:queue:queue4",
      ]);
      expect(result[2].queues).toEqual([
        "org:org1:env:env3:queue:queue5:priority:1",
        "org:org1:env:env3:queue:queue6:priority:1",
      ]);
    });

    it("should sort queues with concurrency keys while maintaining priority order", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:ck:key1:priority:1",
            "org:org1:env:env1:queue:queue2:ck:key1:priority:3",
            "org:org1:env:env1:queue:queue3:ck:key2:priority:2",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue2:ck:key1:priority:3",
        "org:org1:env:env1:queue:queue3:ck:key2:priority:2",
        "org:org1:env:env1:queue:queue1:ck:key1:priority:1",
      ]);
    });

    it("should handle mixed queues with and without concurrency keys", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue2:ck:shared-key:priority:2",
            "org:org1:env:env1:queue:queue3:ck:shared-key:priority:1",
            "org:org1:env:env1:queue:queue4:priority:3",
            "org:org1:env:env1:queue:queue5:ck:other-key:priority:2",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue4:priority:3",
        "org:org1:env:env1:queue:queue2:ck:shared-key:priority:2",
        "org:org1:env:env1:queue:queue5:ck:other-key:priority:2",
        "org:org1:env:env1:queue:queue1:priority:1",
        "org:org1:env:env1:queue:queue3:ck:shared-key:priority:1",
      ]);
    });

    it("should only return the highest priority queue of the same queue", async () => {
      const inputQueues: EnvQueues[] = [
        {
          envId: "env1",
          queues: [
            "org:org1:env:env1:queue:queue1",
            "org:org1:env:env1:queue:queue1:priority:1",
            "org:org1:env:env1:queue:queue1:priority:2",
            "org:org1:env:env1:queue:queue1:priority:3",
            "org:org1:env:env1:queue:queue2",
          ],
        },
      ];

      const delegate = new TestDelegate(inputQueues);
      const strategy = new EnvPriorityDequeuingStrategy({
        delegate,
        keys: keyProducer,
      });

      const result = await strategy.distributeFairQueuesFromParentQueue("parentQueue", "consumer1");

      expect(result[0].queues).toEqual([
        "org:org1:env:env1:queue:queue1:priority:3",
        "org:org1:env:env1:queue:queue2",
      ]);
    });
  });
});
