import { formatTriggerUri } from "@internal/dashboard-agent-contracts";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { type Prettify, type QueueItem, type RetrieveQueueParam } from "@trigger.dev/core/v3";
import {
  type PrismaClientOrTransaction,
  type TaskQueue,
  type TaskRunStatus,
  type User,
  type TaskQueueType,
} from "@trigger.dev/database";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";
import { BasePresenter } from "./basePresenter.server";

type SlotHolderPhase = "admitted" | "dequeued";
export type SlotHolderConsistency = "consistent" | "mismatch" | "unresolved";
type SlotHolderCounterAgreement = "agree" | "disagree" | "unresolved";
/** "not_found": a Redis slot holder with no matching TaskRun row. */
type SlotHolderStatus = TaskRunStatus | "not_found";

/** Env-scope concurrency, alongside the queue row — the queue can show headroom while the env is saturated. */
export type EnvConcurrency = {
  limit: number;
  /** The displayed dequeued count (envCurrentDequeuedKey), not the gated envCurrentConcurrencyKey — can trail it. */
  current: number;
  /** The dequeue gate is `current < limit * burstFactor`, not `current < limit`. */
  burstFactor: number;
  /**
   * Env-scoped admitted slots. When `admitted > current`, the environment holds admitted
   * slots the queue's holder list can't attribute.
   */
  admitted: number;
};

export type SlotHolder = {
  runId: string;
  status: SlotHolderStatus;
  /** Built from the raw Redis member id when the run didn't resolve, so it won't open. */
  uri: string;
  concurrencyKey: string | null;
  phase: SlotHolderPhase;
  consistency: SlotHolderConsistency;
};

/** The holder list is never claimed to be complete — a CK queue's holders can be unlistable. */
export type SlotHolderFacts = {
  admittedCount: number;
  dequeuedCount: number;
  runningReported: number;
  /** The list hit the cap, so more holders provably exist. */
  truncated: boolean;
  /** Dequeued holders that provably exist but aren't listed. */
  unlistedRunning: number;
  /** The counts mean nothing when this is "unresolved". */
  counterAgreement: SlotHolderCounterAgreement;
  /** Always true: an admitted concurrency-key holder with no backlog is never listable. */
  ckAdmittedMayBeUnlisted: true;
};

// A run can only hold a slot before its final status. PENDING counts because Redis
// membership is written at admission, ahead of the Postgres status; DELAYED never queues.
const NON_HOLDING_STATUSES = new Set<TaskRunStatus>([
  "DELAYED",
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
]);

/** Redis membership vs Postgres run state. `lookupFailed` means we couldn't check at all. */
export function slotHolderConsistency(
  run: { status: TaskRunStatus } | undefined,
  lookupFailed: boolean
): SlotHolderConsistency {
  if (lookupFailed) return "unresolved";
  if (!run) return "mismatch";
  return NON_HOLDING_STATUSES.has(run.status) ? "mismatch" : "consistent";
}

/** Guarded env-concurrency read: a failing Redis read degrades to `undefined`, never throws. */
export async function envConcurrencyFromRead(
  limit: number,
  burstFactor: number,
  readCounts: () => Promise<{ current: number; admitted: number }>
): Promise<EnvConcurrency | undefined> {
  try {
    const { current, admitted } = await readCounts();
    return { limit, current, burstFactor, admitted };
  } catch {
    return undefined;
  }
}

export type FoundQueue = Prettify<
  Omit<TaskQueue, "concurrencyLimitOverriddenBy"> & {
    concurrencyLimitOverriddenBy?: User | null;
  }
>;

/**
 * Shared queue lookup logic used by both QueueRetrievePresenter and PauseQueueService
 */
export async function getQueue(
  prismaClient: PrismaClientOrTransaction,
  environment: AuthenticatedEnvironment,
  queue: RetrieveQueueParam
) {
  if (typeof queue === "string") {
    return joinQueueWithUser(
      prismaClient,
      await prismaClient.taskQueue.findFirst({
        where: {
          friendlyId: queue,
          runtimeEnvironmentId: environment.id,
        },
      })
    );
  }

  const queueName =
    queue.type === "task" ? `task/${queue.name.replace(/^task\//, "")}` : queue.name;
  return joinQueueWithUser(
    prismaClient,
    await prismaClient.taskQueue.findFirst({
      where: {
        name: queueName,
        runtimeEnvironmentId: environment.id,
      },
    })
  );
}

async function joinQueueWithUser(
  prismaClient: PrismaClientOrTransaction,
  queue?: TaskQueue | null
): Promise<FoundQueue | undefined> {
  if (!queue) return undefined;
  if (!queue.concurrencyLimitOverriddenBy) {
    return {
      ...queue,
      concurrencyLimitOverriddenBy: undefined,
    };
  }

  const user = await prismaClient.user.findFirst({
    where: { id: queue.concurrencyLimitOverriddenBy },
  });

  return {
    ...queue,
    concurrencyLimitOverriddenBy: user,
  };
}

export class QueueRetrievePresenter extends BasePresenter {
  public async call({
    environment,
    queueInput,
  }: {
    environment: AuthenticatedEnvironment;
    queueInput: RetrieveQueueParam;
  }) {
    const queue = await getQueue(this._replica, environment, queueInput);
    if (!queue) {
      return {
        success: false as const,
        code: "queue-not-found",
      };
    }

    const results = await Promise.all([
      engine.lengthOfQueues(environment, [queue.name]),
      engine.currentConcurrencyOfQueues(environment, [queue.name]),
    ]);

    const { slotHolders, slotHolderFacts } = await this.#slotHolders(environment, queue.name);
    const envConcurrency = await this.#envConcurrency(environment);

    // Transform queues to include running and queued counts
    return {
      success: true as const,
      queue: {
        ...toQueueItem({
          friendlyId: queue.friendlyId,
          name: queue.name,
          type: queue.type,
          running: results[1]?.[queue.name] ?? 0,
          queued: results[0]?.[queue.name] ?? 0,
          concurrencyLimit: queue.concurrencyLimit ?? null,
          concurrencyLimitBase: queue.concurrencyLimitBase ?? null,
          concurrencyLimitOverriddenAt: queue.concurrencyLimitOverriddenAt ?? null,
          concurrencyLimitOverriddenBy: queue.concurrencyLimitOverriddenBy ?? null,
          paused: queue.paused,
        }),
        // The percent source-of-truth for percent-based overrides isn't part of the shared
        // `QueueItem` schema (that's a public contract), so we surface it as an extra field on
        // the returned queue — mirroring QueueListPresenter. Prisma returns Decimal; the client
        // only needs a plain number (null for absolute overrides).
        concurrencyLimitOverridePercent:
          queue.concurrencyLimitOverridePercent !== null
            ? Number(queue.concurrencyLimitOverridePercent)
            : null,
        slotHolders,
        slotHolderFacts,
        envConcurrency,
      },
    };
  }

  /**
   * Env-scope concurrency, so a client can tell whether the binding constraint is the queue
   * or the environment. Guarded: a failing Redis read degrades to omitted, never a 500.
   */
  async #envConcurrency(
    environment: AuthenticatedEnvironment
  ): Promise<EnvConcurrency | undefined> {
    const burstFactor =
      typeof environment.concurrencyLimitBurstFactor === "number"
        ? environment.concurrencyLimitBurstFactor
        : environment.concurrencyLimitBurstFactor.toNumber();
    return envConcurrencyFromRead(environment.maximumConcurrencyLimit, burstFactor, async () => {
      const [current, admitted] = await Promise.all([
        engine.concurrencyOfEnvQueue(environment),
        engine.admittedConcurrencyOfEnvQueue(environment),
      ]);
      return { current, admitted };
    });
  }

  /**
   * Names the runs holding the queue's concurrency slots. Both reads are guarded: a
   * failing Redis or Postgres read degrades the extra fields, it never fails the request.
   */
  async #slotHolders(
    environment: AuthenticatedEnvironment,
    queueName: string
  ): Promise<{ slotHolders: SlotHolder[]; slotHolderFacts: SlotHolderFacts }> {
    const unresolved = {
      slotHolders: [],
      slotHolderFacts: {
        admittedCount: 0,
        dequeuedCount: 0,
        runningReported: 0,
        truncated: false,
        unlistedRunning: 0,
        counterAgreement: "unresolved" as const,
        ckAdmittedMayBeUnlisted: true as const,
      },
    };

    let snapshot: Awaited<ReturnType<typeof engine.slotHoldersOfQueue>>;
    try {
      snapshot = await engine.slotHoldersOfQueue(environment, queueName);
    } catch {
      return unresolved;
    }

    let runsById: Map<string, { friendlyId: string; status: TaskRunStatus }> | undefined;
    if (snapshot.holders.length > 0) {
      try {
        runsById = await runStore.findRunsByIds(
          snapshot.holders.map((holder) => holder.runId),
          { select: { friendlyId: true, status: true } }
        );
      } catch {
        runsById = undefined;
      }
    } else {
      runsById = new Map();
    }

    // An empty member id can't be formatted into a URI, so it can't be reported.
    const slotHolders = snapshot.holders
      .filter((holder) => holder.runId.length > 0)
      .map((holder) => {
        const run = runsById?.get(holder.runId);

        return {
          runId: run?.friendlyId ?? holder.runId,
          status: run?.status ?? ("not_found" as const),
          uri: formatTriggerUri({
            kind: "run",
            projectRef: environment.project.externalRef,
            environmentId: environment.id,
            runId: run?.friendlyId ?? holder.runId,
          }),
          concurrencyKey: holder.concurrencyKey,
          phase: holder.phase,
          consistency: slotHolderConsistency(run, runsById === undefined),
        };
      });

    return {
      slotHolders,
      slotHolderFacts: {
        admittedCount: snapshot.admittedCount,
        dequeuedCount: snapshot.dequeuedCount,
        runningReported: snapshot.runningReported,
        truncated: snapshot.truncated,
        unlistedRunning: snapshot.unlistedRunning,
        counterAgreement: snapshot.counterAgreement,
        ckAdmittedMayBeUnlisted: snapshot.ckAdmittedMayBeUnlisted,
      },
    };
  }
}

export function queueTypeFromType(type: TaskQueueType) {
  switch (type) {
    case "NAMED":
      return "custom" as const;
    case "VIRTUAL":
      return "task" as const;
    default:
      assertExhaustive(type);
  }
}

/**
 * Converts raw queue data into a standardized QueueItem format
 * @param data Raw queue data containing required queue properties
 * @returns A validated QueueItem object
 */
export function toQueueItem(data: {
  friendlyId: string;
  name: string;
  type: TaskQueueType;
  running: number;
  queued: number;
  concurrencyLimit: number | null;
  concurrencyLimitBase: number | null;
  concurrencyLimitOverriddenAt: Date | null;
  concurrencyLimitOverriddenBy: User | null;
  paused: boolean;
}): QueueItem & { releaseConcurrencyOnWaitpoint: boolean } {
  return {
    id: data.friendlyId,
    //remove the task/ prefix if it exists
    name: data.name.replace(/^task\//, ""),
    type: queueTypeFromType(data.type),
    running: data.running,
    queued: data.queued,
    paused: data.paused,
    concurrencyLimit: data.concurrencyLimit,
    concurrency: {
      current: data.concurrencyLimit,
      base: data.concurrencyLimitBase,
      override: data.concurrencyLimitOverriddenAt ? data.concurrencyLimit : null,
      overriddenBy: toQueueConcurrencyOverriddenBy(data.concurrencyLimitOverriddenBy),
      overriddenAt: data.concurrencyLimitOverriddenAt,
    },
    // TODO: This needs to be removed but keeping this here for now to avoid breaking existing clients
    releaseConcurrencyOnWaitpoint: true,
  };
}

function toQueueConcurrencyOverriddenBy(user: User | null) {
  if (!user) return null;

  return user.displayName ?? user.name ?? null;
}
