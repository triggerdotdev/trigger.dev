import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { setTimeout } from "node:timers/promises";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import {
  encodeQueueMember,
  encodeWorkerQueueEntry,
  decodeQueueMember,
  decodeWorkerQueueEntry,
  isEncodedQueueMember,
  isEncodedWorkerQueueEntry,
} from "../messageEncoding.js";

// Mock Decimal since we can't import from @trigger.dev/database without Prisma
const createDecimal = (value: number) => ({
  toNumber: () => value,
  toString: () => value.toString(),
});

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const createEnv = (id: string, type: "DEVELOPMENT" | "PRODUCTION" = "DEVELOPMENT") => ({
  id,
  type,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: createDecimal(1.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
});

const createMessage = (
  runId: string,
  timestamp: number = Date.now()
): InputPayload => ({
  runId,
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e1234",
  environmentType: "DEVELOPMENT",
  queue: "task/my-task",
  timestamp,
  attempt: 0,
});

vi.setConfig({ testTimeout: 60_000 });

describe("Message Format Handling", () => {
  describe("V2 (Legacy) Format", () => {
    redisTest(
      "should enqueue and dequeue messages in V2 format when useOptimizedMessageFormat is false",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false, // V2 legacy format
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v2test:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v2test:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v2_test_1");

          // Enqueue message
          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          // Verify message key was created (V2 format)
          const messageExists = await queue.messageExists(message.orgId, message.runId);
          expect(messageExists).toBe(1); // Message key should exist in V2 format

          // Verify queue length
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(1);

          // Wait for worker to process
          await setTimeout(600);

          // Dequeue and verify
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();
          expect(dequeued?.messageId).toBe(message.runId);
          expect(dequeued?.message.version).toBe("2");
          expect(dequeued?.message.runId).toBe(message.runId);
        } finally {
          await queue.quit();
        }
      }
    );

    redisTest(
      "should read message from message key in V2 format",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v2read:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v2read:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v2_read_test");

          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          // Read message directly
          const readMessage = await queue.readMessage(message.orgId, message.runId);
          expect(readMessage).toBeDefined();
          expect(readMessage?.runId).toBe(message.runId);
          expect(readMessage?.taskIdentifier).toBe(message.taskIdentifier);
        } finally {
          await queue.quit();
        }
      }
    );

    redisTest(
      "should acknowledge V2 message and delete message key",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v2ack:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v2ack:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v2_ack_test");

          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          // Wait for processing
          await setTimeout(600);

          // Dequeue
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();

          // Acknowledge
          await queue.acknowledgeMessage(message.orgId, message.runId);

          // Verify message key is deleted
          const messageExists = await queue.messageExists(message.orgId, message.runId);
          expect(messageExists).toBe(0);

          // Verify queue is empty
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(0);
        } finally {
          await queue.quit();
        }
      }
    );

    redisTest(
      "should nack V2 message and update message key with incremented attempt",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v2nack:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v2nack:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v2_nack_test");

          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          await setTimeout(600);

          // Dequeue
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();
          expect(dequeued?.message.attempt).toBe(0);

          // Nack (will increment attempt and requeue)
          const nackResult = await queue.nackMessage({
            orgId: message.orgId,
            messageId: message.runId,
            retryAt: Date.now(), // Retry immediately
          });
          expect(nackResult).toBe(true);

          // Verify message is back in queue
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(1);

          // Read message and verify attempt was incremented
          const updatedMessage = await queue.readMessage(message.orgId, message.runId);
          expect(updatedMessage?.attempt).toBe(1);
        } finally {
          await queue.quit();
        }
      }
    );
  });

  describe("V3 (Optimized) Format", () => {
    redisTest(
      "should enqueue and dequeue messages in V3 format when useOptimizedMessageFormat is true",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: true, // V3 optimized format
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v3test:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v3test:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v3_test_1");

          // Enqueue message
          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          // Verify NO message key was created (V3 format)
          const messageExists = await queue.messageExists(message.orgId, message.runId);
          expect(messageExists).toBe(0); // Message key should NOT exist in V3 format

          // Verify queue length
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(1);

          // Wait for worker to process
          await setTimeout(600);

          // Dequeue and verify
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();
          expect(dequeued?.messageId).toBe(message.runId);
          expect(dequeued?.message.version).toBe("2"); // Still returns OutputPayloadV2
          expect(dequeued?.message.runId).toBe(message.runId);
          expect(dequeued?.message.taskIdentifier).toBe(message.taskIdentifier);
        } finally {
          await queue.quit();
        }
      }
    );

    redisTest(
      "should acknowledge V3 message without error (no message key to delete)",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: true,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v3ack:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v3ack:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v3_ack_test");

          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          await setTimeout(600);

          // Dequeue
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();

          // Acknowledge (should not error even though no message key exists)
          await queue.acknowledgeMessage(message.orgId, message.runId);

          // Verify queue is empty
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(0);
        } finally {
          await queue.quit();
        }
      }
    );

    redisTest(
      "should nack V3 message and requeue with encoded format",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");
        const queue = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: true,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:v3nack:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:v3nack:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const message = createMessage("run_v3_nack_test");

          await queue.enqueueMessage({
            env: env as any,
            message,
            workerQueue: env.id,
          });

          await setTimeout(600);

          // Dequeue
          const dequeued = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();
          expect(dequeued?.message.attempt).toBe(0);

          // Nack
          const nackResult = await queue.nackMessage({
            orgId: message.orgId,
            messageId: message.runId,
            retryAt: Date.now(),
          });
          expect(nackResult).toBe(true);

          // Verify message is back in queue
          expect(await queue.lengthOfQueue(env as any, message.queue)).toBe(1);

          // Wait and dequeue again to verify attempt was incremented
          await setTimeout(600);
          const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued2).toBeDefined();
          expect(dequeued2?.message.attempt).toBe(1);
        } finally {
          await queue.quit();
        }
      }
    );
  });

  describe("Mixed Format Migration", () => {
    redisTest(
      "V3 queue should be able to read V2 messages during migration",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");

        // First, enqueue with V2 format
        const queueV2 = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false, // V2
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:mixed:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:mixed:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        const message = createMessage("run_mixed_v2_to_v3");

        await queueV2.enqueueMessage({
          env: env as any,
          message,
          workerQueue: env.id,
        });

        // Verify V2 message key exists
        expect(await queueV2.messageExists(message.orgId, message.runId)).toBe(1);

        await queueV2.quit();

        // Now create V3 queue and try to read the V2 message
        const queueV3 = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: true, // V3
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:mixed:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:mixed:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          await setTimeout(600);

          // V3 queue should be able to dequeue V2 message
          const dequeued = await queueV3.dequeueMessageFromWorkerQueue("test_consumer", env.id);
          expect(dequeued).toBeDefined();
          expect(dequeued?.messageId).toBe(message.runId);
          expect(dequeued?.message.runId).toBe(message.runId);
        } finally {
          await queueV3.quit();
        }
      }
    );

    redisTest(
      "should handle multiple messages with mixed formats",
      async ({ redisContainer }) => {
        const env = createEnv("e1234");

        // Create V2 queue and enqueue some messages
        const queueV2 = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: false,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:multimixed:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:multimixed:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        const messageV2_1 = createMessage("run_v2_1", Date.now() - 3000);
        const messageV2_2 = createMessage("run_v2_2", Date.now() - 2000);

        await queueV2.enqueueMessage({ env: env as any, message: messageV2_1, workerQueue: env.id });
        await queueV2.enqueueMessage({ env: env as any, message: messageV2_2, workerQueue: env.id });

        await queueV2.quit();

        // Switch to V3 and add more messages
        const queueV3 = new RunQueue({
          ...testOptions,
          useOptimizedMessageFormat: true,
          queueSelectionStrategy: new FairQueueSelectionStrategy({
            redis: {
              keyPrefix: "runqueue:multimixed:",
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            },
            keys: testOptions.keys,
          }),
          redis: {
            keyPrefix: "runqueue:multimixed:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
        });

        try {
          const messageV3_1 = createMessage("run_v3_1", Date.now() - 1000);
          const messageV3_2 = createMessage("run_v3_2", Date.now());

          await queueV3.enqueueMessage({ env: env as any, message: messageV3_1, workerQueue: env.id });
          await queueV3.enqueueMessage({ env: env as any, message: messageV3_2, workerQueue: env.id });

          // Total should be 4 messages
          expect(await queueV3.lengthOfQueue(env as any, messageV2_1.queue)).toBe(4);

          await setTimeout(600);

          // Dequeue all messages - should handle both formats
          const dequeuedMessages: string[] = [];
          for (let i = 0; i < 4; i++) {
            const dequeued = await queueV3.dequeueMessageFromWorkerQueue("test_consumer", env.id);
            if (dequeued) {
              dequeuedMessages.push(dequeued.messageId);
            }
          }

          // All 4 messages should be dequeued successfully
          expect(dequeuedMessages).toContain("run_v2_1");
          expect(dequeuedMessages).toContain("run_v2_2");
          expect(dequeuedMessages).toContain("run_v3_1");
          expect(dequeuedMessages).toContain("run_v3_2");
        } finally {
          await queueV3.quit();
        }
      }
    );
  });

  describe("Encoding Format Detection", () => {
    test("isEncodedQueueMember correctly identifies V3 format", () => {
      const v3Member = encodeQueueMember({
        runId: "run_test",
        workerQueue: "env_test",
        attempt: 0,
        environmentType: "PRODUCTION",
      });

      expect(isEncodedQueueMember(v3Member)).toBe(true);
      expect(isEncodedQueueMember("run_test")).toBe(false); // V2 is just runId
    });

    test("isEncodedWorkerQueueEntry correctly identifies formats", () => {
      const v3Entry = encodeWorkerQueueEntry({
        runId: "run_test",
        workerQueue: "env_test",
        attempt: 0,
        environmentType: "PRODUCTION",
        queueKey: "{org:o1}:proj:p1:env:e1:queue:task",
        timestamp: Date.now(),
      });

      const v2Entry = "{org:o1}:message:run_test";

      expect(isEncodedWorkerQueueEntry(v3Entry)).toBe(true);
      expect(isEncodedWorkerQueueEntry(v2Entry)).toBe(false);
    });

    test("decodeQueueMember extracts correct data", () => {
      const original = {
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 3,
        environmentType: "STAGING" as const,
      };

      const encoded = encodeQueueMember(original);
      const decoded = decodeQueueMember(encoded);

      expect(decoded).toEqual(original);
    });

    test("decodeWorkerQueueEntry extracts correct data", () => {
      const original = {
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 2,
        environmentType: "DEVELOPMENT" as const,
        queueKey: "{org:o1}:proj:p1:env:e1:queue:my-task",
        timestamp: 1706812800000,
      };

      const encoded = encodeWorkerQueueEntry(original);
      const decoded = decodeWorkerQueueEntry(encoded);

      expect(decoded).toEqual(original);
    });
  });
});
