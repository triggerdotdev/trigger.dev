import type { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction, PrismaReplicaClient } from "~/db.server";
import { runOpsLegacyReplica } from "~/db.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
import { BasePresenter } from "./basePresenter.server";

type ApiRunResultReadThroughDeps = {
  splitEnabled?: boolean;
  newClient?: PrismaReplicaClient;
  // LEGACY RUN-OPS READ REPLICA ONLY (never a writer/primary); defaults to runOpsLegacyReplica
  // (the Aurora legacy read replica), never the control-plane replica.
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
      // Single-run result poll routed through run-ops read-through. Split on: primary store first,
      // then the LEGACY RUN-OPS READ REPLICA for runs that miss on new; past-retention ids return
      // undefined -> the route's normal 404. Split off (single-DB / self-host): readThroughRun does
      // one plain findFirst against the single client (passthrough). Both legs run the identical
      // TaskRun(+attempts) lookup, inlined so the read resolves inside the router.
      const result = await readThroughRun({
        runId: friendlyId,
        environmentId: env.id,
        readNew: (client) =>
          client.taskRun.findFirst({
            // runops-routed-ok: readThroughRun new leg
            where: { friendlyId, runtimeEnvironmentId: env.id },
            include: { attempts: { orderBy: { createdAt: "desc" } } },
          }),
        readLegacy: (replica) =>
          replica.taskRun.findFirst({
            // runops-routed-ok: readThroughRun legacy leg
            where: { friendlyId, runtimeEnvironmentId: env.id },
            include: { attempts: { orderBy: { createdAt: "desc" } } },
          }),
        deps: {
          splitEnabled: this._readThrough?.splitEnabled,
          newClient: this._readThrough?.newClient ?? (this._prisma as PrismaReplicaClient),
          legacyReplica: this._readThrough?.legacyReplica ?? runOpsLegacyReplica,
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
