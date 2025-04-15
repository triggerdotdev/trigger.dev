import {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  PrismaClientOrTransaction,
  TaskQueue,
  WorkerDeployment,
} from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";

type RunWithMininimalEnvironment = Prisma.TaskRunGetPayload<{
  include: {
    runtimeEnvironment: {
      select: {
        id: true;
        type: true;
      };
    };
  };
}>;

type RunWithBackgroundWorkerTasksResult =
  | {
      success: false;
      code: "NO_RUN";
      message: string;
    }
  | {
      success: false;
      code:
        | "NO_WORKER"
        | "TASK_NOT_IN_LATEST"
        | "TASK_NEVER_REGISTERED"
        | "BACKGROUND_WORKER_MISMATCH"
        | "QUEUE_NOT_FOUND";
      message: string;
      run: RunWithMininimalEnvironment;
    }
  | {
      success: false;
      code: "BACKGROUND_WORKER_MISMATCH";
      message: string;
      backgroundWorker: {
        expected: string;
        received: string;
      };
      run: RunWithMininimalEnvironment;
    }
  | {
      success: true;
      run: RunWithMininimalEnvironment;
      worker: BackgroundWorker;
      task: BackgroundWorkerTask;
      queue: TaskQueue;
      deployment: WorkerDeployment | null;
    };

export async function getRunWithBackgroundWorkerTasks(
  prisma: PrismaClientOrTransaction,
  runId: string,
  backgroundWorkerId?: string
): Promise<RunWithBackgroundWorkerTasksResult> {
  const run = await prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
    include: {
      runtimeEnvironment: {
        select: {
          id: true,
          type: true,
        },
      },
      lockedToVersion: {
        include: {
          deployment: true,
          tasks: true,
        },
      },
    },
  });

  if (!run) {
    return {
      success: false as const,
      code: "NO_RUN",
      message: `No run found with id: ${runId}`,
    };
  }

  const workerId = run.lockedToVersionId ?? backgroundWorkerId;

  //get the relevant BackgroundWorker with tasks and deployment (if not DEV)
  let workerWithTasks: WorkerDeploymentWithWorkerTasks | null = null;

  if (run.runtimeEnvironment.type === "DEVELOPMENT") {
    workerWithTasks = workerId
      ? await getWorkerById(prisma, workerId)
      : await getMostRecentWorker(prisma, run.runtimeEnvironmentId);
  } else {
    workerWithTasks = workerId
      ? await getWorkerDeploymentFromWorker(prisma, workerId)
      : await getManagedWorkerFromCurrentlyPromotedDeployment(prisma, run.runtimeEnvironmentId);
  }

  if (!workerWithTasks) {
    return {
      success: false as const,
      code: "NO_WORKER",
      message: `No worker found for run: ${run.id}`,
      run,
    };
  }

  if (backgroundWorkerId) {
    if (backgroundWorkerId !== workerWithTasks.worker.id) {
      return {
        success: false as const,
        code: "BACKGROUND_WORKER_MISMATCH",
        message: `Background worker mismatch for run: ${run.id}`,
        backgroundWorker: {
          expected: backgroundWorkerId,
          received: workerWithTasks.worker.id,
        },
        run,
      };
    }
  }

  const backgroundTask = workerWithTasks.tasks.find((task) => task.slug === run.taskIdentifier);

  if (!backgroundTask) {
    const nonCurrentTask = await prisma.backgroundWorkerTask.findFirst({
      where: {
        slug: run.taskIdentifier,
        projectId: run.projectId,
        runtimeEnvironmentId: run.runtimeEnvironmentId,
      },
      include: {
        worker: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (nonCurrentTask) {
      return {
        success: false as const,
        code: "TASK_NOT_IN_LATEST",
        message: `Task not found in latest version: ${run.taskIdentifier}. Found in ${nonCurrentTask.worker.version}`,
        run,
      };
    } else {
      return {
        success: false as const,
        code: "TASK_NEVER_REGISTERED",
        message: `Task has never been registered (in dev or deployed): ${run.taskIdentifier}`,
        run,
      };
    }
  }

  const queue = workerWithTasks.queues.find((queue) => queue.name === run.queue);

  if (!queue) {
    return {
      success: false as const,
      code: "QUEUE_NOT_FOUND",
      message: `Queue not found for run: ${run.id}`,
      run,
    };
  }

  return {
    success: true as const,
    run,
    worker: workerWithTasks.worker,
    task: backgroundTask,
    queue,
    deployment: workerWithTasks.deployment,
  };
}

type WorkerDeploymentWithWorkerTasks = {
  worker: BackgroundWorker;
  tasks: BackgroundWorkerTask[];
  queues: TaskQueue[];
  deployment: WorkerDeployment | null;
};

export async function getWorkerDeploymentFromWorker(
  prisma: PrismaClientOrTransaction,
  workerId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const worker = await prisma.backgroundWorker.findFirst({
    where: {
      id: workerId,
    },
    include: {
      deployment: true,
      tasks: true,
      queues: true,
    },
  });

  if (!worker) {
    return null;
  }

  return { worker, tasks: worker.tasks, queues: worker.queues, deployment: worker.deployment };
}

export async function getMostRecentWorker(
  prisma: PrismaClientOrTransaction,
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const worker = await prisma.backgroundWorker.findFirst({
    where: {
      runtimeEnvironmentId: environmentId,
    },
    include: {
      tasks: true,
      queues: true,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!worker) {
    return null;
  }

  return { worker, tasks: worker.tasks, queues: worker.queues, deployment: null };
}

export async function getWorkerById(
  prisma: PrismaClientOrTransaction,
  workerId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const worker = await prisma.backgroundWorker.findFirst({
    where: {
      id: workerId,
    },
    include: {
      deployment: true,
      tasks: true,
      queues: true,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!worker) {
    return null;
  }

  return { worker, tasks: worker.tasks, queues: worker.queues, deployment: worker.deployment };
}

export async function getManagedWorkerFromCurrentlyPromotedDeployment(
  prisma: PrismaClientOrTransaction,
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const promotion = await prisma.workerDeploymentPromotion.findFirst({
    where: {
      environmentId,
      label: CURRENT_DEPLOYMENT_LABEL,
    },
    include: {
      deployment: {
        include: {
          worker: {
            include: {
              tasks: true,
              queues: true,
            },
          },
        },
      },
    },
  });

  if (!promotion || !promotion.deployment.worker) {
    return null;
  }

  if (promotion.deployment.type === "MANAGED") {
    // This is a run engine v2 deployment, so return it
    return {
      worker: promotion.deployment.worker,
      tasks: promotion.deployment.worker.tasks,
      queues: promotion.deployment.worker.queues,
      deployment: promotion.deployment,
    };
  }

  // We need to get the latest run engine v2 deployment
  const latestV2Deployment = await prisma.workerDeployment.findFirst({
    where: {
      environmentId,
      type: "MANAGED",
    },
    orderBy: {
      id: "desc",
    },
    include: {
      worker: {
        include: {
          tasks: true,
          queues: true,
        },
      },
    },
  });

  if (!latestV2Deployment?.worker) {
    return null;
  }

  return {
    worker: latestV2Deployment.worker,
    tasks: latestV2Deployment.worker.tasks,
    queues: latestV2Deployment.worker.queues,
    deployment: latestV2Deployment,
  };
}
