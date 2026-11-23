import { describe, expect, it } from "vitest";
import type { PendingVersionView } from "~/presenters/v3/PendingVersionPresenter.server";
import type { RunQueueWaiting } from "~/presenters/v3/RunQueueMetricsPresenter.server";
import {
  describeNotStarted,
  type NotStartedInput,
  QUIET_AFTER_MS,
  quietAfterMs,
} from "~/presenters/v3/runWaiting";

const createdAt = new Date("2026-11-16T10:00:00Z");

function waiting(overrides: {
  queued?: number;
  running?: number;
  limit?: number | null;
  env?: { running: number; limit: number; baseLimit?: number };
  key?: { key: string; queued: number; running: number; limitOverride?: number };
  total?: { running: number; limit: number };
  p95Ms?: number;
  limits?: RunQueueWaiting["limits"];
}): RunQueueWaiting {
  return {
    queued: overrides.queued ?? 1,
    running: overrides.running ?? 0,
    concurrencyLimit: overrides.limit ?? null,
    delayP50Ms: null,
    delayP95Ms: overrides.p95Ms ?? null,
    loadedAt: 0,
    ids: { organizationId: "o", projectId: "p", environmentId: "e" },
    env: { baseLimit: 100, ...(overrides.env ?? { running: 0, limit: 100 }) },
    total: overrides.total ?? null,
    concurrencyKey: overrides.key
      ? { limitOverride: null, ...overrides.key, oldestWaitMs: null }
      : null,
    limits: overrides.limits ?? [],
  };
}

function input(overrides: Partial<NotStartedInput> = {}): NotStartedInput {
  return {
    status: "PENDING",
    createdAt,
    queuedAt: createdAt,
    delayUntil: null,
    ttl: null,
    debounce: null,
    now: createdAt.getTime() + 1000,
    environment: {
      type: "PRODUCTION",
      name: "Production",
      paused: false,
      pauseSource: null,
      devConnected: null,
    },
    taskIdentifier: "send-email",
    queue: { name: "emails", paused: false },
    waiting: waiting({}),
    pendingVersion: null,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingVersionView>): PendingVersionView {
  return {
    reason: "send-email isn't in the current version 20261116.2.",
    releasedBy: "Starts when a deploy includes this task.",
    statusReason: "TASK_NOT_IN_LATEST",
    current: { version: "20261116.2", shortCode: "abc" },
    lockedVersion: undefined,
    ...overrides,
  };
}

const env = input().environment;

describe("describeNotStarted", () => {
  it("is null once the run has started", () => {
    expect(describeNotStarted(input({ status: "EXECUTING" }))).toBeNull();
    expect(describeNotStarted(input({ status: "DEQUEUED" }))).toBeNull();
  });

  // Catches: a plain wait in line shown as a problem.
  it("Starting soon: waiting its turn, with no action", () => {
    const r = describeNotStarted(input({ waiting: waiting({ queued: 3 }) }))!;
    expect(r.group).toBe("startingSoon");
    expect(r.label).toBe("Starting soon");
    expect(r.reason).toBe("Waiting its turn in queue emails, behind 2 other runs.");
    expect(r.actions).toEqual([]);
    expect(r.apiStatus).toBe("QUEUED");
  });

  it("Starting soon: its locked version is still deploying", () => {
    const r = describeNotStarted(input({ deployingVersion: "20261116.3" }))!;
    expect(r.group).toBe("startingSoon");
    expect(r.cause).toBe("versionDeploying");
    expect(r.reason).toBe("Its version 20261116.3 is still deploying.");
    expect(r.actions).toEqual(["viewDeployment"]);
    // A full queue is the better answer when both apply.
    expect(
      describeNotStarted(
        input({ deployingVersion: "20261116.3", waiting: waiting({ running: 5, limit: 5 }) })
      )!.cause
    ).toBe("queueLimit");
  });

  // Catches: a queue that's usually slow saying "nothing is holding this run" during normal waits.
  it("Starting soon: quiet after 5m, or twice the queue's recent p95, at most 30m", () => {
    expect(quietAfterMs(null)).toBe(QUIET_AFTER_MS);
    expect(quietAfterMs(60_000)).toBe(QUIET_AFTER_MS);
    expect(quietAfterMs(4 * 60_000)).toBe(8 * 60_000);
    expect(quietAfterMs(60 * 60_000)).toBe(30 * 60_000);
    const slowQueue = describeNotStarted(
      input({ now: createdAt.getTime() + 6 * 60_000, waiting: waiting({ p95Ms: 4 * 60_000 }) })
    )!;
    expect(slowQueue.cause).toBe("queued");
  });

  // Catches: a run held by a full queue being told "nothing on your side is holding this run"
  // when the live counts that would show the full queue aren't available.
  it("Starting soon: without live counts, never says nothing is holding the run", () => {
    const r = describeNotStarted(
      input({ now: createdAt.getTime() + QUIET_AFTER_MS + 1, waiting: null })
    )!;
    expect(r.group).toBe("startingSoon");
    expect(r.cause).toBe("queued");
    expect(r.actions).toEqual([]);
    expect(r.startsWhen).toContain("can't be ruled out");
  });

  // Catches: an incident looking like a normal wait forever.
  it("Starting soon: after a few quiet minutes, says nothing on the user's side holds it", () => {
    const r = describeNotStarted(input({ now: createdAt.getTime() + QUIET_AFTER_MS + 1 }))!;
    expect(r.group).toBe("startingSoon");
    expect(r.cause).toBe("quiet");
    expect(r.actions).toEqual(["statusPage"]);
  });

  it("Delayed: delayed and debounced runs start at delayUntil, TTL counts after it", () => {
    const delayUntil = new Date("2026-11-16T14:00:00Z");
    const delayed = describeNotStarted(input({ status: "DELAYED", delayUntil, ttl: "10m" }))!;
    expect(delayed.group).toBe("delayed");
    expect(delayed.cause).toBe("delayed");
    expect(delayed.reason).toBe("Triggered with a 4h delay.");
    expect(delayed.startsAt).toEqual(delayUntil);
    expect(delayed.deadline).toEqual(new Date("2026-11-16T14:10:00Z"));

    const debounced = describeNotStarted(
      input({ status: "DELAYED", delayUntil, debounce: { key: "user-1" } })
    )!;
    expect(debounced.cause).toBe("debounced");
    expect(debounced.reason).toContain("user-1");
  });

  // Catches: a debounced run that a later trigger pushed back reading as if nothing happened.
  it("Delayed: debounced, pushed back by a later trigger, with the latest it can go", () => {
    const pushed = describeNotStarted(
      input({
        status: "DELAYED",
        // Triggered 10:00 with a 5m debounce, pushed to 10:12 by later triggers.
        delayUntil: new Date("2026-11-16T10:12:00Z"),
        debounce: { key: "user-1", delay: "5m", maxDelay: "30m" },
      })
    )!;
    expect(pushed.reason).toBe("Pushed back by a later trigger with debounce key user-1.");
    expect(pushed.debounce).toEqual({
      key: "user-1",
      originalStartsAt: new Date("2026-11-16T10:05:00Z"),
      latestStartsAt: new Date("2026-11-16T10:30:00Z"),
    });

    const notPushed = describeNotStarted(
      input({
        status: "DELAYED",
        delayUntil: new Date("2026-11-16T10:05:00Z"),
        debounce: { key: "user-1", delay: "5m" },
      })
    )!;
    expect(notPushed.reason).toContain("a later trigger with the same key pushes it back");
    expect(notPushed.debounce?.originalStartsAt).toBeNull();
    expect(notPushed.debounce?.latestStartsAt).toBeNull();
  });

  // Catches: comparing the queue-wide running count against a per-key limit.
  it("At a limit: key, queue, then environment", () => {
    const key = { key: "user_123", queued: 1, running: 1 };
    expect(
      describeNotStarted(
        input({ waiting: waiting({ running: 8, limit: 2, key: { ...key, running: 1 } }) })
      )!.group
    ).toBe("startingSoon");
    const keyFull = describeNotStarted(input({ waiting: waiting({ running: 8, limit: 1, key }) }))!;
    expect(keyFull.group).toBe("atLimit");
    expect(keyFull.cause).toBe("keyLimit");
    expect(keyFull.capacity).toMatchObject({ scope: "key", running: 1, limit: 1 });

    const queueFull = describeNotStarted(input({ waiting: waiting({ running: 5, limit: 5 }) }))!;
    expect(queueFull.cause).toBe("queueLimit");
    expect(queueFull.reason).toBe("Queue emails is full: 5 of 5 running.");
    expect(queueFull.actions[0]).toBe("changeLimit");

    const envFull = describeNotStarted(
      input({ waiting: waiting({ env: { running: 100, limit: 100 } }) })
    )!;
    expect(envFull.cause).toBe("envLimit");
    expect(envFull.actions).toEqual(["seeRunning"]);
  });

  // Catches: a run held by a named concurrency limit (`concurrency: { limits: [orgLimit] }`)
  // shown as "Starting soon" although its own queue has room.
  it("At a limit: a named limit the run holds, per key and in total", () => {
    const keyFull = describeNotStarted(
      input({
        waiting: waiting({
          limits: [
            {
              name: "org-limit",
              paused: false,
              queued: 4,
              perKey: { key: "org_1", running: 2, limit: 2 },
              total: null,
            },
          ],
        }),
      })
    )!;
    expect(keyFull.group).toBe("atLimit");
    expect(keyFull.cause).toBe("namedLimit");
    expect(keyFull.reason).toBe(
      "Concurrency limit org-limit is full for key org_1: 2 of 2 running."
    );
    expect(keyFull.capacity).toMatchObject({ scope: "limit", name: "org-limit", running: 2 });
    expect(keyFull.actions).toEqual(["openLimits"]);

    const totalFull = describeNotStarted(
      input({
        waiting: waiting({
          limits: [
            {
              name: "openai",
              paused: false,
              queued: 1,
              perKey: null,
              total: { running: 10, limit: 10 },
            },
          ],
        }),
      })
    )!;
    expect(totalFull.cause).toBe("namedLimit");
    expect(totalFull.capacity).toMatchObject({ running: 10, limit: 10 });

    const room = describeNotStarted(
      input({
        waiting: waiting({
          limits: [
            {
              name: "openai",
              paused: false,
              queued: 0,
              perKey: { key: null, running: 1, limit: 5 },
              total: { running: 3, limit: 10 },
            },
          ],
        }),
      })
    )!;
    expect(room.group).toBe("startingSoon");

    const paused = describeNotStarted(
      input({
        waiting: waiting({
          limits: [{ name: "openai", paused: true, queued: 0, perKey: null, total: null }],
        }),
      })
    )!;
    expect(paused.group).toBe("paused");
    expect(paused.cause).toBe("namedLimitPaused");
  });

  // Catches: a keyed run held by the queue's cap across every key shown as "Starting soon".
  it("At a limit: the queue total holds keyed and keyless runs alike", () => {
    const keyed = describeNotStarted(
      input({
        waiting: waiting({
          queued: 7,
          limit: 2,
          key: { key: "user_1", queued: 1, running: 1 },
          total: { running: 10, limit: 10 },
        }),
      })
    )!;
    expect(keyed.cause).toBe("totalLimit");
    expect(keyed.capacity).toMatchObject({ scope: "total", running: 10, limit: 10, queued: 7 });
    expect(keyed.reason).toBe("Queue emails is full across every key: 10 of 10 running.");

    const keyless = describeNotStarted(
      input({ waiting: waiting({ running: 3, limit: 5, total: { running: 4, limit: 4 } }) })
    )!;
    expect(keyless.cause).toBe("totalLimit");
  });

  // Catches: a queue with no limit shown as "Starting soon" while the environment's base limit
  // caps it (burst only applies across queues).
  it("At a limit: a queue is capped at the environment's base limit, burst or not", () => {
    const r = describeNotStarted(
      input({
        waiting: waiting({ running: 1, queued: 3, env: { running: 1, limit: 2, baseLimit: 1 } }),
      })
    )!;
    expect(r.cause).toBe("envLimit");
    expect(r.reason).toBe("Queue emails is at Production's limit of 1 running per queue.");
    expect(r.capacity).toMatchObject({ scope: "environment", running: 1, limit: 1 });
  });

  // Catches: a key with no per-key limit shown as "Starting soon" while the environment's base
  // limit caps each key's pool and burst leaves the environment itself with room.
  it("At a limit: a key with no limit is capped at the environment's base limit", () => {
    const r = describeNotStarted(
      input({
        waiting: waiting({
          running: 2,
          env: { running: 2, limit: 4, baseLimit: 2 },
          key: { key: "customer-a", queued: 1, running: 2 },
        }),
      })
    )!;
    expect(r.cause).toBe("envLimit");
    expect(r.reason).toBe("Key customer-a is at Production's limit of 2 running per key.");
    expect(r.capacity).toMatchObject({ scope: "environment", running: 2, limit: 2, queued: 1 });
  });

  // Catches: ignoring a per-key override that lowers one key's limit.
  it("At a limit: a per-key override replaces the queue's per-key limit", () => {
    const r = describeNotStarted(
      input({
        waiting: waiting({
          limit: 5,
          key: { key: "big", queued: 2, running: 1, limitOverride: 1 },
        }),
      })
    )!;
    expect(r.cause).toBe("keyLimit");
    expect(r.capacity).toMatchObject({ scope: "key", running: 1, limit: 1, queued: 2 });
  });

  // Catches: a paused environment (limit 0) read as "Environment is full: 0 of 0".
  it("Paused: environment pause wins over limits, by source", () => {
    const zero = waiting({ env: { running: 0, limit: 0 } });
    const user = describeNotStarted(
      input({ environment: { ...env, paused: true }, waiting: zero })
    )!;
    expect(user.group).toBe("paused");
    expect(user.cause).toBe("envPaused");
    expect(user.actions).toEqual(["resumeEnvironment"]);

    const billing = describeNotStarted(
      input({ environment: { ...env, paused: true, pauseSource: "BILLING_LIMIT" } })
    )!;
    expect(billing.cause).toBe("billingPaused");
    expect(billing.actions).toEqual(["billingLimits"]);

    const admin = describeNotStarted(
      input({ environment: { ...env, paused: true, pauseSource: "ADMIN_BAN" } })
    )!;
    expect(admin.cause).toBe("adminPaused");
    expect(admin.actions).toEqual(["contactUs"]);
  });

  // Catches: a paused queue reading as a limit when it's also full.
  it("Paused: a paused queue comes before a full one", () => {
    const r = describeNotStarted(
      input({ queue: { name: "emails", paused: true }, waiting: waiting({ running: 5, limit: 5 }) })
    )!;
    expect(r.group).toBe("paused");
    expect(r.cause).toBe("queuePaused");
    expect(r.actions).toEqual(["resumeQueue"]);
  });

  it("Paused works without live queue counts", () => {
    const r = describeNotStarted(
      input({ queue: { name: "emails", paused: true }, waiting: null })
    )!;
    expect(r.cause).toBe("queuePaused");
  });

  it("TTL is a deadline from when the run was queued", () => {
    const r = describeNotStarted(input({ ttl: "1h" }))!;
    expect(r.deadline).toEqual(new Date("2026-11-16T11:00:00Z"));
  });

  it("Needs a deploy: dev with trigger dev stopped", () => {
    const r = describeNotStarted(
      input({ environment: { ...env, type: "DEVELOPMENT", devConnected: false }, ttl: "10m" })
    )!;
    expect(r.group).toBe("needsDeploy");
    expect(r.cause).toBe("devDisconnected");
    expect(r.actions).toEqual(["runDev"]);
    expect(r.deadline).not.toBeNull();
  });

  it("Needs a deploy: pending version causes, with the deploy action", () => {
    const task = describeNotStarted(
      input({ status: "PENDING_VERSION", pendingVersion: pending({}) })
    )!;
    expect(task.group).toBe("needsDeploy");
    expect(task.cause).toBe("taskMissing");
    expect(task.actions).toEqual(["deploy"]);
    expect(task.apiStatus).toBe("PENDING_VERSION");
    // Pending-version runs don't expire by TTL.
    expect(
      describeNotStarted(
        input({ status: "PENDING_VERSION", ttl: "1h", pendingVersion: pending({}) })
      )!.deadline
    ).toBeNull();

    expect(
      describeNotStarted(
        input({
          status: "PENDING_VERSION",
          pendingVersion: pending({ statusReason: "QUEUE_NOT_FOUND" }),
        })
      )!.cause
    ).toBe("queueMissing");
    expect(
      describeNotStarted(
        input({
          status: "PENDING_VERSION",
          pendingVersion: pending({ statusReason: "NO_DEPLOYMENT", current: undefined }),
        })
      )!.cause
    ).toBe("noDeployment");
  });

  it("Needs a deploy: waiting for an external deployment expires after an hour", () => {
    const r = describeNotStarted(
      input({
        status: "PENDING_VERSION",
        pendingVersion: pending({ statusReason: "EXTERNAL_DEPLOYMENT_PENDING" }),
      })
    )!;
    expect(r.cause).toBe("externalDeployment");
    expect(r.actions).toEqual([]);
    expect(r.deadline).toEqual(new Date("2026-11-16T11:00:00Z"));
  });

  // Catches: a run locked to a version without its task shown as harmless "pending version".
  it("Won't start: locked to a version without the task", () => {
    const r = describeNotStarted(
      input({ status: "PENDING_VERSION", pendingVersion: pending({ lockedVersion: "20261115.4" }) })
    )!;
    expect(r.group).toBe("wontStart");
    expect(r.label).toBe("Won't start");
    expect(r.reason).toBe("Locked to 20261115.4, which doesn't have send-email.");
    expect(r.actions).toEqual(["replay", "cancel"]);
  });

  // Catches: an expired skew-protected run with no explanation of why it never ran.
  it("Expired: a run that waited an hour for an app deployment says so, after the fact", () => {
    const expiredAt = new Date("2026-11-16T11:00:00Z");
    const r = describeNotStarted(
      input({
        status: "EXPIRED",
        expiredAt,
        pendingVersion: pending({
          statusReason: "EXTERNAL_DEPLOYMENT_PENDING",
          externalDeploymentId: "4324c22",
        }),
      })
    )!;
    expect(r.group).toBe("wontStart");
    expect(r.label).toBe("Expired");
    expect(r.cause).toBe("externalExpired");
    expect(r.reason).toContain("4324c22");
    expect(r.actions).toEqual(["replay"]);
    expect(r.deadline).toEqual(expiredAt);
    // Other expired runs: nothing stored says why, so no card.
    expect(describeNotStarted(input({ status: "EXPIRED", pendingVersion: null }))).toBeNull();
  });
});
