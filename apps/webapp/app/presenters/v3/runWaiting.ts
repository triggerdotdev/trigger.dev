import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { parseNaturalLanguageDurationInMs } from "@trigger.dev/core/v3/isomorphic";
import type { PendingVersionView } from "./PendingVersionPresenter.server";
import type { RunQueueWaiting } from "./RunQueueMetricsPresenter.server";

// Why a run hasn't started, in one place, so every part of the dashboard says the same thing.
// Six groups, named for what the user should do; the API status stays in a tooltip.
export type NotStartedGroup =
  | "startingSoon"
  | "delayed"
  | "atLimit"
  | "paused"
  | "needsDeploy"
  | "wontStart";

const NOT_STARTED_GROUP_LABELS: Record<NotStartedGroup, string> = {
  startingSoon: "Starting soon",
  delayed: "Delayed",
  atLimit: "At a limit",
  paused: "Paused",
  needsDeploy: "Needs a deploy",
  wontStart: "Won't start",
};

/** The specific cause inside a group. */
type NotStartedCause =
  | "queued"
  | "versionDeploying"
  | "quiet"
  | "delayed"
  | "debounced"
  | "queuePaused"
  | "envPaused"
  | "billingPaused"
  | "adminPaused"
  | "queueLimit"
  | "keyLimit"
  | "totalLimit"
  | "envLimit"
  | "namedLimit"
  | "namedLimitPaused"
  | "devDisconnected"
  | "taskMissing"
  | "queueMissing"
  | "noDeployment"
  | "externalDeployment"
  | "lockedVersionMissing"
  | "externalExpired";

export type NotStartedAction =
  | "resumeQueue"
  | "resumeEnvironment"
  | "billingLimits"
  | "contactUs"
  | "changeLimit"
  | "openLimits"
  | "seeRunning"
  | "deploy"
  | "runDev"
  | "replay"
  | "cancel"
  | "statusPage"
  | "viewDeployment";

export type NotStarted = {
  group: NotStartedGroup;
  label: string;
  cause: NotStartedCause;
  /** Why it hasn't started, one plain sentence. */
  reason: string;
  /** What starts it, one sentence. */
  startsWhen: string;
  /** In order of importance; the first is the main one. */
  actions: NotStartedAction[];
  /** When the run expires if it still hasn't started (TTL, dev default, external deploy wait). */
  deadline: Date | null;
  /** When a delayed run starts. */
  startsAt: Date | null;
  /** The public API status, for the tooltip. */
  apiStatus: string;
  /** Debounced runs: when it would have started before a later trigger pushed it back, and the
   * latest it can be pushed to. */
  debounce?: { key: string; originalStartsAt: Date | null; latestStartsAt: Date | null };
  /** The capacity that holds it, for At a limit. */
  capacity?: {
    scope: "queue" | "key" | "total" | "environment" | "limit";
    name: string;
    running: number;
    limit: number;
    queued: number;
  };
};

/** One version in the environment's recent history. */
export type WaitingVersion = {
  version: string;
  /** Deployment short code for linking; null in dev. */
  shortCode: string | null;
  at: Date;
  hasTask: boolean;
  hasQueue: boolean;
  current: boolean;
  locked: boolean;
};

/** The answer plus the live state along the run's path, for the run page. */
export type RunWaitingView = {
  /** The run status this view was built from. */
  status: string;
  notStarted: NotStarted;
  createdAt: Date;
  environmentType: string;
  taskIdentifier: string;
  queue: {
    friendlyId: string | null;
    name: string;
    paused: boolean;
    queued: number | null;
    running: number | null;
    limit: number | null;
  };
  key: { key: string; queued: number; running: number; limit: number | null } | null;
  /** The queue's cap across every key, when it has one. */
  total: { running: number; limit: number } | null;
  /** The named concurrency limits the run also holds. */
  limits: RunQueueWaiting["limits"];
  env: {
    running: number;
    /** What the queue enforces: the base limit times the burst factor. */
    limit: number;
    /** The limit the Concurrency page shows. */
    baseLimit: number;
    paused: boolean;
    pauseSource: string | null;
  } | null;
  /** How long runs in this queue waited to start over the last hour. */
  usualWait: { p50Ms: number | null; p95Ms: number | null } | null;
  /** Starting soon: the run's locked version is still deploying. */
  deployingVersion: { version: string; shortCode: string; status: string; since: Date } | null;
  /** Oldest first. */
  versions: WaitingVersion[];
  lockedVersion: string | null;
  pending: PendingVersionView | null;
  canManageQueues: boolean;
};

// After this long waiting its turn with nothing on the user's side holding it, say so: it's the
// cue to check our status page. A run with nothing holding it is normally picked up in seconds
// (a cold start is under a minute or two), so 5 minutes is well past normal and still early
// enough to help in an incident. A queue that recently waited longer than that (its p95 over the
// last hour) gets twice its p95, so a queue that's often slow doesn't cry wolf, capped at 30m.
export const QUIET_AFTER_MS = 5 * 60 * 1000;
const QUIET_AFTER_MAX_MS = 30 * 60 * 1000;

export function quietAfterMs(p95Ms: number | null | undefined) {
  return Math.min(QUIET_AFTER_MAX_MS, Math.max(QUIET_AFTER_MS, (p95Ms ?? 0) * 2));
}
// The engine gives up on a run parked for an external deployment after an hour (from parking,
// which is about when the run was triggered).
const EXTERNAL_DEPLOYMENT_WAIT_MS = 60 * 60 * 1000;

/**
 * How long the run panel waits before asking again why a run hasn't started. A run can wait
 * for days (a delay, a missing deploy), so the poll slows down the longer the panel is open.
 */
export function waitingPollDelayMs(openForMs: number) {
  if (openForMs < 60_000) return 10_000;
  if (openForMs < 10 * 60_000) return 30_000;
  return 60_000;
}

export const NOT_STARTED_STATUSES = new Set([
  "PENDING",
  "DELAYED",
  "PENDING_VERSION",
  "WAITING_FOR_DEPLOY",
]);

/** An expired run whose stored reason says why it never started: the only after-the-fact case. */
export function isExplainedExpiry(status: string, statusReason: string | null | undefined) {
  return status === "EXPIRED" && statusReason === "EXTERNAL_DEPLOYMENT_PENDING";
}

export type NotStartedInput = {
  status: string;
  createdAt: Date;
  queuedAt: Date | null;
  delayUntil: Date | null;
  ttl: string | null;
  debounce: { key: string; delay?: string; maxDelay?: string } | null;
  /** When the run expired, for an expired run. */
  expiredAt?: Date | null;
  /** A queued run locked to a version whose deployment hasn't finished. */
  deployingVersion?: string | null;
  now: number;
  environment: {
    type: string;
    name: string;
    paused: boolean;
    pauseSource: string | null;
    /** Dev only: whether `trigger dev` is connected; null when unknown or not dev. */
    devConnected: boolean | null;
  };
  taskIdentifier: string;
  queue: { name: string; paused: boolean };
  /** Live counts from the run queue; null when unavailable. */
  waiting: RunQueueWaiting | null;
  pendingVersion: PendingVersionView | null;
};

export function describeNotStarted(input: NotStartedInput): NotStarted | null {
  const expired = isExplainedExpiry(input.status, input.pendingVersion?.statusReason);
  if (!NOT_STARTED_STATUSES.has(input.status) && !expired) return null;

  const apiStatus = input.status === "PENDING" ? "QUEUED" : input.status;
  const base = { apiStatus, deadline: null, startsAt: null };
  const make = (
    group: NotStartedGroup,
    rest: Omit<NotStarted, "group" | "label" | "apiStatus">
  ) => ({
    group,
    label: NOT_STARTED_GROUP_LABELS[group],
    apiStatus,
    ...rest,
  });

  if (expired) {
    const pending = input.pendingVersion;
    // Same group as Won't start, titled with what happened, since it's after the fact.
    return {
      ...make("wontStart", {
        ...base,
        cause: "externalExpired",
        reason: pending?.externalDeploymentId
          ? `Expired after waiting an hour for your app's deployment ${pending.externalDeploymentId}, which never arrived.`
          : "Expired after waiting an hour for your app's deployment, which never arrived.",
        startsWhen: "It won't run now. Replay it to run it on the current version.",
        actions: ["replay"],
        deadline: input.expiredAt ?? null,
      }),
      label: "Expired",
    };
  }

  if (input.status === "PENDING_VERSION" || input.status === "WAITING_FOR_DEPLOY") {
    return describePendingVersion(input, make);
  }

  if (input.status === "DELAYED") {
    const at = input.delayUntil;
    // TTL starts counting once the delay ends.
    const deadline = at ? ttlDeadline(input.ttl, at) : null;
    if (input.debounce) {
      const { key } = input.debounce;
      const delayMs = input.debounce.delay
        ? parseNaturalLanguageDurationInMs(input.debounce.delay)
        : undefined;
      const maxMs = input.debounce.maxDelay
        ? parseNaturalLanguageDurationInMs(input.debounce.maxDelay)
        : undefined;
      const originalStartsAt =
        delayMs !== undefined ? new Date(input.createdAt.getTime() + delayMs) : null;
      // A second of slack: delayUntil is computed from a slightly later clock than createdAt.
      const pushed = !!at && !!originalStartsAt && at.getTime() - originalStartsAt.getTime() > 1000;
      return make("delayed", {
        cause: "debounced",
        reason: pushed
          ? `Pushed back by a later trigger with debounce key ${key}.`
          : `Debounced with key ${key}: a later trigger with the same key pushes it back.`,
        startsWhen: "Starts at the time shown, unless another trigger with the same key arrives.",
        actions: ["cancel"],
        deadline,
        startsAt: at,
        debounce: {
          key,
          originalStartsAt: pushed ? originalStartsAt : null,
          latestStartsAt: maxMs !== undefined ? new Date(input.createdAt.getTime() + maxMs) : null,
        },
      });
    }
    return make("delayed", {
      cause: "delayed",
      reason: at
        ? `Triggered with a ${formatDurationMilliseconds(Math.max(0, Math.round((at.getTime() - input.createdAt.getTime()) / 1000) * 1000), { style: "short", maxDecimalPoints: 0 })} delay.`
        : "Triggered with a delay.",
      startsWhen: "Starts when the delay ends.",
      actions: ["cancel"],
      deadline,
      startsAt: at,
    });
  }

  // PENDING: in the queue, held by whatever is in its way now.
  const deadline = ttlDeadline(input.ttl, input.queuedAt ?? input.createdAt);
  const { environment, waiting } = input;

  if (environment.paused) {
    if (environment.pauseSource === "ADMIN_BAN") {
      return make("paused", {
        ...base,
        cause: "adminPaused",
        reason: `${environment.name} was paused by Trigger.dev.`,
        startsWhen: "Starts when the environment is resumed. Contact us to resume it.",
        actions: ["contactUs"],
        deadline,
      });
    }
    if (environment.pauseSource === "BILLING_LIMIT") {
      return make("paused", {
        ...base,
        cause: "billingPaused",
        reason: `${environment.name} is paused because your billing limit was reached.`,
        startsWhen: "Starts when the billing limit is raised or the billing period resets.",
        actions: ["billingLimits"],
        deadline,
      });
    }
    return make("paused", {
      ...base,
      cause: "envPaused",
      reason: `${environment.name} is paused.`,
      startsWhen: "Starts when the environment is resumed.",
      actions: ["resumeEnvironment"],
      deadline,
    });
  }

  if (environment.type === "DEVELOPMENT" && environment.devConnected === false) {
    return make("needsDeploy", {
      ...base,
      cause: "devDisconnected",
      reason: "trigger dev isn't running, so nothing can pick this run up.",
      startsWhen: "Starts when you run trigger dev.",
      actions: ["runDev"],
      deadline,
    });
  }

  if (input.queue.paused) {
    return make("paused", {
      ...base,
      cause: "queuePaused",
      reason: `Queue ${input.queue.name} is paused.`,
      startsWhen: "Starts when the queue is resumed.",
      actions: ["resumeQueue"],
      deadline,
    });
  }

  if (waiting) {
    const key = waiting.concurrencyKey;
    // A temporary per-key override replaces the queue's per-key limit for that key.
    const limit = key?.limitOverride ?? waiting.concurrencyLimit;
    const total = waiting.total;
    // The queue clamps every per-queue and per-key limit to the environment's base limit (the
    // burst factor only applies across queues), so a queue with no limit, or a higher one, is
    // still full at the environment's base limit.
    const envBase = waiting.env.baseLimit;
    const n = (v: number) => v.toLocaleString();
    const holds = (
      cause: "keyLimit" | "queueLimit" | "totalLimit" | "envLimit",
      capacity: NonNullable<NotStarted["capacity"]>,
      reason: string,
      startsWhen: string
    ) =>
      make("atLimit", {
        ...base,
        cause,
        reason,
        startsWhen,
        actions: cause === "envLimit" ? ["seeRunning"] : ["changeLimit", "seeRunning"],
        deadline,
        capacity,
      });

    // A key's runs are capped by the key's own limit (perKey), then by the queue's total across
    // every key; runs without a key share one pool capped by the queue's limit.
    if (key && limit !== null && key.running >= Math.min(limit, envBase)) {
      const keyLimit = Math.min(limit, envBase);
      return holds(
        "keyLimit",
        { scope: "key", name: key.key, running: key.running, limit: keyLimit, queued: key.queued },
        `Key ${key.key} is full: ${n(key.running)} of ${n(keyLimit)} running.`,
        "Starts when a run with this key finishes."
      );
    }
    if (key && limit === null && key.running >= envBase) {
      return holds(
        "envLimit",
        {
          scope: "environment",
          name: environment.name,
          running: key.running,
          limit: envBase,
          queued: key.queued,
        },
        `Key ${key.key} is at ${environment.name}'s limit of ${n(envBase)} running per key.`,
        "Starts when a run with this key finishes."
      );
    }
    if (!key && (limit === null || limit > envBase) && waiting.running >= envBase) {
      return holds(
        "envLimit",
        {
          scope: "environment",
          name: environment.name,
          running: waiting.running,
          limit: envBase,
          queued: waiting.queued,
        },
        `Queue ${input.queue.name} is at ${environment.name}'s limit of ${n(envBase)} running per queue.`,
        "Starts when a run in this queue finishes."
      );
    }
    if (!key && limit !== null && waiting.running >= limit) {
      return holds(
        "queueLimit",
        {
          scope: "queue",
          name: input.queue.name,
          running: waiting.running,
          limit,
          queued: waiting.queued,
        },
        `Queue ${input.queue.name} is full: ${n(waiting.running)} of ${n(limit)} running.`,
        "Starts when a run in this queue finishes."
      );
    }
    if (total && total.running >= total.limit) {
      return holds(
        "totalLimit",
        { scope: "total", name: input.queue.name, ...total, queued: waiting.queued },
        `Queue ${input.queue.name} is full across every key: ${n(total.running)} of ${n(total.limit)} running.`,
        "Starts when any run in this queue finishes, whatever its key."
      );
    }
    // Named limits (`concurrency: { limits: [...] }`): the run also needs a slot in each.
    for (const named of waiting.limits) {
      if (named.paused) {
        return make("paused", {
          ...base,
          cause: "namedLimitPaused",
          reason: `Concurrency limit ${named.name} is paused.`,
          startsWhen: "Starts when the limit is resumed.",
          actions: ["openLimits"],
          deadline,
        });
      }
      const limitHolds = (
        capacity: { running: number; limit: number },
        reason: string,
        startsWhen: string
      ) =>
        make("atLimit", {
          ...base,
          cause: "namedLimit",
          reason,
          startsWhen,
          actions: ["openLimits"],
          deadline,
          capacity: { scope: "limit", name: named.name, ...capacity, queued: named.queued },
        });
      const perKey = named.perKey;
      if (perKey && perKey.running >= perKey.limit) {
        return limitHolds(
          perKey,
          perKey.key
            ? `Concurrency limit ${named.name} is full for key ${perKey.key}: ${n(perKey.running)} of ${n(perKey.limit)} running.`
            : `Concurrency limit ${named.name} is full: ${n(perKey.running)} of ${n(perKey.limit)} running.`,
          perKey.key
            ? "Starts when a run holding this limit with the same key finishes."
            : "Starts when a run holding this limit finishes."
        );
      }
      if (named.total && named.total.running >= named.total.limit) {
        return limitHolds(
          named.total,
          `Concurrency limit ${named.name} is full across every key: ${n(named.total.running)} of ${n(named.total.limit)} running.`,
          "Starts when any run holding this limit finishes."
        );
      }
    }
    if (waiting.env.running >= waiting.env.limit) {
      return holds(
        "envLimit",
        {
          scope: "environment",
          name: environment.name,
          running: waiting.env.running,
          limit: waiting.env.limit,
          queued: waiting.queued,
        },
        waiting.env.limit > envBase
          ? `${environment.name} is full: ${n(waiting.env.running)} running, its limit of ${n(envBase)} plus burst.`
          : `${environment.name} is full: ${n(waiting.env.running)} of ${n(envBase)} running.`,
        "Starts when a run in this environment finishes."
      );
    }
  }

  // Locked to a version that's still deploying: the engine keeps it queued and checks again until
  // the deploy finishes (or fails, which fails the run).
  if (input.deployingVersion) {
    return make("startingSoon", {
      ...base,
      cause: "versionDeploying",
      reason: `Its version ${input.deployingVersion} is still deploying.`,
      startsWhen: "Starts when the deploy finishes. If the deploy fails, the run fails too.",
      actions: ["viewDeployment"],
      deadline,
    });
  }

  const waitedMs = input.now - (input.queuedAt ?? input.createdAt).getTime();
  if (waitedMs >= quietAfterMs(waiting?.delayP95Ms)) {
    // Without live counts a full queue or a limit can't be ruled out, so nothing here can say
    // the run isn't held on the user's side.
    if (!waiting) {
      return make("startingSoon", {
        ...base,
        cause: "queued",
        reason: `Waiting its turn in queue ${input.queue.name}.`,
        startsWhen:
          "Live counts for this queue aren't available, so a full queue or a concurrency limit can't be ruled out.",
        actions: [],
        deadline,
      });
    }
    // Nothing we can see holds it. Don't claim certainty: say what we checked and where to look.
    return make("startingSoon", {
      ...base,
      cause: "quiet",
      reason: "Nothing on your side is holding this run.",
      startsWhen: "It should start any moment. If it doesn't, check our status page.",
      actions: ["statusPage"],
      deadline,
    });
  }

  const ahead = waiting ? Math.max(0, waiting.queued - 1) : 0;
  return make("startingSoon", {
    ...base,
    cause: "queued",
    reason:
      ahead > 0
        ? `Waiting its turn in queue ${input.queue.name}, behind ${ahead.toLocaleString()} other ${ahead === 1 ? "run" : "runs"}.`
        : `Waiting its turn in queue ${input.queue.name}.`,
    startsWhen: "Starts as soon as the queue reaches it.",
    actions: [],
    deadline,
  });
}

function describePendingVersion(
  input: NotStartedInput,
  make: (
    group: NotStartedGroup,
    rest: Omit<NotStarted, "group" | "label" | "apiStatus">
  ) => NotStarted
): NotStarted {
  const pending = input.pendingVersion;
  const statusReason = pending?.statusReason;
  const reason =
    pending?.reason ?? "Waiting for a version that includes this run's task and queue.";
  const base = { deadline: null, startsAt: null };

  if (statusReason === "EXTERNAL_DEPLOYMENT_PENDING") {
    return make("needsDeploy", {
      ...base,
      cause: "externalDeployment",
      reason,
      startsWhen: "Starts when that deployment finishes.",
      actions: [],
      deadline: new Date(
        (input.delayUntil ?? input.createdAt).getTime() + EXTERNAL_DEPLOYMENT_WAIT_MS
      ),
    });
  }

  // A run locked to a version only ever runs on that version, and nothing releases it: no deploy
  // can add the task to an old version.
  if (pending?.lockedVersion) {
    const locked = pending.lockedVersion;
    return make("wontStart", {
      ...base,
      cause: "lockedVersionMissing",
      reason:
        statusReason === "QUEUE_NOT_FOUND"
          ? `Locked to ${locked}, which doesn't have queue ${input.queue.name}.`
          : statusReason === "NO_DEPLOYMENT" || statusReason === "NO_WORKER"
            ? `Locked to ${locked}, which can't be found in this environment.`
            : `Locked to ${locked}, which doesn't have ${input.taskIdentifier}.`,
      startsWhen: "No deploy will start it. Replay it to run it on the current version.",
      actions: ["replay", "cancel"],
    });
  }

  const cause: NotStartedCause =
    statusReason === "QUEUE_NOT_FOUND"
      ? "queueMissing"
      : statusReason === "NO_DEPLOYMENT" || statusReason === "NO_WORKER" || !pending?.current
        ? "noDeployment"
        : "taskMissing";

  return make("needsDeploy", {
    ...base,
    cause,
    reason,
    startsWhen:
      cause === "queueMissing"
        ? "Starts when a deploy includes this queue."
        : "Starts when a deploy includes this task.",
    actions: [input.environment.type === "DEVELOPMENT" ? "runDev" : "deploy"],
  });
}

function ttlDeadline(ttl: string | null, from: Date): Date | null {
  if (!ttl) return null;
  const ms = parseNaturalLanguageDurationInMs(ttl);
  return ms === undefined ? null : new Date(from.getTime() + ms);
}
