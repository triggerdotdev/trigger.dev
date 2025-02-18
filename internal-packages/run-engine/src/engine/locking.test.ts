import { redisTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { RunLocker } from "./locking.js";
import Redis from "ioredis";

describe("RunLocker", () => {
  redisTest("Test acquiring a lock works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const runLock = new RunLocker({ redis });

    expect(runLock.isInsideLock()).toBe(false);

    await runLock.lock(["test-1"], 5000, async (signal) => {
      expect(signal).toBeDefined();
      expect(runLock.isInsideLock()).toBe(true);
    });

    expect(runLock.isInsideLock()).toBe(false);
  });

  redisTest("Test double locking works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
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
  });
});
