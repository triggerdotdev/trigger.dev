import type { BatchTaskRunExecutionResult } from "@trigger.dev/core/v3";
import {
  $replica,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
  prisma,
} from "~/db.server";
import type { TaskRunWithAttempts } from "~/models/taskRun.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
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
 * Split on: the batch row + its item rows resolve new-run-ops first, then the LEGACY RUN-OPS
 * READ REPLICA ONLY (never the legacy primary — there is no such handle); each member run is
 * hydrated independently via readThroughRun keyed on the member runId, so a batch whose members
 * span migrated + abandoned runs returns the complete reachable set (the batch-spanning-the-line
 * read; the dangling-reference termination gate is a separate, adjacent unit).
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
  // hydrate every member run independently via the per-run read-through primitive.
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

    const readMemberRun = (client: PrismaClientOrTransaction, taskRunId: string) =>
      client.taskRun.findFirst({
        where: { id: taskRunId },
        select: memberRunSelect,
      }) as Promise<TaskRunWithAttempts | null>;

    // Per-member fan-out: each member may live on a different DB, so a single nested include cannot
    // cross the seam. Promise.all preserves batchRun.items order, unchanged from today.
    const memberResults = await Promise.all(
      batchRun.items.map(async (item) => {
        const result = await readThroughRun<TaskRunWithAttempts>({
          runId: item.taskRunId,
          environmentId: env.id,
          readNew: (client) => readMemberRun(client, item.taskRunId),
          readLegacy: (replica) => readMemberRun(replica, item.taskRunId),
          deps: {
            splitEnabled: true,
            // Pass the SAME resolved handles the batch row used, so the batch row and its members
            // never resolve against different DBs. (Letting these fall through to readThroughRun's
            // own module-level defaults would diverge from the batch read's `?? this._replica`.)
            newClient,
            legacyReplica,
            isPastRetention: this.readThrough?.isPastRetention,
          },
        });

        // not-found / past-retention members are omitted (matches today's drop-undefined behavior);
        // the dangling-reference termination gate (separate unit) governs whether that's permitted.
        if (result.source === "not-found" || result.source === "past-retention") {
          return undefined;
        }

        return executionResultForTaskRun(result.value);
      })
    );

    return {
      id: batchRun.friendlyId,
      items: memberResults.filter(Boolean),
    };
  }
}
