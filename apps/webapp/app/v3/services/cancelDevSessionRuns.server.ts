import { type RunStore } from "@internal/run-store";
import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import {
  runOpsLegacyReplica as defaultLegacyReplica,
  runOpsNewReplica as defaultNewClient,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
} from "~/db.server";
import { findLatestSession } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { type ReadThroughDeps } from "../runOpsMigration/readThrough.server";
import { isSplitEnabled } from "../runOpsMigration/splitMode.server";
import { BaseService } from "./baseService.server";
import { type CancelableTaskRun, CancelTaskRunService } from "./cancelTaskRun.server";

export const CancelDevSessionRunsServiceOptions = z.object({
  runIds: z.array(z.string()),
  cancelledAt: z.coerce.date(),
  reason: z.string(),
  cancelledSessionId: z.string().optional(),
});

export type CancelDevSessionRunsServiceOptions = z.infer<typeof CancelDevSessionRunsServiceOptions>;

const RUN_SELECT = {
  id: true,
  engine: true,
  status: true,
  friendlyId: true,
  taskEventStore: true,
  createdAt: true,
  completedAt: true,
} as const;

export class CancelDevSessionRunsService extends BaseService {
  // Injectable read-through deps for the run-ops TaskRun read. Undefined in production:
  // the grouped read then uses its ~/db.server singleton handles and the boot split flag,
  // so single-DB is unchanged. Tests inject the hetero new/legacy handles + splitEnabled.
  readonly #readThroughDeps?: ReadThroughDeps;

  constructor(
    opts: {
      prisma?: PrismaClientOrTransaction;
      replica?: PrismaClientOrTransaction;
      runStore?: RunStore;
      readThroughDeps?: ReadThroughDeps;
    } = {}
  ) {
    super(opts.prisma, opts.replica, opts.runStore);
    this.#readThroughDeps = opts.readThroughDeps;
  }

  public async call(options: CancelDevSessionRunsServiceOptions) {
    const cancelledSession = options.cancelledSessionId
      ? await this._prisma.runtimeEnvironmentSession.findFirst({
          where: { id: options.cancelledSessionId },
        })
      : undefined;

    if (cancelledSession) {
      const latestSession = await findLatestSession(cancelledSession.environmentId, this._replica);

      if (
        latestSession &&
        latestSession.id !== cancelledSession.id &&
        !latestSession.disconnectedAt
      ) {
        logger.debug("Not cancelling runs because there is a newer session", {
          cancelledSessionId: cancelledSession.id,
          latestSessionId: latestSession.id,
        });

        return;
      }
    }

    logger.debug(
      "Cancelling in progress runs for dev session because there isn't a newer connected session",
      {
        options,
        cancelledSession,
      }
    );

    const cancelTaskRunService = new CancelTaskRunService();

    // Read every run up front, grouped by id shape and (when the split is on) by
    // residency, instead of the old per-run readThroughRun probe. Cancellation stays a
    // per-run mutation loop below, unchanged.
    const runsById = await this.#readRunsGrouped(options.runIds);

    for (const runId of options.runIds) {
      logger.debug("Cancelling in progress run", { runId });

      const taskRun = runsById.get(runId);

      if (!taskRun) {
        continue;
      }

      try {
        await cancelTaskRunService.call(taskRun, {
          reason: options.reason,
          cancelAttempts: true,
          cancelledAt: options.cancelledAt,
        });
      } catch (e) {
        logger.error("Failed to cancel in progress run", {
          runId,
          error: e,
        });
      }
    }
  }

  // Grouped replacement for readThroughRun-per-id: a constant number of queries
  // regardless of N. Same fan-out order as before (NEW-classified ids read only the
  // new store; LEGACY-classified ids probe new first, then the legacy replica for
  // misses; passthrough reads the single store once), just batched via findMany.
  async #readRunsGrouped(runIds: string[]): Promise<Map<string, CancelableTaskRun>> {
    const result = new Map<string, CancelableTaskRun>();

    if (runIds.length === 0) {
      return result;
    }

    const deps = this.#readThroughDeps;
    const newClient = deps?.newClient ?? defaultNewClient;
    const legacyReplica = deps?.legacyReplica ?? defaultLegacyReplica;
    const splitEnabled = deps?.splitEnabled ?? (await isSplitEnabled());

    const friendlyIds: string[] = [];
    const internalIds: string[] = [];

    for (const runId of runIds) {
      (runId.startsWith("run_") ? friendlyIds : internalIds).push(runId);
    }

    const applyRows = (
      rows: CancelableTaskRun[],
      requestedIds: string[],
      key: "id" | "friendlyId"
    ) => {
      const byKey = new Map(rows.map((row) => [row[key], row]));
      for (const id of requestedIds) {
        const row = byKey.get(id);
        if (row) {
          result.set(id, row);
        }
      }
    };

    if (!splitEnabled) {
      applyRows(await readGroup(newClient, internalIds, "id"), internalIds, "id");
      applyRows(await readGroup(newClient, friendlyIds, "friendlyId"), friendlyIds, "friendlyId");
      return result;
    }

    // classifyResidency is total (never throws): NEW ids read only the new store,
    // LEGACY ids fan out new-then-legacy-replica.
    const newIds: string[] = [];
    const newFriendlyIds: string[] = [];
    const legacyIds: string[] = [];
    const legacyFriendlyIds: string[] = [];

    for (const id of internalIds) {
      (ownerEngine(id) === "NEW" ? newIds : legacyIds).push(id);
    }
    for (const id of friendlyIds) {
      (ownerEngine(id) === "NEW" ? newFriendlyIds : legacyFriendlyIds).push(id);
    }

    applyRows(await readGroup(newClient, newIds, "id"), newIds, "id");
    applyRows(
      await readGroup(newClient, newFriendlyIds, "friendlyId"),
      newFriendlyIds,
      "friendlyId"
    );

    applyRows(await readGroup(newClient, legacyIds, "id"), legacyIds, "id");
    const legacyIdMisses = legacyIds.filter((id) => !result.has(id));
    applyRows(await readGroup(legacyReplica, legacyIdMisses, "id"), legacyIdMisses, "id");

    applyRows(
      await readGroup(newClient, legacyFriendlyIds, "friendlyId"),
      legacyFriendlyIds,
      "friendlyId"
    );
    const legacyFriendlyMisses = legacyFriendlyIds.filter((id) => !result.has(id));
    applyRows(
      await readGroup(legacyReplica, legacyFriendlyMisses, "friendlyId"),
      legacyFriendlyMisses,
      "friendlyId"
    );

    return result;
  }

  static async enqueue(options: CancelDevSessionRunsServiceOptions, runAt?: Date) {
    return await commonWorker.enqueue({
      id: options.cancelledSessionId
        ? `cancelDevSessionRuns:${options.cancelledSessionId}`
        : undefined,
      job: "v3.cancelDevSessionRuns",
      payload: options,
      availableAt: runAt,
    });
  }
}

// One `findFirst` for a lone id (byte-identical to the old per-run read), or one
// `findMany` for 2+ ids in the same bucket — the N+1 fix.
async function readGroup(
  client: PrismaReplicaClient,
  ids: string[],
  field: "id" | "friendlyId"
): Promise<CancelableTaskRun[]> {
  if (ids.length === 0) {
    return [];
  }

  if (ids.length === 1) {
    const row =
      field === "id"
        ? await client.taskRun.findFirst({ where: { id: ids[0] }, select: RUN_SELECT })
        : await client.taskRun.findFirst({ where: { friendlyId: ids[0] }, select: RUN_SELECT });
    return row ? [row] : [];
  }

  return field === "id"
    ? client.taskRun.findMany({ where: { id: { in: ids } }, select: RUN_SELECT })
    : client.taskRun.findMany({ where: { friendlyId: { in: ids } }, select: RUN_SELECT });
}
