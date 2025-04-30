import { EnqueueSystem } from "./enqueueSystem.js";
import { SystemResources } from "./systems.js";

export type PendingVersionSystemOptions = {
  resources: SystemResources;
  enqueueSystem: EnqueueSystem;
  queueRunsPendingVersionBatchSize?: number;
};

export class PendingVersionSystem {
  private readonly $: SystemResources;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: PendingVersionSystemOptions) {
    this.$ = options.resources;
    this.enqueueSystem = options.enqueueSystem;
  }

  async enqueueRunsForBackgroundWorker(backgroundWorkerId: string) {
    //It could be a lot of runs, so we will process them in a batch
    //if there are still more to process we will enqueue this function again
    const maxCount = this.options.queueRunsPendingVersionBatchSize ?? 200;

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
        queues: true,
      },
    });

    if (!backgroundWorker) {
      this.$.logger.error("#enqueueRunsForBackgroundWorker: background worker not found", {
        id: backgroundWorkerId,
      });
      return;
    }

    this.$.logger.debug("Finding PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      taskIdentifiers: backgroundWorker.tasks.map((task) => task.slug),
      queues: backgroundWorker.queues.map((queue) => queue.name),
    });

    const pendingRuns = await this.$.prisma.taskRun.findMany({
      where: {
        runtimeEnvironmentId: backgroundWorker.runtimeEnvironmentId,
        projectId: backgroundWorker.projectId,
        status: "PENDING_VERSION",
        taskIdentifier: {
          in: backgroundWorker.tasks.map((task) => task.slug),
        },
        queue: {
          in: backgroundWorker.queues.map((queue) => queue.name),
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: maxCount + 1,
    });

    //none to process
    if (!pendingRuns.length) return;

    this.$.logger.debug("Enqueueing PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      taskIdentifiers: pendingRuns.map((run) => run.taskIdentifier),
      queues: pendingRuns.map((run) => run.queue),
      runs: pendingRuns.map((run) => ({
        id: run.id,
        taskIdentifier: run.taskIdentifier,
        queue: run.queue,
        createdAt: run.createdAt,
        priorityMs: run.priorityMs,
      })),
    });

    for (const run of pendingRuns) {
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
          tx,
        });
      });

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: run.id,
          status: "PENDING",
          updatedAt: run.updatedAt,
        },
        organization: {
          id: backgroundWorker.runtimeEnvironment.organizationId,
        },
        project: {
          id: backgroundWorker.runtimeEnvironment.projectId,
        },
        environment: {
          id: backgroundWorker.runtimeEnvironmentId,
        },
      });
    }

    //enqueue more if needed
    if (pendingRuns.length > maxCount) {
      await this.scheduleResolvePendingVersionRuns(backgroundWorkerId);
    }
  }

  async scheduleResolvePendingVersionRuns(backgroundWorkerId: string): Promise<void> {
    //we want this to happen in the background
    await this.$.worker.enqueue({
      job: "queueRunsPendingVersion",
      payload: { backgroundWorkerId },
    });
  }
}
