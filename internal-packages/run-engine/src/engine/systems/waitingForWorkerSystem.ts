import { EnqueueSystem } from "./enqueueSystem.js";
import { SystemResources } from "./systems.js";

export type WaitingForWorkerSystemOptions = {
  resources: SystemResources;
  enqueueSystem: EnqueueSystem;
  queueRunsWaitingForWorkerBatchSize?: number;
};

export class WaitingForWorkerSystem {
  private readonly $: SystemResources;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: WaitingForWorkerSystemOptions) {
    this.$ = options.resources;
    this.enqueueSystem = options.enqueueSystem;
  }

  async enqueueRunsWaitingForWorker({ backgroundWorkerId }: { backgroundWorkerId: string }) {
    //It could be a lot of runs, so we will process them in a batch
    //if there are still more to process we will enqueue this function again
    const maxCount = this.options.queueRunsWaitingForWorkerBatchSize ?? 200;

    const backgroundWorker = await this.$.prisma.backgroundWorker.findFirst({
      where: {
        id: backgroundWorkerId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      this.$.logger.error("#queueRunsWaitingForWorker: background worker not found", {
        id: backgroundWorkerId,
      });
      return;
    }

    const runsWaitingForDeploy = await this.$.prisma.taskRun.findMany({
      where: {
        runtimeEnvironmentId: backgroundWorker.runtimeEnvironmentId,
        projectId: backgroundWorker.projectId,
        status: "WAITING_FOR_DEPLOY",
        taskIdentifier: {
          in: backgroundWorker.tasks.map((task) => task.slug),
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: maxCount + 1,
    });

    //none to process
    if (!runsWaitingForDeploy.length) return;

    for (const run of runsWaitingForDeploy) {
      await this.$.prisma.$transaction(async (tx) => {
        const updatedRun = await tx.taskRun.update({
          where: {
            id: run.id,
          },
          data: {
            status: "PENDING",
          },
        });
        await this.enqueueSystem.enqueueRun({
          run: updatedRun,
          env: backgroundWorker.runtimeEnvironment,
          //add to the queue using the original run created time
          //this should ensure they're in the correct order in the queue
          timestamp: updatedRun.createdAt.getTime() - updatedRun.priorityMs,
          tx,
        });
      });
    }

    //enqueue more if needed
    if (runsWaitingForDeploy.length > maxCount) {
      await this.scheduleEnqueueRunsWaitingForWorker({ backgroundWorkerId });
    }
  }

  async scheduleEnqueueRunsWaitingForWorker({
    backgroundWorkerId,
  }: {
    backgroundWorkerId: string;
  }): Promise<void> {
    //we want this to happen in the background
    await this.$.worker.enqueue({
      job: "queueRunsWaitingForWorker",
      payload: { backgroundWorkerId },
    });
  }
}
