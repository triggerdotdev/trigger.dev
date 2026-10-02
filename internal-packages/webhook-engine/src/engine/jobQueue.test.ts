import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { expect } from "vitest";
import { WebhookJobQueue } from "./jobQueue.js";

containerTestWithIsolatedRedisNoClickhouse(
  "a job that runs past its lease keeps it, so it is not reclaimed and run twice",
  async ({ redisOptions }) => {
    const calls: number[] = [];
    let finished = 0;
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      consumers: 2,
      tenantConcurrency: 2,
      consumerIntervalMs: 20,
      visibilityTimeoutMs: 900,
      reclaimIntervalMs: 100,
      handlers: {
        deliver: async ({ attempt }) => {
          calls.push(attempt);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          finished++;
        },
        completeWaiters: async () => {},
      },
    });

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_slow",
        environmentId: "env_lease",
        endpointId: "ep_lease",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_slow", createdAt: new Date() } as never,
        },
      });

      const deadline = Date.now() + 15_000;
      while (finished === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      expect(finished).toBe(1);
      expect(calls).toEqual([0]);
    } finally {
      await queue.close();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a consumer whose lease was reclaimed can't settle the attempt that took it over",
  async ({ redisOptions }) => {
    let calls = 0;
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      consumers: 2,
      tenantConcurrency: 2,
      consumerIntervalMs: 20,
      visibilityTimeoutMs: 900,
      reclaimIntervalMs: 100,
      heartbeatIntervalMs: 60_000,
      handlers: {
        deliver: async () => {
          calls++;
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            return;
          }
          if (calls === 2) {
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            throw new Error("the reclaimed attempt fails");
          }
        },
        completeWaiters: async () => {},
      },
    });

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_reclaimed",
        environmentId: "env_lease",
        endpointId: "ep_lease",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_reclaimed", createdAt: new Date() } as never,
        },
      });

      const deadline = Date.now() + 20_000;
      while (calls < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(calls).toBe(3);
    } finally {
      await queue.close();
    }
  },
  40_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "while a run still holds the job, a reclaim of its lapsed lease doesn't start a run alongside it",
  async ({ redisOptions }) => {
    let calls = 0;
    let finished = 0;
    let running = 0;
    let peak = 0;
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      consumers: 2,
      tenantConcurrency: 2,
      consumerIntervalMs: 20,
      visibilityTimeoutMs: 900,
      reclaimIntervalMs: 100,
      heartbeatIntervalMs: 60_000,
      ownerTtlMs: 10_000,
      handlers: {
        deliver: async () => {
          calls++;
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 3_000 : 10));
          running--;
          finished++;
        },
        completeWaiters: async () => {},
      },
    });

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_held",
        environmentId: "env_lease",
        endpointId: "ep_lease",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_held", createdAt: new Date() } as never,
        },
      });

      const deadline = Date.now() + 15_000;
      while (finished === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      expect(peak).toBe(1);
      expect(finished).toBeGreaterThanOrEqual(1);
    } finally {
      await queue.close();
    }
  },
  40_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "an exhausted handler that fails is retried from a job of its own until it lands",
  async ({ redisOptions }) => {
    const exhausted: Array<{ deliveryId: string; error: string }> = [];
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      consumers: 1,
      tenantConcurrency: 1,
      consumerIntervalMs: 20,
      exhaustedRecordDelayMs: 200,
      handlers: {
        deliver: async () => {
          throw new Error("database unavailable");
        },
        completeWaiters: async () => {},
        exhausted: async (job, error) => {
          exhausted.push({ deliveryId: job.payload.deliveryId, error: error.message });
          if (exhausted.length === 1) throw new Error("still unavailable");
        },
      },
    });

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_exhausted",
        environmentId: "env_exhausted",
        endpointId: "ep_exhausted",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_exhausted", createdAt: new Date() },
        },
      });

      const deadline = Date.now() + 60_000;
      while (exhausted.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(exhausted).toEqual([
        { deliveryId: "delivery_exhausted", error: "database unavailable" },
        { deliveryId: "delivery_exhausted", error: "database unavailable" },
      ]);
    } finally {
      await queue.close();
    }
  },
  90_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a job whose exhausted record can't be queued is kept, and its reclaimed attempt hands it off",
  async ({ redisOptions }) => {
    let delivers = 0;
    const exhausted: string[] = [];
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      consumers: 1,
      tenantConcurrency: 1,
      consumerIntervalMs: 20,
      visibilityTimeoutMs: 900,
      reclaimIntervalMs: 100,
      ownerTtlMs: 900,
      exhaustedRecordDelayMs: 100,
      handlers: {
        deliver: async () => {
          delivers++;
          throw new Error("database unavailable");
        },
        completeWaiters: async () => {},
        exhausted: async (job) => {
          exhausted.push(job.payload.deliveryId);
          if (exhausted.length <= 2) throw new Error("still unavailable");
        },
      },
    });
    const fairQueue = (
      queue as unknown as { fairQueue: { enqueue: (o: unknown) => Promise<string> } }
    ).fairQueue;
    const enqueue = fairQueue.enqueue.bind(fairQueue);
    let failedHandoff = false;
    fairQueue.enqueue = async (options) => {
      const messageId = (options as { messageId?: string }).messageId ?? "";
      if (!failedHandoff && messageId.includes("_exhausted_")) {
        failedHandoff = true;
        throw new Error("redis unavailable");
      }
      return enqueue(options);
    };

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_handoff",
        environmentId: "env_handoff",
        endpointId: "ep_handoff",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_handoff", createdAt: new Date() },
        },
      });

      const deadline = Date.now() + 75_000;
      while (exhausted.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(failedHandoff).toBe(true);
      expect(delivers).toBe(6);
      expect(exhausted).toEqual(["delivery_handoff", "delivery_handoff", "delivery_handoff"]);
    } finally {
      await queue.close();
    }
  },
  90_000
);
