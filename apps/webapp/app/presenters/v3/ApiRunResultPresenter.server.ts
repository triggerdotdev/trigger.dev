import type { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction, PrismaReplicaClient } from "~/db.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
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
    private readonly _readThrough?: ApiRunResultReadThroughDeps,
    private readonly runStore = defaultRunStore
  ) {
    super(prisma, replica);
  }

  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<TaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      // Single-run result poll routed through the run store, which selects the owning DB by
      // run-id residency (id shape): a run-ops (NEW) id reads the new store, a cuid (LEGACY) id
      // reads the legacy store. Single-DB / self-host collapses to one plain findFirst against the
      // one store (passthrough). The identical TaskRun(+attempts) lookup runs inside the router.
      const taskRun = await this.runStore.findRun(
        { friendlyId, runtimeEnvironmentId: env.id },
        { include: { attempts: { orderBy: { createdAt: "desc" } } } }
      );

      if (!taskRun) {
        return undefined;
      }

      return executionResultForTaskRun(taskRun);
    });
  }
}
