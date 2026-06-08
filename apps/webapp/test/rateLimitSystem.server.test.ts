import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimitSystem } from "../app/v3/services/rateLimitSystem.server";
import { PrismaClient, Prisma } from "@trigger.dev/database";
import { Redis } from "ioredis";
import { AuthenticatedEnvironment } from "../app/services/apiAuth.server";
import * as runQueueServer from "../app/v3/runQueue.server";

vi.mock("../app/v3/runQueue.server", () => ({
  updateQueueRateLimits: vi.fn(),
  removeQueueRateLimits: vi.fn(),
}));

describe("RateLimitSystem", () => {
  let prismaMock: any;
  let redisMock: any;
  let rateLimitSystem: RateLimitSystem;
  let mockEnvironment: AuthenticatedEnvironment;

  beforeEach(() => {
    prismaMock = {
      taskQueue: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    rateLimitSystem = new RateLimitSystem(prismaMock as unknown as PrismaClient);

    mockEnvironment = {
      id: "env-123",
    } as AuthenticatedEnvironment;

    vi.clearAllMocks();
  });

  describe("overrideQueueRateLimit", () => {
    it("should update the rateLimit field in the database and call the Redis sync method", async () => {
      const queueName = "test-queue";
      const rateLimits = [{ limit: 10, window: 60 }];

      await rateLimitSystem.overrideQueueRateLimit(mockEnvironment, queueName, rateLimits);

      expect(prismaMock.taskQueue.updateMany).toHaveBeenCalledWith({
        where: {
          runtimeEnvironmentId: mockEnvironment.id,
          name: queueName,
        },
        data: {
          rateLimit: rateLimits,
        },
      });

      expect(runQueueServer.updateQueueRateLimits).toHaveBeenCalledWith(
        mockEnvironment,
        queueName,
        rateLimits
      );
    });
  });

  describe("resetQueueRateLimit", () => {
    it("should clear the rateLimit field in the database and call the Redis sync method", async () => {
      const queueName = "test-queue";

      await rateLimitSystem.resetQueueRateLimit(mockEnvironment, queueName);

      expect(prismaMock.taskQueue.updateMany).toHaveBeenCalledWith({
        where: {
          runtimeEnvironmentId: mockEnvironment.id,
          name: queueName,
        },
        data: {
          rateLimit: Prisma.DbNull,
        },
      });

      expect(runQueueServer.removeQueueRateLimits).toHaveBeenCalledWith(
        mockEnvironment,
        queueName
      );
    });
  });
});
