import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { WorkerQueueResolver, type WorkerQueueOverrides } from "../workerQueueResolver.js";
import { OutputPayload, OutputPayloadV1, OutputPayloadV2 } from "../types.js";
import { RuntimeEnvironmentType } from "@trigger.dev/core/v3";

vi.setConfig({ testTimeout: 5_000 });

describe("WorkerQueueOverrideResolver", () => {
  const createTestMessage = (overrides?: Partial<OutputPayloadV2>): OutputPayloadV2 => ({
    version: "2",
    runId: "run_123",
    taskIdentifier: "task_123",
    orgId: "org_123",
    projectId: "proj_123",
    environmentId: "env_123",
    environmentType: RuntimeEnvironmentType.PRODUCTION,
    queue: "test-queue",
    timestamp: Date.now(),
    attempt: 0,
    workerQueue: "default-queue",
    ...overrides,
  });

  describe("No overrides", () => {
    it("should return original workerQueue when no overrides are set", () => {
      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger });
      const message = createTestMessage({ workerQueue: "original-queue" });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("original-queue");
    });
  });

  describe("Environment ID overrides", () => {
    it("should override based on environmentId", () => {
      const overrideConfig = JSON.stringify({
        environmentId: {
          env_special: "special-env-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        environmentId: "env_special",
        workerQueue: "original-queue",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("special-env-queue");
    });

    it("should not override when environmentId doesn't match", () => {
      const overrideConfig = JSON.stringify({
        environmentId: {
          env_other: "other-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        environmentId: "env_123",
        workerQueue: "original-queue",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("original-queue");
    });
  });

  describe("Project ID overrides", () => {
    it("should override based on projectId", () => {
      const overrideConfig = JSON.stringify({
        projectId: {
          proj_special: "special-project-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        projectId: "proj_special",
        workerQueue: "original-queue",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("special-project-queue");
    });
  });

  describe("Organization ID overrides", () => {
    it("should override based on orgId", () => {
      const overrideConfig = JSON.stringify({
        orgId: {
          org_special: "special-org-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        orgId: "org_special",
        workerQueue: "original-queue",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("special-org-queue");
    });
  });

  describe("Worker Queue overrides", () => {
    it("should override based on workerQueue", () => {
      const overrideConfig = JSON.stringify({
        workerQueue: {
          "us-east-1": "us-west-1",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        workerQueue: "us-east-1",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("us-west-1");
    });
  });

  describe("Priority order", () => {
    it("should prioritize environmentId over projectId", () => {
      const overrideConfig = JSON.stringify({
        environmentId: {
          env_123: "env-queue",
        },
        projectId: {
          proj_123: "project-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("env-queue");
    });

    it("should prioritize projectId over orgId", () => {
      const overrideConfig = JSON.stringify({
        projectId: {
          proj_123: "project-queue",
        },
        orgId: {
          org_123: "org-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("project-queue");
    });

    it("should prioritize orgId over workerQueue", () => {
      const overrideConfig = JSON.stringify({
        orgId: {
          org_123: "org-queue",
        },
        workerQueue: {
          "default-queue": "worker-override-queue",
        },
      } satisfies WorkerQueueOverrides);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("org-queue");
    });
  });

  describe("Configuration parsing", () => {
    it("should handle invalid JSON gracefully", () => {
      const loggerSpy = vi.spyOn(Logger.prototype, "error");

      const overrideConfig = "invalid json {";

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("default-queue");
      expect(loggerSpy).toHaveBeenCalledWith(
        "Failed to parse worker queue overrides json",
        expect.any(Object)
      );

      loggerSpy.mockRestore();
    });

    it("should handle non-object JSON gracefully", () => {
      const loggerSpy = vi.spyOn(Logger.prototype, "error");

      const overrideConfig = JSON.stringify("not an object");

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("default-queue");
      expect(loggerSpy).toHaveBeenCalledWith(
        "Invalid worker queue overrides format",
        expect.any(Object)
      );

      loggerSpy.mockRestore();
    });

    it("should handle null JSON gracefully", () => {
      const loggerSpy = vi.spyOn(Logger.prototype, "error");

      const overrideConfig = JSON.stringify(null);

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("default-queue");
      expect(loggerSpy).toHaveBeenCalledWith(
        "Invalid worker queue overrides format",
        expect.any(Object)
      );

      loggerSpy.mockRestore();
    });

    it("should log when overrides are enabled", () => {
      const loggerSpy = vi.spyOn(Logger.prototype, "info");

      const overrides: WorkerQueueOverrides = {
        orgId: { org_123: "dedicated-queue" },
      };

      const overrideConfig = JSON.stringify(overrides);

      const logger = new Logger("test", "info");
      new WorkerQueueResolver({ logger, overrideConfig });

      expect(loggerSpy).toHaveBeenCalledWith("🎯 Worker queue overrides enabled", { overrides });

      loggerSpy.mockRestore();
    });

    it("should validate schema and reject invalid structure", () => {
      const loggerSpy = vi.spyOn(Logger.prototype, "error");

      // Invalid structure - numbers instead of strings in the record
      const overrideConfig = JSON.stringify({
        orgId: {
          org_123: 12345, // Should be string, not number
        },
      });

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("default-queue");
      expect(loggerSpy).toHaveBeenCalledWith(
        "Invalid worker queue overrides format",
        expect.any(Object)
      );

      loggerSpy.mockRestore();
    });
  });

  describe("Complex scenarios", () => {
    it("should handle multiple override types simultaneously", () => {
      const overrideConfig = JSON.stringify({
        environmentId: {
          env_special: "special-env-queue",
        },
        projectId: {
          proj_other: "other-project-queue",
        },
        orgId: {
          org_123: "org-queue",
        },
        workerQueue: {
          "fallback-queue": "redirected-queue",
        },
      });

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });

      // Should use orgId override since env and project don't match
      const message1 = createTestMessage({
        environmentId: "env_123",
        projectId: "proj_123",
        orgId: "org_123",
        workerQueue: "original-queue",
      });

      const result1 = resolver.getWorkerQueueFromMessage(message1);
      expect(result1).toBe("org-queue");

      // Should use environmentId override since it matches
      const message2 = createTestMessage({
        environmentId: "env_special",
        projectId: "proj_123",
        orgId: "org_456",
        workerQueue: "original-queue",
      });

      const result2 = resolver.getWorkerQueueFromMessage(message2);
      expect(result2).toBe("special-env-queue");

      // Should use workerQueue override as fallback
      const message3 = createTestMessage({
        environmentId: "env_unknown",
        projectId: "proj_unknown",
        orgId: "org_unknown",
        workerQueue: "fallback-queue",
      });

      const result3 = resolver.getWorkerQueueFromMessage(message3);
      expect(result3).toBe("redirected-queue");
    });

    it("should handle empty override sections", () => {
      const overrideConfig = JSON.stringify({
        environmentId: {},
        projectId: {},
        orgId: {
          org_123: "org-queue",
        },
        workerQueue: {},
      });

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage();

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("org-queue");
    });
  });

  describe("V1 message handling", () => {
    it("should handle v1 development messages", () => {
      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger });

      const v1DevMessage: OutputPayloadV1 = {
        version: "1",
        runId: "run_123",
        taskIdentifier: "task_123",
        orgId: "org_123",
        projectId: "proj_123",
        environmentId: "env_dev",
        environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        queue: "test-queue",
        timestamp: Date.now(),
        attempt: 0,
        masterQueues: ["us-east-1", "us-west-1"],
      };

      const result = resolver.getWorkerQueueFromMessage(v1DevMessage);

      expect(result).toBe("env_dev");
    });

    it("should handle v1 production messages", () => {
      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger });

      const v1ProdMessage: OutputPayloadV1 = {
        version: "1",
        runId: "run_123",
        taskIdentifier: "task_123",
        orgId: "org_123",
        projectId: "proj_123",
        environmentId: "env_prod",
        environmentType: RuntimeEnvironmentType.PRODUCTION,
        queue: "test-queue",
        timestamp: Date.now(),
        attempt: 0,
        masterQueues: ["us-east-1", "us-west-1"],
      };

      const result = resolver.getWorkerQueueFromMessage(v1ProdMessage);

      expect(result).toBe("us-east-1");
    });
  });

  describe("Environment variable fallback", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES;
      } else {
        process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES = originalEnv;
      }
    });

    it("should fall back to environment variable when no overrideConfig provided", () => {
      // Set environment variable
      process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES = JSON.stringify({
        orgId: {
          org_from_env: "env-based-queue",
        },
      });

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger }); // No overrideConfig
      const message = createTestMessage({
        orgId: "org_from_env",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("env-based-queue");
    });

    it("should prioritize overrideConfig over environment variable", () => {
      // Set environment variable
      process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES = JSON.stringify({
        orgId: {
          org_123: "env-queue",
        },
      });

      // Pass config directly (should take precedence)
      const overrideConfig = JSON.stringify({
        orgId: {
          org_123: "config-queue",
        },
      });

      const logger = new Logger("test", "error");
      const resolver = new WorkerQueueResolver({ logger, overrideConfig });
      const message = createTestMessage({
        orgId: "org_123",
      });

      const result = resolver.getWorkerQueueFromMessage(message);

      expect(result).toBe("config-queue");
    });
  });
});
