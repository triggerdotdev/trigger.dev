import type { BatchTaskRunExecutionResult } from "@trigger.dev/core/v3";
import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import {
  $replica,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
  prisma,
} from "~/db.server";
import type { TaskRunWithAttempts } from "~/models/taskRun.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
import { BasePresenter } from "./basePresenter.server";

/**
 * Run-ops read-through wiring. All optional; absent (or `splitEnabled` falsy) collapses `call` to
 * passthrough. `legacyReplica` is a READ REPLICA handle only — there is NO legacy-primary field.
 */
type ApiBatchResultsReadThroughDeps = {
  splitEnabled?: boolean;
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  isPastRetention?: (runId: string) => boolean;
};

// The TaskRun shape `executionResultForTaskRun` consumes. Shared by both read sites.
const memberRunSelect = {
  id: true,
  friendlyId: true,
  status: true,
  taskIdentifier: true,
  attempts: {
    select: {
      status: true,
      output: true,
      outputType: true,
      error: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  },
} as const;

/**
 * Split on: the batch row + its members resolve new-run-ops first, then the LEGACY RUN-OPS READ
 * REPLICA ONLY (never the legacy primary — there is no such handle). Members hydrate via ONE
 * grouped read against `newClient` for the whole id set, then ONE grouped read against
 * `legacyReplica` for just the misses that could still be legacy-resident — the same
 * residency-partitioned shape as the old per-member read-through, but batched instead of fanned
 * out one query per member. A batch whose members span migrated + abandoned runs returns the
 * complete reachable set (the batch-spanning-the-line read; the dangling-reference termination
 * gate is a separate, adjacent unit).
 *
 * Split off (single-DB / self-host): one passthrough read for the batch row + a single store
 * id-set hydrate for the members — no legacy read, no known-migrated probe, no second connection.
 */
export class ApiBatchResultsPresenter extends BasePresenter {
  constructor(
    prismaClient: PrismaClientOrTransaction = prisma,
    replicaClient: PrismaClientOrTransaction = $replica,
    private readonly readThrough?: ApiBatchResultsReadThroughDeps,
    private readonly runStore = defaultRunStore
  ) {
    super(prismaClient, replicaClient);
  }

  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const splitEnabled = this.readThrough?.splitEnabled ?? false;

      if (!splitEnabled) {
        return this.#callPassthrough(friendlyId, env);
      }

      return this.#callSplit(friendlyId, env);
    });
  }

  // Passthrough: batch row off the replica, members via the single run store. No legacy read.
  async #callPassthrough(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    const batchRun = await this._replica.batchTaskRun.findFirst({
      where: {
        friendlyId,
        runtimeEnvironmentId: env.id,
      },
      include: {
        items: {
          select: {
            taskRunId: true,
          },
        },
      },
    });

    if (!batchRun) {
      return undefined;
    }

    const taskRunIds = batchRun.items.map((item) => item.taskRunId);

    if (taskRunIds.length === 0) {
      return {
        id: batchRun.friendlyId,
        items: [],
      };
    }

    const taskRuns = await this.runStore.findRuns(
      {
        where: { id: { in: taskRunIds } },
        select: memberRunSelect,
      },
      this._prisma
    );

    const runMap = new Map(taskRuns.map((run) => [run.id, run]));

    return {
      id: batchRun.friendlyId,
      items: batchRun.items
        .map((item) => {
          const run = runMap.get(item.taskRunId);
          return run ? executionResultForTaskRun(run as TaskRunWithAttempts) : undefined;
        })
        .filter(Boolean),
    };
  }

  // Split: resolve the batch row new-first then off the legacy READ REPLICA only (a batch id may
  // be cuid or run-ops id, and a cuid-shaped id can still have been backfilled onto NEW, so id-shape
  // residency is not authoritative for the row — the new-first-then-legacy probe is), then
  // hydrate every member run in ONE grouped new-then-legacy read.
  async #callSplit(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    // Resolve both handles ONCE so the batch row and its members never read from different DBs.
    const newClient = (this.readThrough?.newClient ?? this._replica) as PrismaReplicaClient;
    const legacyReplica = (this.readThrough?.legacyReplica ?? this._replica) as PrismaReplicaClient;

    const readBatch = (client: PrismaClientOrTransaction) =>
      client.batchTaskRun.findFirst({
        where: {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
        include: {
          items: {
            select: {
              taskRunId: true,
            },
          },
        },
      });

    let batchRun = await readBatch(newClient);

    // Legacy READ REPLICA probe, only on a new-probe miss; skipped when past retention.
    if (!batchRun && !this.readThrough?.isPastRetention?.(friendlyId)) {
      batchRun = await readBatch(legacyReplica);
    }

    if (!batchRun) {
      return undefined;
    }

    if (batchRun.items.length === 0) {
      return {
        id: batchRun.friendlyId,
        items: [],
      };
    }

    const taskRunIds = batchRun.items.map((item) => item.taskRunId);

    const newRows = (await newClient.taskRun.findMany({
      where: { id: { in: taskRunIds } },
      select: memberRunSelect,
    })) as TaskRunWithAttempts[];
    const runsById = new Map(newRows.map((run) => [run.id, run]));

    // A run-ops id can only live on NEW, so only misses that AREN'T run-ops-shaped are candidates
    // for the legacy probe — mirrors readThroughRun's per-id "NEW residency skips legacy" rule.
    const legacyCandidateIds = taskRunIds.filter(
      (id) => !runsById.has(id) && ownerEngine(id) !== "NEW"
    );
    if (legacyCandidateIds.length > 0) {
      const legacyRows = (await legacyReplica.taskRun.findMany({
        where: { id: { in: legacyCandidateIds } },
        select: memberRunSelect,
      })) as TaskRunWithAttempts[];
      for (const run of legacyRows) {
        runsById.set(run.id, run);
      }
    }

    // not-found members are omitted (matches today's drop-undefined behavior); the
    // dangling-reference termination gate (separate unit) governs whether that's permitted.
    const memberResults = batchRun.items.map((item) => {
      const run = runsById.get(item.taskRunId);
      return run ? executionResultForTaskRun(run) : undefined;
    });

    return {
      id: batchRun.friendlyId,
      items: memberResults.filter(Boolean),
    };
  }
}
