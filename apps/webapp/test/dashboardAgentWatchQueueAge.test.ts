/**
 * A wait-time watch has to be able to end. The reader must say "unavailable" when the engine
 * can't answer rather than report a healthy zero, and a queue that no longer exists has to
 * resolve the watch instead of leaving it pending for its whole window.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { WatchCheckDeps } from "~/services/dashboardAgentWatchChecks";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";

const ctx = vi.hoisted(() => ({
  breakdown: null as null | { keys: Array<{ queued: number; oldestEnqueuedAt: number }> },
  breakdownThrows: false,
  oldest: undefined as number | undefined,
  oldestThrows: false,
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    concurrencyKeyBreakdown: async () => {
      if (ctx.breakdownThrows) throw new Error("redis is down");
      return ctx.breakdown ?? { keys: [] };
    },
    oldestMessageInQueue: async () => {
      if (ctx.oldestThrows) throw new Error("redis is down");
      return ctx.oldest;
    },
  },
}));

const { readWatchQueueOldestAge } = await import("~/services/dashboardAgentWatchChecks.server");
const { checkWatch } = await import("~/services/dashboardAgentWatchChecks");

const NOW = new Date("2026-08-07T12:00:00.000Z");
const environment = {
  id: "env_1",
  organizationId: "org_1",
  projectId: "proj_1",
} as AuthenticatedEnvironment;

const SPEC: WatchSpec = {
  kind: "queue_oldest_age",
  queue: "task/send-receipt",
  thresholdMinutes: 5,
  checkEveryMinutes: 5,
  maxHours: 1,
  note: "tell me if anything waits too long",
};

function deps(overrides: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => null,
    readQueueOldestAge: (queueName: string) => readWatchQueueOldestAge(environment, queueName, NOW),
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
    ...overrides,
  };
}

beforeEach(() => {
  ctx.breakdown = null;
  ctx.breakdownThrows = false;
  ctx.oldest = undefined;
  ctx.oldestThrows = false;
});

describe("the wait-time reading", () => {
  test("is unavailable when an engine read fails, not a zero wait", async () => {
    ctx.oldestThrows = true;
    expect(await readWatchQueueOldestAge(environment, "task/send-receipt", NOW)).toBeNull();

    ctx.oldestThrows = false;
    ctx.breakdownThrows = true;
    expect(await readWatchQueueOldestAge(environment, "task/send-receipt", NOW)).toBeNull();
  });

  test("reports an empty queue as a reading with no age", async () => {
    expect(await readWatchQueueOldestAge(environment, "task/send-receipt", NOW)).toMatchObject({
      ageMs: null,
      source: "live_queue",
      current: true,
    });
  });
});

describe("a wait-time watch on a queue that is no longer there", () => {
  test("resolves terminally instead of sitting pending", async () => {
    const outcome = await checkWatch(SPEC, deps({ queueExists: async () => false }), {
      now: NOW,
      since: NOW,
    });

    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.facts).toMatchObject({ reason: "queue_not_found" });
  });

  test("stays pending while the queue exists and is simply empty", async () => {
    const outcome = await checkWatch(SPEC, deps(), { now: NOW, since: NOW });
    expect(outcome.result).toBe("pending");
  });

  test("is unavailable, not terminal, when the engine is down but the queue exists", async () => {
    ctx.breakdownThrows = true;
    const outcome = await checkWatch(SPEC, deps(), { now: NOW, since: NOW });

    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts).toMatchObject({ reason: "age_unavailable" });
  });
});
