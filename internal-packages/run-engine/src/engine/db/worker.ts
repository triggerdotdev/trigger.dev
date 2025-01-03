import {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  PrismaClientOrTransaction,
  WorkerDeployment,
} from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/apps";

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
        | "BACKGROUND_WORKER_MISMATCH";
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
  const workerWithTasks = workerId
    ? await getWorkerDeploymentFromWorker(prisma, workerId)
    : run.runtimeEnvironment.type === "DEVELOPMENT"
    ? await getMostRecentWorker(prisma, run.runtimeEnvironmentId)
    : await getWorkerFromCurrentlyPromotedDeployment(prisma, run.runtimeEnvironmentId);

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

  return {
    success: true as const,
    run,
    worker: workerWithTasks.worker,
    task: backgroundTask,
    deployment: workerWithTasks.deployment,
  };
}

type WorkerDeploymentWithWorkerTasks = {
  worker: BackgroundWorker;
  tasks: BackgroundWorkerTask[];
  deployment: WorkerDeployment | null;
};

export async function getWorkerDeploymentFromWorker(
  prisma: PrismaClientOrTransaction,
  workerId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const worker = await prisma.backgroundWorker.findUnique({
    where: {
      id: workerId,
    },
    include: {
      deployment: true,
      tasks: true,
    },
  });

  if (!worker) {
    return null;
  }

  return { worker, tasks: worker.tasks, deployment: worker.deployment };
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
      deployment: true,
      tasks: true,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!worker) {
    return null;
  }

  return { worker, tasks: worker.tasks, deployment: worker.deployment };
}

export async function getWorkerFromCurrentlyPromotedDeployment(
  prisma: PrismaClientOrTransaction,
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | null> {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
    },
    include: {
      deployment: {
        include: {
          worker: {
            include: {
              tasks: true,
            },
          },
        },
      },
    },
  });

  if (!promotion || !promotion.deployment.worker) {
    return null;
  }

  return {
    worker: promotion.deployment.worker,
    tasks: promotion.deployment.worker.tasks,
    deployment: promotion.deployment,
  };
}
