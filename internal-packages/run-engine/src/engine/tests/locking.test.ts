import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { RunLocker } from "../locking.js";

describe("RunLocker", () => {
  redisTest("Test acquiring a lock works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    try {
      const runLock = new RunLocker({ redis });

      expect(runLock.isInsideLock()).toBe(false);

      await runLock.lock(["test-1"], 5000, async (signal) => {
        expect(signal).toBeDefined();
        expect(runLock.isInsideLock()).toBe(true);
      });

      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await redis.quit();
    }
  });

  redisTest("Test double locking works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    try {
      const runLock = new RunLocker({ redis });

      expect(runLock.isInsideLock()).toBe(false);

      await runLock.lock(["test-1"], 5000, async (signal) => {
        expect(signal).toBeDefined();
        expect(runLock.isInsideLock()).toBe(true);

        //should be able to "lock it again"
        await runLock.lock(["test-1"], 5000, async (signal) => {
          expect(signal).toBeDefined();
          expect(runLock.isInsideLock()).toBe(true);
        });
      });

      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "Test lock throws when callback throws",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      try {
        const runLock = new RunLocker({ redis });

        expect(runLock.isInsideLock()).toBe(false);

        await expect(
          runLock.lock(["test-1"], 5000, async () => {
            throw new Error("Test error");
          })
        ).rejects.toThrow("Test error");

        // Verify the lock was released
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "Test nested lock throws when inner callback throws",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      try {
        const runLock = new RunLocker({ redis });

        expect(runLock.isInsideLock()).toBe(false);

        await expect(
          runLock.lock(["test-1"], 5000, async () => {
            expect(runLock.isInsideLock()).toBe(true);

            // Nested lock with same resource
            await runLock.lock(["test-1"], 5000, async () => {
              expect(runLock.isInsideLock()).toBe(true);
              throw new Error("Inner lock error");
            });
          })
        ).rejects.toThrow("Inner lock error");

        // Verify all locks were released
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest("Test lock throws when it times out", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    try {
      const runLock = new RunLocker({ redis });

      // First, ensure we can acquire the lock normally
      let firstLockAcquired = false;
      await runLock.lock(["test-1"], 5000, async () => {
        firstLockAcquired = true;
      });
      //wait for 20ms
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(firstLockAcquired).toBe(true);

      // Now create a long-running lock
      const lockPromise1 = runLock.lock(["test-1"], 5000, async () => {
        // Hold the lock longer than all possible retry attempts
        // (10 retries * (200ms delay + 200ms max jitter) = ~4000ms max)
        await new Promise((resolve) => setTimeout(resolve, 5000));
      });

      // Try to acquire same lock immediately
      await expect(
        runLock.lock(["test-1"], 5000, async () => {
          // This should never execute
          expect(true).toBe(false);
        })
      ).rejects.toThrow("unable to achieve a quorum");

      // Complete the first lock
      await lockPromise1;

      // Verify final state
      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "Test nested lock with same resources doesn't timeout",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      try {
        const runLock = new RunLocker({ redis });

        await runLock.lock(["test-1"], 5000, async () => {
          // First lock acquired
          expect(runLock.isInsideLock()).toBe(true);

          // Try to acquire the same resource with a very short timeout
          // This should work because we already hold the lock
          await runLock.lock(["test-1"], 100, async () => {
            expect(runLock.isInsideLock()).toBe(true);
            // Wait longer than the timeout to prove it doesn't matter
            await new Promise((resolve) => setTimeout(resolve, 500));
          });
        });

        // Verify final state
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "Test nested lock with same resource works regardless of retries",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      try {
        const runLock = new RunLocker({ redis });

        // First verify we can acquire the lock normally
        let firstLockAcquired = false;
        await runLock.lock(["test-1"], 5000, async () => {
          firstLockAcquired = true;
        });
        expect(firstLockAcquired).toBe(true);

        // Now test the nested lock behavior
        let outerLockExecuted = false;
        let innerLockExecuted = false;

        await runLock.lock(["test-1"], 5000, async () => {
          outerLockExecuted = true;
          expect(runLock.isInsideLock()).toBe(true);
          expect(runLock.getCurrentResources()).toBe("test-1");

          // Try to acquire the same resource in a nested lock
          // This should work immediately without any retries
          // because we already hold the lock
          await runLock.lock(["test-1"], 5000, async () => {
            innerLockExecuted = true;
            expect(runLock.isInsideLock()).toBe(true);
            expect(runLock.getCurrentResources()).toBe("test-1");

            // Sleep longer than retry attempts would take
            // (10 retries * (200ms delay + 200ms max jitter) = ~4000ms max)
            await new Promise((resolve) => setTimeout(resolve, 5000));
          });
        });

        // Verify both locks executed
        expect(outerLockExecuted).toBe(true);
        expect(innerLockExecuted).toBe(true);
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await redis.quit();
      }
    }
  );
});
