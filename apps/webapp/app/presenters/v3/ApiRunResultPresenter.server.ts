import type { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction, PrismaReplicaClient } from "~/db.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
import { BasePresenter } from "./basePresenter.server";

type ApiRunResultReadThroughDeps = {
  splitEnabled?: boolean;
  newClient?: PrismaReplicaClient;
  // LEGACY RUN-OPS READ REPLICA ONLY (never a writer/primary); defaults to this._replica.
  legacyReplica?: PrismaReplicaClient;
  isPastRetention?: (runId: string) => boolean;
};

export class ApiRunResultPresenter extends BasePresenter {
  constructor(
    prisma?: PrismaClientOrTransaction,
    replica?: PrismaClientOrTransaction,
    private readonly _readThrough?: ApiRunResultReadThroughDeps
  ) {
    super(prisma, replica);
  }

  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<TaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const findRun = (client: PrismaReplicaClient) =>
        client.taskRun.findFirst({
          where: { friendlyId, runtimeEnvironmentId: env.id },
          include: { attempts: { orderBy: { createdAt: "desc" } } },
        });

      // Single-run result poll routed through run-ops read-through. Split on: primary store first,
      // then the secondary read replica for runs that miss on new; past-retention ids return
      // undefined -> the route's normal 404. Split off (single-DB / self-host): readThroughRun does
      // one plain findFirst against the single client (passthrough).
      const result = await readThroughRun({
        runId: friendlyId,
        environmentId: env.id,
        readNew: findRun,
        readLegacy: findRun,
        deps: {
          splitEnabled: this._readThrough?.splitEnabled,
          newClient: this._readThrough?.newClient ?? (this._prisma as PrismaReplicaClient),
          legacyReplica: this._readThrough?.legacyReplica ?? (this._replica as PrismaReplicaClient),
          isPastRetention: this._readThrough?.isPastRetention,
        },
      });

      const taskRun =
        result.source === "new" || result.source === "legacy-replica" ? result.value : undefined;

      if (!taskRun) {
        return undefined;
      }

      return executionResultForTaskRun(taskRun);
    });
  }
}
