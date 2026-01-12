import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { ConcurrencyManager } from "../concurrency.js";
import { DefaultFairQueueKeyProducer } from "../keyProducer.js";
import type { FairQueueKeyProducer, QueueDescriptor } from "../types.js";

describe("ConcurrencyManager", () => {
  let keys: FairQueueKeyProducer;

  describe("single group concurrency", () => {
    redisTest(
      "should allow processing when under limit",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        const result = await manager.canProcess(queue);
        expect(result.allowed).toBe(true);

        await manager.close();
      }
    );

    redisTest("should block when at capacity", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const manager = new ConcurrencyManager({
        redis: redisOptions,
        keys,
        groups: [
          {
            name: "tenant",
            extractGroupId: (q) => q.tenantId,
            getLimit: async () => 5,
            defaultLimit: 5,
          },
        ],
      });

      const queue: QueueDescriptor = {
        id: "queue-1",
        tenantId: "t1",
        metadata: {},
      };

      // Reserve 5 slots (the limit)
      for (let i = 0; i < 5; i++) {
        await manager.reserve(queue, `msg-${i}`);
      }

      const result = await manager.canProcess(queue);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.groupName).toBe("tenant");
      expect(result.blockedBy?.current).toBe(5);
      expect(result.blockedBy?.limit).toBe(5);

      await manager.close();
    });

    redisTest("should allow after release", { timeout: 15000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const manager = new ConcurrencyManager({
        redis: redisOptions,
        keys,
        groups: [
          {
            name: "tenant",
            extractGroupId: (q) => q.tenantId,
            getLimit: async () => 5,
            defaultLimit: 5,
          },
        ],
      });

      const queue: QueueDescriptor = {
        id: "queue-1",
        tenantId: "t1",
        metadata: {},
      };

      // Fill up
      for (let i = 0; i < 5; i++) {
        await manager.reserve(queue, `msg-${i}`);
      }

      // Should be blocked
      let result = await manager.canProcess(queue);
      expect(result.allowed).toBe(false);

      // Release one
      await manager.release(queue, "msg-0");

      // Should be allowed now
      result = await manager.canProcess(queue);
      expect(result.allowed).toBe(true);

      await manager.close();
    });
  });

  describe("multi-group concurrency", () => {
    redisTest("should check all groups", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const manager = new ConcurrencyManager({
        redis: redisOptions,
        keys,
        groups: [
          {
            name: "tenant",
            extractGroupId: (q) => q.tenantId,
            getLimit: async () => 5,
            defaultLimit: 5,
          },
          {
            name: "organization",
            extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
            getLimit: async () => 10,
            defaultLimit: 10,
          },
        ],
      });

      const queue: QueueDescriptor = {
        id: "queue-1",
        tenantId: "t1",
        metadata: { orgId: "org1" },
      };

      // Fill up org level (10)
      for (let i = 0; i < 10; i++) {
        await manager.reserve(queue, `msg-${i}`);
      }

      // Tenant is at 10, over limit of 5
      // Org is at 10, at limit of 10
      const result = await manager.canProcess(queue);
      expect(result.allowed).toBe(false);

      // Should be blocked by tenant first (checked first, limit 5)
      expect(result.blockedBy?.groupName).toBe("tenant");

      await manager.close();
    });

    redisTest(
      "should block if any group is at capacity",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
            {
              name: "organization",
              extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        // Use different queue with different tenant but same org
        const queue1: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: { orgId: "org1" },
        };

        const queue2: QueueDescriptor = {
          id: "queue-2",
          tenantId: "t2",
          metadata: { orgId: "org1" }, // Same org
        };

        // Fill up org with messages from both tenants
        for (let i = 0; i < 5; i++) {
          await manager.reserve(queue1, `msg-t1-${i}`);
        }
        for (let i = 0; i < 5; i++) {
          await manager.reserve(queue2, `msg-t2-${i}`);
        }

        // t1 tenant is at 5/5, org is at 10/10
        let result = await manager.canProcess(queue1);
        expect(result.allowed).toBe(false);

        // t2 tenant is at 5/5
        result = await manager.canProcess(queue2);
        expect(result.allowed).toBe(false);

        await manager.close();
      }
    );
  });

  describe("getAvailableCapacity", () => {
    redisTest(
      "should return available capacity for single group",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        // Initial capacity should be full
        let capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(10);

        // Reserve 3 slots
        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");
        await manager.reserve(queue, "msg-3");

        // Capacity should be reduced
        capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(7);

        await manager.close();
      }
    );

    redisTest(
      "should return minimum capacity across multiple groups",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
            {
              name: "organization",
              extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
              getLimit: async () => 20,
              defaultLimit: 20,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: { orgId: "org1" },
        };

        // Initial capacity should be minimum (5 for tenant, 20 for org)
        let capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(5);

        // Reserve 3 slots
        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");
        await manager.reserve(queue, "msg-3");

        // Now tenant has 2 left, org has 17 left - minimum is 2
        capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(2);

        await manager.close();
      }
    );

    redisTest(
      "should return 0 when any group is at capacity",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 3,
              defaultLimit: 3,
            },
            {
              name: "organization",
              extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: { orgId: "org1" },
        };

        // Fill up tenant capacity
        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");
        await manager.reserve(queue, "msg-3");

        // Tenant is at 3/3, org is at 3/10
        const capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(0);

        await manager.close();
      }
    );

    redisTest(
      "should return 0 when no groups are configured",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        const capacity = await manager.getAvailableCapacity(queue);
        expect(capacity).toBe(0);

        await manager.close();
      }
    );
  });

  describe("atomic reservation", () => {
    redisTest(
      "should atomically reserve across groups",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
            {
              name: "organization",
              extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: { orgId: "org1" },
        };

        const result = await manager.reserve(queue, "msg-1");
        expect(result).toBe(true);

        const tenantCurrent = await manager.getCurrentConcurrency("tenant", "t1");
        const orgCurrent = await manager.getCurrentConcurrency("organization", "org1");

        expect(tenantCurrent).toBe(1);
        expect(orgCurrent).toBe(1);

        await manager.close();
      }
    );

    redisTest(
      "should not reserve if any group is at capacity",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        // Fill up tenant
        for (let i = 0; i < 5; i++) {
          await manager.reserve(queue, `msg-${i}`);
        }

        // Try to reserve one more
        const result = await manager.reserve(queue, "msg-extra");
        expect(result).toBe(false);

        // Should still be at 5
        const current = await manager.getCurrentConcurrency("tenant", "t1");
        expect(current).toBe(5);

        await manager.close();
      }
    );
  });

  describe("get active messages", () => {
    redisTest(
      "should return all active message IDs",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");
        await manager.reserve(queue, "msg-3");

        const active = await manager.getActiveMessages("tenant", "t1");
        expect(active).toHaveLength(3);
        expect(active).toContain("msg-1");
        expect(active).toContain("msg-2");
        expect(active).toContain("msg-3");

        await manager.close();
      }
    );
  });

  describe("clear group", () => {
    redisTest(
      "should clear all messages for a group",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");

        await manager.clearGroup("tenant", "t1");

        const current = await manager.getCurrentConcurrency("tenant", "t1");
        expect(current).toBe(0);

        await manager.close();
      }
    );
  });

  describe("get state", () => {
    redisTest(
      "should return full concurrency state",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        await manager.reserve(queue, "msg-1");
        await manager.reserve(queue, "msg-2");

        const state = await manager.getState("tenant", "t1");
        expect(state.groupName).toBe("tenant");
        expect(state.groupId).toBe("t1");
        expect(state.current).toBe(2);
        expect(state.limit).toBe(5);

        await manager.close();
      }
    );
  });

  describe("group names", () => {
    redisTest(
      "should return configured group names",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
            {
              name: "organization",
              extractGroupId: (q) => (q.metadata.orgId as string) ?? "default",
              getLimit: async () => 10,
              defaultLimit: 10,
            },
          ],
        });

        const names = manager.getGroupNames();
        expect(names).toEqual(["tenant", "organization"]);

        await manager.close();
      }
    );
  });

  describe("keyPrefix handling", () => {
    redisTest(
      "should correctly reserve and release with keyPrefix",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "myprefix" });

        // Create manager with keyPrefix - this simulates real-world usage
        const manager = new ConcurrencyManager({
          redis: {
            ...redisOptions,
            keyPrefix: "engine:batch-queue:",
          },
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 2,
              defaultLimit: 2,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        // Reserve slots
        const reserved1 = await manager.reserve(queue, "msg-1");
        const reserved2 = await manager.reserve(queue, "msg-2");
        expect(reserved1).toBe(true);
        expect(reserved2).toBe(true);

        // Should be at capacity
        let result = await manager.canProcess(queue);
        expect(result.allowed).toBe(false);

        // Release one - this must use the SAME key as reserve (with keyPrefix)
        await manager.release(queue, "msg-1");

        // Should now be allowed - this proves reserve and release use the same key
        result = await manager.canProcess(queue);
        expect(result.allowed).toBe(true);

        // Verify concurrency count is correct
        const current = await manager.getCurrentConcurrency("tenant", "t1");
        expect(current).toBe(1);

        await manager.close();
      }
    );

    redisTest(
      "should handle reserve/release cycle multiple times with keyPrefix",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: {
            ...redisOptions,
            keyPrefix: "myapp:",
          },
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 1, // Concurrency of 1
              defaultLimit: 1,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        // Simulate processing multiple messages one at a time
        for (let i = 0; i < 5; i++) {
          const msgId = `msg-${i}`;

          // Reserve
          const reserved = await manager.reserve(queue, msgId);
          expect(reserved).toBe(true);

          // Should be at capacity now
          const check = await manager.canProcess(queue);
          expect(check.allowed).toBe(false);

          // Release
          await manager.release(queue, msgId);

          // Should be free again
          const checkAfter = await manager.canProcess(queue);
          expect(checkAfter.allowed).toBe(true);
        }

        // Final state should be 0 concurrent
        const current = await manager.getCurrentConcurrency("tenant", "t1");
        expect(current).toBe(0);

        await manager.close();
      }
    );
  });
});
