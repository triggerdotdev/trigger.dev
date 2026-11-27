import type { TaskQueue } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { getUserById } from "~/models/user.server";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { ArchiveQueueService, archiveQueueErrorMessage } from "~/v3/services/archiveQueue.server";
import { getManualPauseEnvironmentResult } from "~/v3/services/billingLimit/manualPauseEnvironmentGuard.server";
import { isUnlistedInlineLimit } from "~/v3/services/concurrencyLimitNames.server";
import { materializePercentLimit } from "~/v3/services/concurrencySystem.server";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";
import { engine } from "~/v3/runEngine.server";
import type { McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { plainError } from "./format/insights";
import { queueNotFound } from "./format/queues";
import { quoteForPreview } from "./format/webhooks";
import { CommonProjectsInput } from "./schemas/common";
import { OverrideQueueInput, QueueWriteInput } from "./schemas/queues";

const auth = { action: "write", subject: "tasks" } as const;

const BRANCH_ARCHIVED = "This branch is archived; nothing changed.";
const PREVIEW_PARENT =
  "The preview environment itself runs nothing; pass branch to choose a preview branch; nothing changed.";
const ENVIRONMENT_NOT_FOUND = "Environment not found; nothing changed.";
const TRY_AGAIN = "The change could not be made. Try again later.";
/** A task's inline limit with no bounds: retired or an active unbounded gate, which look the same. */
const unlistedInlineLimit = (queueId: string, paused: boolean) => ({
  refuse: `${queueId} is a task's inline limit with no limits set; it is not managed here. Set perKey/total in the task's code and deploy${paused ? ". Its saved pause can be released with resume_queue" : ""}; nothing changed.`,
});

const QUEUE_CHANGED =
  "The queue was changed by another request before this ran; nothing changed. Call the tool again.";

/** A write refused because the row moved since the plan read it: stale for an approved call. */
const queueChanged = (ctx: McpToolContext) =>
  ctx.confirmation ? staleAnswer(plainError) : plainError(QUEUE_CHANGED);

type Refusal = { refuse: string };
type Plan<T> = Refusal | ({ preview: string } & T);

const nothingChanged = (text: string) => `${text.replace(/\.$/, "")}; nothing changed.`;

const queueMissing = (queueId: string) => ({ refuse: nothingChanged(queueNotFound(queueId)) });

function logFailure(tool: string, error: unknown) {
  logger.error("MCP queue tool failed", {
    tool,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

async function environmentFor(subject: McpSubject | null) {
  if (!subject?.projectId || !subject.environmentId) return null;
  // Primary: the preview and the approved run both check its cap, pause and archive state.
  const environment = await findEnvironmentById(subject.environmentId, prisma);
  return environment?.projectId === subject.projectId ? environment : null;
}

async function isPreviewParent(environment: AuthenticatedEnvironment) {
  if (environment.type !== "PREVIEW" || environment.parentEnvironmentId) return false;
  const row = await prisma.runtimeEnvironment.findFirst({
    where: { id: environment.id },
    select: { type: true, parentEnvironmentId: true, isBranchableEnvironment: true },
  });
  return row !== null && isBranchableEnvironment(row);
}

async function writableEnvironment(
  subject: McpSubject | null
): Promise<Refusal | { environment: AuthenticatedEnvironment }> {
  const environment = await environmentFor(subject);
  if (!environment) return { refuse: ENVIRONMENT_NOT_FOUND };
  if (environment.archivedAt) return { refuse: BRANCH_ARCHIVED };
  if (await isPreviewParent(environment)) return { refuse: PREVIEW_PARENT };
  return { environment };
}

function withPlan<A, T>(
  plan: (args: A, environment: AuthenticatedEnvironment) => Promise<Plan<T>>
) {
  return {
    preview: async (args: A, subject: McpSubject | null) => {
      const env = await writableEnvironment(subject);
      if ("refuse" in env) return env;
      const built = await plan(args, env.environment);
      return "refuse" in built ? built : built.preview;
    },
    run: async (
      args: A,
      ctx: McpToolContext,
      write: (planned: T, environment: AuthenticatedEnvironment) => Promise<McpToolResult>
    ) => {
      const env = await writableEnvironment(ctx.subject);
      if ("refuse" in env) return plainError(env.refuse);
      const built = await plan(args, env.environment);
      if ("refuse" in built) return plainError(built.refuse);
      const stale = staleApproval(ctx, built.preview, plainError);
      if (stale) return stale;
      return write(built, env.environment);
    },
  };
}

const quotedQueue = (queue: Pick<TaskQueue, "name" | "friendlyId">) =>
  `${quoteForPreview(queue.name)} (${queue.friendlyId})`;

const noun = (queue: Pick<TaskQueue, "role">) =>
  queue.role === "LIMIT" ? "concurrency limit" : "queue";

const perKeyNow = (limit: number | null, envLimit: number) =>
  limit === null ? `none (the environment limit of ${envLimit} applies)` : String(limit);

const envPausedLine = (environment: AuthenticatedEnvironment) =>
  environment.paused
    ? ["The environment is paused, so nothing starts until it is resumed as well."]
    : [];

const numbered = (lines: string[]) => lines.map((line, i) => `${i + 1}. ${line}`);

async function findQueue(environment: AuthenticatedEnvironment, queueId: string) {
  return prisma.taskQueue.findFirst({
    where: {
      friendlyId: queueId,
      runtimeEnvironmentId: environment.id,
      role: { in: ["QUEUE", "LIMIT"] },
    },
  });
}

type QueueArgs = { queueId: string };

const ENGINE_UNREADABLE = "Could not check this queue. Try again later; nothing changed.";

type EngineLimits = { perKey: number | null; total: number | null };

type LimitsReader = Pick<
  typeof engine.runQueue,
  "getQueueConcurrencyLimit" | "getQueueTotalConcurrencyLimit"
>;

/** The limits the engine enforces for a queue now, or null when they cannot be read. */
async function engineLimits(
  runQueue: LimitsReader,
  environment: AuthenticatedEnvironment,
  queueName: string
): Promise<EngineLimits | null> {
  try {
    const [perKey, total] = await Promise.all([
      runQueue.getQueueConcurrencyLimit(environment, queueName),
      runQueue.getQueueTotalConcurrencyLimit(environment, queueName),
    ]);
    return { perKey: perKey ?? null, total: total ?? null };
  } catch (error) {
    logFailure("queue engine read", error);
    return null;
  }
}

/** A paused queue holds a per-key limit of 0 in the engine. */
const enforcedPerKey = (queue: { paused: boolean }, perKey: number | null) =>
  queue.paused ? 0 : perKey;

/** The live limits a repair replaces; part of its preview, so an approval goes stale when they change. */
const liveLimits = (limits: EngineLimits, parts: { perKey: boolean; total: boolean }) =>
  [
    ...(parts.perKey ? [`a per-key limit of ${limits.perKey ?? "none"}`] : []),
    ...(parts.total ? [`a total limit of ${limits.total ?? "none"}`] : []),
  ].join(" and ");

/** The stored state already matches but the engine does not enforce it, so this applies it again. */
const reapplied = (preview: string, stored: string, live: string) => {
  const [title, ...rest] = preview.split("\n");
  return [
    title,
    `It is already stored as ${stored}, but the running queue enforces ${live}; this applies it again.`,
    ...rest,
  ].join("\n");
};

const pausePlan =
  (action: "paused" | "resumed") =>
  async (
    args: QueueArgs,
    environment: AuthenticatedEnvironment
  ): Promise<Plan<{ updatedAt: Date; unlisted: UnlistedRelease }>> => {
    if ((await determineEngineVersion({ environment })) === "V1") {
      return { refuse: "Upgrade to v4+ to pause/resume queues; nothing changed." };
    }
    const queue = await findQueue(environment, args.queueId);
    if (!queue) return queueMissing(args.queueId);
    const { updatedAt } = queue;
    // Resuming is the one way to release a saved pause on a task's unlisted inline limit.
    if (isUnlistedInlineLimit(queue)) {
      if (action === "paused") return unlistedInlineLimit(args.queueId, queue.paused);
      if (queue.paused) {
        return { preview: unlistedResumePreview(queue, environment), updatedAt, unlisted: "saved" };
      }
      // A failed engine write (resume, deploy, recalculation) can leave a per-key 0 that nothing stored sets.
      const limits = await engineLimits(engine.runQueue, environment, queue.name);
      if (!limits) return { refuse: ENGINE_UNREADABLE };
      if (limits.perKey !== 0) return { refuse: `${args.queueId} is not paused; nothing changed.` };
      const held = { total: limits.total };
      return {
        preview: unlistedResumePreview(queue, environment, held),
        updatedAt,
        unlisted: held,
      };
    }
    const preview = action === "paused" ? pausePreview(queue) : resumePreview(queue, environment);
    if (queue.paused !== (action === "paused")) return { preview, updatedAt, unlisted: false };

    const limits = await engineLimits(engine.runQueue, environment, queue.name);
    if (!limits) return { refuse: ENGINE_UNREADABLE };
    if (limits.perKey === enforcedPerKey(queue, queue.concurrencyLimit)) {
      return {
        refuse:
          action === "paused"
            ? `${args.queueId} is already paused; nothing changed.`
            : `${args.queueId} is not paused; nothing changed.`,
      };
    }
    return {
      preview: reapplied(
        preview,
        action === "paused" ? "paused" : "not paused",
        liveLimits(limits, { perKey: true, total: false })
      ),
      updatedAt,
      unlisted: false,
    };
  };

function pausePreview(
  queue: Pick<TaskQueue, "name" | "friendlyId" | "role" | "archivedAt">
): string {
  return [
    `Pause ${noun(queue)} ${quotedQueue(queue)}.`,
    ...numbered([
      queue.role === "LIMIT"
        ? "No new run that needs this limit starts: runs already waiting and runs triggered later wait until it is resumed."
        : "No new run starts on it: runs already queued and runs triggered later stay queued until it is resumed.",
      "Runs already executing are not stopped; they finish normally.",
      ...(queue.archivedAt ? ["It is unarchived, so it shows in the queue list again."] : []),
      "It stays paused through deploys until it is resumed.",
    ]),
  ].join("\n");
}

/** The task an inline limit belongs to: from its stored `task/<id>` name, else the row name. */
const inlineLimitTask = (queue: Pick<TaskQueue, "orderableName" | "name">) =>
  queue.orderableName?.startsWith("task/") ? queue.orderableName.slice("task/".length) : queue.name;

/** What resuming an unlisted inline limit releases: its saved pause, or a per-key 0 nothing stored sets. */
type HeldRelease = { total: number | null };
type UnlistedRelease = false | "saved" | HeldRelease;

/** A live total limit no tool here removes; resume leaves it in place. */
const strayTotal = (total: number) =>
  `The engine also holds a total limit of ${total} for it that nothing stored sets; resume does not remove it.`;

function unlistedResumePreview(
  queue: TaskQueue,
  environment: AuthenticatedEnvironment,
  release: "saved" | HeldRelease = "saved"
): string {
  const task = quoteForPreview(inlineLimitTask(queue));
  const limitsLine = "the task's queue and environment limits still apply.";
  return [
    `Resume the unlisted inline limit of task ${task} (${queue.friendlyId}).`,
    ...numbered(
      release === "saved"
        ? [
            "It does not show in the queue list or the concurrency limits API; resuming removes its saved pause.",
            `If the pause is enforced, runs of task ${task} waiting on it start again. It has no limit of its own; ${limitsLine}`,
            ...envPausedLine(environment),
          ]
        : [
            "It does not show in the queue list or the concurrency limits API. The engine still holds a per-key limit of 0 for it that nothing stored sets; resuming removes it.",
            release.total === null
              ? `Runs of task ${task} waiting on it start again. It has no limit of its own; ${limitsLine}`
              : `Runs of task ${task} waiting on it start again; ${limitsLine}`,
            ...(release.total === null ? [] : [strayTotal(release.total)]),
            ...envPausedLine(environment),
          ]
    ),
  ].join("\n");
}

function resumePreview(
  queue: Pick<
    TaskQueue,
    "name" | "friendlyId" | "role" | "concurrencyLimit" | "totalConcurrencyLimit"
  >,
  environment: AuthenticatedEnvironment
): string {
  const total =
    queue.totalConcurrencyLimit === null
      ? ""
      : `, and a total of ${queue.totalConcurrencyLimit} across all concurrency keys`;
  return [
    `Resume ${noun(queue)} ${quotedQueue(queue)}.`,
    ...numbered([
      `Waiting runs start again, up to its per-key limit of ${perKeyNow(queue.concurrencyLimit, environment.maximumConcurrencyLimit)}${total}.`,
      ...envPausedLine(environment),
    ]),
  ].join("\n");
}

type OverrideArgs = { queueId: string; limit?: number; percent?: number; totalLimit?: number };

type OverridePlan = {
  queue: TaskQueue;
  perKey?: { limit: number } | { percent: number };
  total?: number;
};

async function overridePlan(
  args: OverrideArgs,
  environment: AuthenticatedEnvironment
): Promise<Plan<OverridePlan>> {
  const max = environment.maximumConcurrencyLimit;
  if (args.percent !== undefined && (args.limit !== undefined || args.totalLimit !== undefined)) {
    return {
      refuse: "Pass percent on its own, or limit and/or totalLimit; nothing changed.",
    };
  }
  if (args.limit === undefined && args.percent === undefined && args.totalLimit === undefined) {
    return { refuse: "Pass limit, percent or totalLimit; nothing changed." };
  }
  if (args.totalLimit !== undefined) {
    if (args.limit !== undefined && args.limit > max) {
      return {
        refuse: `Per-key limit must be a whole number between 0 and the environment limit of ${max}; nothing changed.`,
      };
    }
    if (args.totalLimit > max) {
      return {
        refuse: `Total limit must be a whole number between 1 and the environment limit of ${max}; nothing changed.`,
      };
    }
  } else if (args.limit !== undefined && args.limit > max) {
    return {
      refuse: `Concurrency limit (${args.limit}) cannot exceed the environment limit (${max}); nothing changed.`,
    };
  }

  const queue = await findQueue(environment, args.queueId);
  if (!queue) return queueMissing(args.queueId);
  if (isUnlistedInlineLimit(queue)) return unlistedInlineLimit(args.queueId, queue.paused);

  const perKey: OverridePlan["perKey"] =
    args.percent !== undefined
      ? { percent: args.percent }
      : args.limit !== undefined
        ? { limit: args.limit }
        : undefined;
  const newPerKey =
    perKey === undefined
      ? undefined
      : "percent" in perKey
        ? materializePercentLimit(max, perKey.percent)
        : perKey.limit;
  const storedPercent =
    queue.concurrencyLimitOverridePercent === null
      ? null
      : Number(queue.concurrencyLimitOverridePercent);

  const perKeySame =
    newPerKey === undefined ||
    (queue.concurrencyLimitOverriddenAt !== null &&
      queue.concurrencyLimit === newPerKey &&
      storedPercent === (args.percent ?? null));
  const totalSame =
    args.totalLimit === undefined ||
    (queue.totalConcurrencyLimitOverriddenAt !== null &&
      queue.totalConcurrencyLimit === args.totalLimit);
  const preview = overridePreview(queue, environment, {
    perKey: newPerKey,
    percent: args.percent,
    total: args.totalLimit,
  });
  const planned = { queue, perKey, total: args.totalLimit };
  if (!perKeySame || !totalSame) return { ...planned, preview };

  const limits = await engineLimits(engine.runQueue, environment, queue.name);
  if (!limits) return { refuse: ENGINE_UNREADABLE };
  // A paused queue keeps its per-key limit at 0, so the override cannot repair a lost pause.
  if (newPerKey !== undefined && queue.paused && limits.perKey !== 0) {
    return {
      refuse: `${args.queueId} is paused, but the running queue does not enforce the pause. Call pause_queue to apply it again; nothing changed.`,
    };
  }
  const enforced =
    (newPerKey === undefined || queue.paused || limits.perKey === newPerKey) &&
    (args.totalLimit === undefined || limits.total === args.totalLimit);
  if (enforced) {
    return { refuse: `${args.queueId} already has this override; nothing changed.` };
  }
  const live = liveLimits(limits, {
    perKey: newPerKey !== undefined,
    total: args.totalLimit !== undefined,
  });
  return { ...planned, preview: reapplied(preview, "this override", live) };
}

function overridePreview(
  queue: TaskQueue,
  environment: AuthenticatedEnvironment,
  next: { perKey?: number; percent?: number; total?: number }
): string {
  const max = environment.maximumConcurrencyLimit;
  const perKeyBase = queue.concurrencyLimitOverriddenAt
    ? queue.concurrencyLimitBase
    : queue.concurrencyLimit;
  const totalBase = queue.totalConcurrencyLimitOverriddenAt
    ? queue.totalConcurrencyLimitBase
    : queue.totalConcurrencyLimit;
  const changes: string[] = [];
  const kept: string[] = [];
  if (next.perKey !== undefined) {
    const source =
      next.percent !== undefined
        ? ` (${next.percent}% of the environment limit of ${max}; it is recalculated when the environment limit changes)`
        : "";
    changes.push(
      `- Per-key limit (runs of each concurrency key at once; the whole queue's limit when it has no keys): ${perKeyNow(queue.concurrencyLimit, max)} → ${next.perKey}${source}.`
    );
    kept.push(`per-key ${perKeyBase === null ? "none" : perKeyBase}`);
  }
  if (next.total !== undefined) {
    changes.push(
      `- Total limit (runs across all concurrency keys at once): ${queue.totalConcurrencyLimit ?? "none"} → ${next.total}.`
    );
    kept.push(`total ${totalBase === null ? "none" : totalBase}`);
  }
  const zero = next.perKey === 0;
  return [
    `Override the concurrency of ${noun(queue)} ${quotedQueue(queue)}.`,
    ...changes,
    "What happens:",
    ...numbered([
      "Runs already executing are not stopped. If more are running than a new limit allows, no new run starts until enough of them finish.",
      zero
        ? "With a per-key limit of 0 no run starts; waiting runs stay queued until the limit is raised or the override is removed."
        : "Waiting runs start as slots free up under the new limits.",
      ...(zero && queue.archivedAt
        ? ["It is unarchived, so it shows in the queue list again."]
        : []),
      ...(queue.paused
        ? ["It is paused, so nothing starts until it is resumed; the new limits apply then."]
        : []),
      ...envPausedLine(environment),
      `The limits set in code (${kept.join(", ")}) are kept: deploys update them but do not replace the override, and reset_queue_concurrency restores them.`,
    ]),
  ].join("\n");
}

type ResetPlan = {
  queue: TaskQueue;
  perKey: boolean;
  total: boolean;
  repairPerKey: boolean;
  repairTotal: boolean;
};

async function resetPlan(
  args: QueueArgs,
  environment: AuthenticatedEnvironment
): Promise<Plan<ResetPlan>> {
  const queue = await findQueue(environment, args.queueId);
  if (!queue) return queueMissing(args.queueId);
  if (isUnlistedInlineLimit(queue)) return unlistedInlineLimit(args.queueId, queue.paused);
  const perKey = queue.concurrencyLimitOverriddenAt !== null;
  const total = queue.totalConcurrencyLimitOverriddenAt !== null;
  if (perKey || total) {
    return {
      queue,
      perKey,
      total,
      repairPerKey: false,
      repairTotal: false,
      preview: resetPreview(queue, environment),
    };
  }
  // No override stored: a no-op only if the engine also enforces the limits the row implies.
  const limits = await engineLimits(engine.runQueue, environment, queue.name);
  if (!limits) return { refuse: ENGINE_UNREADABLE };
  const repairPerKey = limits.perKey !== enforcedPerKey(queue, queue.concurrencyLimit);
  const repairTotal = limits.total !== queue.totalConcurrencyLimit;
  if (!repairPerKey && !repairTotal) {
    return { refuse: `${args.queueId} has no concurrency override; nothing changed.` };
  }
  return {
    queue,
    perKey,
    total,
    repairPerKey,
    repairTotal,
    preview: repairPreview(queue, limits, { perKey: repairPerKey, total: repairTotal }),
  };
}

const limitText = (limit: number | null) => (limit === null ? "none" : String(limit));

function repairPreview(
  queue: TaskQueue,
  live: EngineLimits,
  parts: { perKey: boolean; total: boolean }
): string {
  return [
    `Apply the stored limits to ${noun(queue)} ${quotedQueue(queue)}.`,
    "It has no concurrency override, but the running queue enforces other limits; this applies the stored ones again:",
    ...(parts.perKey
      ? [
          `- Per-key limit: ${limitText(live.perKey)} → ${limitText(enforcedPerKey(queue, queue.concurrencyLimit))}.`,
        ]
      : []),
    ...(parts.total
      ? [`- Total limit: ${limitText(live.total)} → ${limitText(queue.totalConcurrencyLimit)}.`]
      : []),
    "Runs already executing are not stopped.",
  ].join("\n");
}

/**
 * After a per-key reset: undefined when the engine enforces the limit the row now implies, else
 * what to tell the caller. The row is read again, as a pause may have committed since the reset.
 */
export async function perKeyNotEnforced(
  db: Pick<typeof prisma, "taskQueue">,
  runQueue: LimitsReader,
  environment: AuthenticatedEnvironment,
  queueId: string
): Promise<string | undefined> {
  const row = await db.taskQueue
    .findFirst({ where: { id: queueId } })
    .catch(() => "unreadable" as const);
  if (row === "unreadable") {
    return "The per-key override was removed and saved, but the running queue could not be checked. Call reset_queue_concurrency again to apply it.";
  }
  if (!row) return undefined;
  const limits = await engineLimits(runQueue, environment, row.name);
  const target = limitText(enforcedPerKey(row, row.concurrencyLimit));
  const again = "Call reset_queue_concurrency again to apply it.";
  if (!limits) {
    return `The per-key override was removed and saved, but the running queue could not be checked and may still enforce another per-key limit than ${target}. ${again}`;
  }
  return limits.perKey === enforcedPerKey(row, row.concurrencyLimit)
    ? undefined
    : `The per-key override was removed and saved, but the running queue enforces ${limitText(limits.perKey)} instead of ${target}. ${again}`;
}

function resetPreview(queue: TaskQueue, environment: AuthenticatedEnvironment): string {
  const max = environment.maximumConcurrencyLimit;
  const changes: string[] = [];
  if (queue.concurrencyLimitOverriddenAt !== null) {
    changes.push(
      `- Per-key limit: ${perKeyNow(queue.concurrencyLimit, max)} → ${perKeyNow(queue.concurrencyLimitBase, max)}, the limit set in code.`
    );
  }
  if (queue.totalConcurrencyLimitOverriddenAt !== null) {
    changes.push(
      `- Total limit: ${queue.totalConcurrencyLimit ?? "none"} → ${queue.totalConcurrencyLimitBase ?? "none"}, the limit set in code.`
    );
  }
  const restoredZero =
    (queue.concurrencyLimitOverriddenAt !== null && queue.concurrencyLimitBase === 0) ||
    (queue.totalConcurrencyLimitOverriddenAt !== null && queue.totalConcurrencyLimitBase === 0);
  return [
    `Remove the concurrency override of ${noun(queue)} ${quotedQueue(queue)}.`,
    ...changes,
    "What happens:",
    ...numbered([
      "Runs already executing are not stopped. If more are running than a restored limit allows, no new run starts until enough of them finish.",
      "Waiting runs start as slots free up under the restored limits.",
      ...(restoredZero && queue.archivedAt
        ? ["It is unarchived, so it shows in the queue list again."]
        : []),
      ...(queue.paused ? ["It is paused, so nothing starts until it is resumed."] : []),
      ...envPausedLine(environment),
      "Later deploys set these limits from code again.",
    ]),
  ].join("\n");
}

const archiveService = () => new ArchiveQueueService(prisma);

async function archivableQueue(environment: AuthenticatedEnvironment, queueId: string) {
  return prisma.taskQueue.findFirst({
    where: { friendlyId: queueId, runtimeEnvironmentId: environment.id, role: "QUEUE" },
    select: { name: true, friendlyId: true, role: true, archivedAt: true },
  });
}

/** Only queues are archived; a named concurrency limit's id is named as such. */
async function notArchivable(environment: AuthenticatedEnvironment, queueId: string) {
  const limit = await prisma.taskQueue.findFirst({
    where: { friendlyId: queueId, runtimeEnvironmentId: environment.id, role: "LIMIT" },
    select: { id: true },
  });
  return {
    refuse: limit
      ? `${queueId} is a named concurrency limit, not a queue. Only queues are archived; nothing changed.`
      : nothingChanged(queueNotFound(queueId)),
  };
}

async function archivePlan(
  args: QueueArgs,
  environment: AuthenticatedEnvironment
): Promise<Plan<object>> {
  const queue = await archivableQueue(environment, args.queueId);
  if (!queue) return notArchivable(environment, args.queueId);
  if (queue.archivedAt) return { refuse: `${args.queueId} is already archived; nothing changed.` };
  const check = await archiveService().check(environment, args.queueId);
  if (check.isErr()) {
    if (check.error.type === "other") {
      logFailure("archive_queue", check.error.cause);
      return { refuse: "Could not check this queue. Try again later; nothing changed." };
    }
    return { refuse: nothingChanged(archiveQueueErrorMessage(check.error)) };
  }
  if (check.value) return { refuse: nothingChanged(archiveQueueErrorMessage(check.value)) };
  return {
    preview: [
      `Archive queue ${quotedQueue(queue)}.`,
      ...numbered([
        "It is hidden from the queue list; list_queues shows it with includeArchived.",
        "Nothing else changes: it has no waiting or running runs, and its limits, paused state and tasks stay as they are.",
        "A deploy that declares it again unarchives it, and unarchive_queue undoes this.",
      ]),
    ].join("\n"),
  };
}

async function unarchivePlan(
  args: QueueArgs,
  environment: AuthenticatedEnvironment
): Promise<Plan<object>> {
  const queue = await archivableQueue(environment, args.queueId);
  if (!queue) return notArchivable(environment, args.queueId);
  if (!queue.archivedAt) return { refuse: `${args.queueId} is not archived; nothing changed.` };
  return {
    preview: [
      `Unarchive queue ${quotedQueue(queue)}.`,
      ...numbered([
        "It shows in the queue list again.",
        "Nothing else changes: its runs, limits and paused state stay as they are.",
      ]),
    ].join("\n"),
  };
}

const environmentLabel = (environment: AuthenticatedEnvironment) =>
  `${environment.type.toLowerCase()} environment ${quoteForPreview(environment.slug)}`;

async function environmentPauseState(environment: AuthenticatedEnvironment) {
  const [state, organization] = await Promise.all([
    prisma.runtimeEnvironment.findFirst({
      where: { id: environment.id },
      select: { paused: true, pauseSource: true, maximumConcurrencyLimit: true },
    }),
    prisma.organization.findFirst({
      where: { id: environment.organizationId },
      select: { runsEnabled: true },
    }),
  ]);
  return state && organization ? { ...state, runsEnabled: organization.runsEnabled } : null;
}

async function pauseEnvironmentPlan(
  _args: object,
  environment: AuthenticatedEnvironment
): Promise<Plan<object>> {
  const state = await environmentPauseState(environment);
  if (!state) return { refuse: ENVIRONMENT_NOT_FOUND };
  if (state.paused) return { refuse: "This environment is already paused; nothing changed." };
  return {
    preview: [
      `Pause the ${environmentLabel(environment)}.`,
      ...numbered([
        "No new run starts in any of its queues: queued runs and runs triggered later wait until the environment is resumed.",
        "Runs already executing are not stopped; they finish normally.",
        "Queue pauses, limits and overrides are kept.",
        "It stays paused, including through deploys, until it is resumed.",
      ]),
    ].join("\n"),
  };
}

async function resumeEnvironmentPlan(
  _args: object,
  environment: AuthenticatedEnvironment
): Promise<Plan<object>> {
  const state = await environmentPauseState(environment);
  if (!state) return { refuse: ENVIRONMENT_NOT_FOUND };
  if (!state.paused) return { refuse: "This environment is not paused; nothing changed." };
  const guard = getManualPauseEnvironmentResult("resumed", state.pauseSource);
  if (!guard.proceed && !guard.success) return { refuse: nothingChanged(guard.error) };
  if (!state.runsEnabled) {
    return {
      refuse:
        "Runs are disabled for this organization. Your free plan has probably been exceeded. If not please contact support; nothing changed.",
    };
  }
  return {
    preview: [
      `Resume the ${environmentLabel(environment)}.`,
      ...numbered([
        `Queued runs start again, up to the environment concurrency limit of ${state.maximumConcurrencyLimit}.`,
        "Queues that are paused on their own stay paused.",
      ]),
    ].join("\n"),
  };
}

const ENVIRONMENT_GUARD = /billing limit|administrator|Runs are disabled/;

function environmentFailure(tool: string, error: string) {
  if (ENVIRONMENT_GUARD.test(error)) return plainError(nothingChanged(error));
  logFailure(tool, error);
  return plainError(TRY_AGAIN);
}

/** What one part of an override did when its service call failed: an override is saved before it is synced. */
const partFailed = (part: string, error: { type: string }, message: string) =>
  error.type === "get_queue_stats_failed"
    ? `${part} was changed; only its live run counts could not be read.`
    : error.type === "sync_queue_concurrency_to_engine_failed"
      ? `${part} was saved, but the running queue does not enforce it yet. Call the tool again with the same arguments to apply it.`
      : `${part} was not changed: ${message}`;

function serviceMessage(error: object, fallback: string) {
  return "message" in error && typeof error.message === "string" ? error.message : fallback;
}

export function createQueuesWriteTools(): McpToolDefinition[] {
  const pause = withPlan(pausePlan("paused"));
  const resume = withPlan(pausePlan("resumed"));
  const override = withPlan(overridePlan);
  const reset = withPlan(resetPlan);
  const archive = withPlan(archivePlan);
  const unarchive = withPlan(unarchivePlan);
  const pauseEnv = withPlan(pauseEnvironmentPlan);
  const resumeEnv = withPlan(resumeEnvironmentPlan);

  const pauseQueue =
    (tool: string, action: "paused" | "resumed") =>
    async (
      queueId: string,
      environment: AuthenticatedEnvironment,
      expectedUpdatedAt: Date,
      ctx: McpToolContext,
      unlisted: UnlistedRelease = false
    ) => {
      const result = await new PauseQueueService(prisma).call(environment, queueId, action, {
        roles: ["QUEUE", "LIMIT"],
        expectedUpdatedAt,
      });
      if (result.success) {
        if (unlisted === "saved") return textResult(`Removed the saved pause of ${queueId}.`);
        if (unlisted) {
          const removed = `Removed the per-key limit of 0 of ${queueId}.`;
          return textResult(
            unlisted.total === null ? removed : `${removed} ${strayTotal(unlisted.total)}`
          );
        }
        return textResult(`${action === "paused" ? "Paused" : "Resumed"} ${queueId}.`);
      }
      if (result.code === "queue-changed") return queueChanged(ctx);
      if (result.code === "queue-not-found")
        return plainError(nothingChanged(queueNotFound(queueId)));
      logFailure(tool, result.error);
      return plainError(TRY_AGAIN);
    };

  return [
    defineWriteTool({
      name: "pause_queue",
      title: "Pause Queue",
      description:
        "Pause a queue or named concurrency limit (an ID from list_queues). No new run starts on it until it is resumed; runs already executing finish normally, and waiting or newly triggered runs stay queued. Deploys do not resume it.",
      shape: QueueWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: pause.preview },
      run: (input, ctx) =>
        pause.run(input, ctx, (planned, environment) =>
          pauseQueue("pause_queue", "paused")(input.queueId, environment, planned.updatedAt, ctx)
        ),
    }),
    defineWriteTool({
      name: "resume_queue",
      title: "Resume Queue",
      description:
        "Resume a paused queue or named concurrency limit, so its waiting runs start again up to its limits. It also releases the saved pause of a task's inline limit that is not listed.",
      shape: QueueWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: resume.preview },
      run: (input, ctx) =>
        resume.run(input, ctx, (planned, environment) =>
          pauseQueue("resume_queue", "resumed")(
            input.queueId,
            environment,
            planned.updatedAt,
            ctx,
            planned.unlisted
          )
        ),
    }),
    defineWriteTool({
      name: "override_queue_concurrency",
      title: "Override Queue Concurrency",
      description:
        "Override the concurrency limits of a queue or named concurrency limit, replacing the limits set in code until reset_queue_concurrency. Pass limit (per concurrency key, or the whole queue when it has no keys) or percent (of the environment limit), and/or totalLimit (across all keys). Neither may exceed the environment limit. Running runs are not stopped.",
      shape: OverrideQueueInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: override.preview },
      run: (input, ctx) =>
        override.run(input, ctx, async (planned, environment) => {
          const user = await getUserById(ctx.identity.userId);
          if (!user) return plainError("User not found");
          const queueId = planned.queue.friendlyId;
          const perKey = planned.perKey
            ? await concurrencySystem.queues.overrideQueueConcurrencyLimit(
                environment,
                queueId,
                planned.perKey,
                user,
                { expectedUpdatedAt: planned.queue.updatedAt }
              )
            : undefined;
          if (perKey?.isErr()) {
            if (perKey.error.type === "concurrent_modification") return queueChanged(ctx);
            if (!("message" in perKey.error))
              logFailure("override_queue_concurrency", perKey.error);
            return plainError(
              [
                partFailed(
                  "The per-key limit",
                  perKey.error,
                  serviceMessage(perKey.error, TRY_AGAIN)
                ),
                ...(planned.total !== undefined ? ["The total limit was not changed."] : []),
              ].join(" ")
            );
          }
          if (planned.total !== undefined) {
            const result = await concurrencySystem.queues.overrideTotalConcurrencyLimit(
              environment,
              queueId,
              planned.total,
              user,
              {
                expectedUpdatedAt: perKey?.isOk()
                  ? perKey.value.updatedAt
                  : planned.queue.updatedAt,
              }
            );
            if (result.isErr()) {
              if (!perKey && result.error.type === "concurrent_modification") {
                return queueChanged(ctx);
              }
              if (!("message" in result.error))
                logFailure("override_queue_concurrency", result.error);
              return plainError(
                [
                  ...(planned.perKey ? ["The per-key limit was overridden."] : []),
                  partFailed(
                    "The total limit",
                    result.error,
                    serviceMessage(result.error, TRY_AGAIN)
                  ),
                ].join(" ")
              );
            }
          }
          return textResult(`Overrode the concurrency of ${queueId}.`);
        }),
    }),
    defineWriteTool({
      name: "reset_queue_concurrency",
      title: "Reset Queue Concurrency",
      description:
        "Remove the concurrency override of a queue or named concurrency limit, restoring the per-key and total limits set in code. With no override, it applies the stored per-key and total limits again (a per-key limit of 0 while the queue is paused) if the running queue enforces different ones. Running runs are not stopped.",
      shape: QueueWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: reset.preview },
      run: (input, ctx) =>
        reset.run(input, ctx, async (planned, environment) => {
          const queueId = planned.queue.friendlyId;
          if (planned.repairPerKey || planned.repairTotal) {
            // A repair changes no row field, so both parts check the same revision.
            const expected = { expectedUpdatedAt: planned.queue.updatedAt };
            const perKeyRepair = planned.repairPerKey
              ? await concurrencySystem.queues.resyncPerKeyConcurrencyLimit(
                  environment,
                  queueId,
                  expected
                )
              : undefined;
            if (perKeyRepair?.isErr() && perKeyRepair.error.type === "concurrent_modification") {
              return queueChanged(ctx);
            }
            if (perKeyRepair?.isErr() && perKeyRepair.error.type !== "get_queue_stats_failed") {
              logFailure("reset_queue_concurrency", perKeyRepair.error);
              return plainError(TRY_AGAIN);
            }
            const totalRepair = planned.repairTotal
              ? await concurrencySystem.queues.resyncTotalConcurrencyLimit(
                  environment,
                  queueId,
                  expected
                )
              : undefined;
            if (totalRepair?.isErr() && totalRepair.error.type === "concurrent_modification") {
              return planned.repairPerKey
                ? plainError(
                    "The per-key limit was applied; the total limit was not, because the queue changed. Call the tool again."
                  )
                : queueChanged(ctx);
            }
            if (totalRepair?.isErr() && totalRepair.error.type !== "get_queue_stats_failed") {
              logFailure("reset_queue_concurrency", totalRepair.error);
              return plainError(
                planned.repairPerKey
                  ? "The per-key limit was applied; applying the total limit failed. Call the tool again."
                  : TRY_AGAIN
              );
            }
            return textResult(`Applied the stored limits to ${queueId}.`);
          }
          const perKey = planned.perKey
            ? await concurrencySystem.queues.resetConcurrencyLimit(environment, queueId, {
                expectedUpdatedAt: planned.queue.updatedAt,
              })
            : undefined;
          if (perKey?.isErr() && perKey.error.type === "get_queue_stats_failed") {
            return plainError(
              [
                partFailed("The per-key limit", perKey.error, ""),
                ...(planned.total
                  ? ["The total limit was not reset; call the tool again to reset it."]
                  : []),
              ].join(" ")
            );
          }
          if (perKey?.isErr() && perKey.error.type !== "queue_not_overridden") {
            if (perKey.error.type === "concurrent_modification") return queueChanged(ctx);
            logFailure("reset_queue_concurrency", perKey.error);
            return plainError(serviceMessage(perKey.error, TRY_AGAIN));
          }
          if (planned.total) {
            const result = await concurrencySystem.queues.resetTotalConcurrencyLimit(
              environment,
              queueId,
              {
                expectedUpdatedAt: perKey?.isOk()
                  ? perKey.value.updatedAt
                  : planned.queue.updatedAt,
              }
            );
            if (result.isErr() && result.error.type !== "queue_not_overridden") {
              if (!perKey && result.error.type === "concurrent_modification") {
                return queueChanged(ctx);
              }
              if (result.error.type === "get_queue_stats_failed") {
                return plainError(
                  [
                    ...(planned.perKey ? ["The per-key limit was reset."] : []),
                    partFailed("The total limit", result.error, ""),
                  ].join(" ")
                );
              }
              if (result.error.type === "saved_engine_not_synced") {
                logFailure("reset_queue_concurrency", result.error);
                return plainError(
                  [
                    ...(planned.perKey ? ["The per-key limit was reset."] : []),
                    "The total limit was reset and saved, but the running queue could not be updated and may still enforce the old total limit. Call reset_queue_concurrency again to apply the saved limit to it.",
                  ].join(" ")
                );
              }
              logFailure("reset_queue_concurrency", result.error);
              const message = serviceMessage(result.error, TRY_AGAIN);
              return plainError(
                planned.perKey
                  ? `The per-key limit was reset, but resetting the total limit failed: ${message}`
                  : message
              );
            }
          }
          const notEnforced = perKey?.isOk()
            ? await perKeyNotEnforced(prisma, engine.runQueue, environment, perKey.value.id)
            : undefined;
          if (notEnforced) return plainError(notEnforced);
          return textResult(`Removed the concurrency override of ${queueId}.`);
        }),
    }),
    defineWriteTool({
      name: "archive_queue",
      title: "Archive Queue",
      description:
        "Archive a queue that is no longer used: it is hidden from the queue list and nothing else changes. Only a queue with no waiting or running runs, not paused, without a limit of 0 and not declared by the current deploy can be archived. unarchive_queue undoes it.",
      shape: QueueWriteInput.shape,
      approval: "required",
      auth,
      confirm: { preview: archive.preview },
      run: (input, ctx) =>
        archive.run(input, ctx, async (_, environment) => {
          const result = await archiveService().archive(environment, input.queueId);
          if (result.isErr()) {
            if (result.error.type === "other") {
              logFailure("archive_queue", result.error.cause);
              return plainError(TRY_AGAIN);
            }
            return plainError(nothingChanged(archiveQueueErrorMessage(result.error)));
          }
          return textResult(`Archived ${input.queueId}.`);
        }),
    }),
    defineWriteTool({
      name: "unarchive_queue",
      title: "Unarchive Queue",
      description: "Unarchive a queue so it shows in the queue list again. Nothing else changes.",
      shape: QueueWriteInput.shape,
      approval: "required",
      auth,
      confirm: { preview: unarchive.preview },
      run: (input, ctx) =>
        unarchive.run(input, ctx, async (_, environment) => {
          const result = await archiveService().unarchive(environment, input.queueId);
          if (result.isErr()) {
            if (result.error.type === "other") logFailure("unarchive_queue", result.error.cause);
            return plainError(
              result.error.type === "other" ? TRY_AGAIN : archiveQueueErrorMessage(result.error)
            );
          }
          return textResult(`Unarchived ${input.queueId}.`);
        }),
    }),
    defineWriteTool({
      name: "pause_environment",
      title: "Pause Environment",
      description:
        "Pause a whole environment: no new run starts in any of its queues until it is resumed. Runs already executing finish normally; queued and newly triggered runs wait.",
      shape: CommonProjectsInput.shape,
      approval: "required",
      auth,
      confirm: { preview: pauseEnv.preview },
      run: (input, ctx) =>
        pauseEnv.run(input, ctx, async (_, environment) => {
          const result = await new PauseEnvironmentService(prisma).call(environment, "paused");
          if (!result.success) return environmentFailure("pause_environment", result.error);
          return textResult("Paused the environment.");
        }),
    }),
    defineWriteTool({
      name: "resume_environment",
      title: "Resume Environment",
      description:
        "Resume a paused environment so queued runs start again. An environment paused because the organization reached its billing limit, or by an administrator, cannot be resumed here.",
      shape: CommonProjectsInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: resumeEnv.preview },
      run: (input, ctx) =>
        resumeEnv.run(input, ctx, async (_, environment) => {
          const result = await new PauseEnvironmentService(prisma).call(environment, "resumed");
          if (!result.success) return environmentFailure("resume_environment", result.error);
          return textResult("Resumed the environment.");
        }),
    }),
  ];
}

export const queuesWriteTools = createQueuesWriteTools();
