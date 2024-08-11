import {
  BackgroundWorkerFileMetadata,
  CreateBackgroundWorkerRequestBody,
  TaskResource,
} from "@trigger.dev/core/v3";
import type { BackgroundWorker } from "@trigger.dev/database";
import { Prisma, PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { BaseService } from "./baseService.server";
import { projectPubSub } from "./projectPubSub.server";
import { RegisterNextTaskScheduleInstanceService } from "./registerNextTaskScheduleInstance.server";
import cronstrue from "cronstrue";
import { CheckScheduleService } from "./checkSchedule.server";

export class CreateBackgroundWorkerService extends BaseService {
  public async call(
    projectRef: string,
    environment: AuthenticatedEnvironment,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker> {
    return this.traceWithEnv("call", environment, async (span) => {
      span.setAttribute("projectRef", projectRef);

      const project = await this._prisma.project.findUniqueOrThrow({
        where: {
          externalRef: projectRef,
          environments: {
            some: {
              id: environment.id,
            },
          },
        },
        include: {
          backgroundWorkers: {
            where: {
              runtimeEnvironmentId: environment.id,
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
          },
        },
      });

      const latestBackgroundWorker = project.backgroundWorkers[0];

      if (latestBackgroundWorker?.contentHash === body.metadata.contentHash) {
        return latestBackgroundWorker;
      }

      const nextVersion = calculateNextBuildVersion(project.backgroundWorkers[0]?.version);

      logger.debug(`Creating background worker`, {
        nextVersion,
        lastVersion: project.backgroundWorkers[0]?.version,
      });

      const backgroundWorker = await this._prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          version: nextVersion,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          metadata: body.metadata,
          contentHash: body.metadata.contentHash,
          cliVersion: body.metadata.cliPackageVersion,
          sdkVersion: body.metadata.packageVersion,
          supportsLazyAttempts: body.supportsLazyAttempts,
        },
      });

      const tasksToBackgroundFiles = await createBackgroundFiles(
        body.metadata.fileContents,
        backgroundWorker,
        environment,
        this._prisma
      );
      await createBackgroundTasks(
        body.metadata.tasks,
        backgroundWorker,
        environment,
        this._prisma,
        tasksToBackgroundFiles
      );
      await syncDeclarativeSchedules(
        body.metadata.tasks,
        backgroundWorker,
        environment,
        this._prisma
      );

      try {
        //send a notification that a new worker has been created
        await projectPubSub.publish(
          `project:${project.id}:env:${environment.id}`,
          "WORKER_CREATED",
          {
            environmentId: environment.id,
            environmentType: environment.type,
            createdAt: backgroundWorker.createdAt,
            taskCount: body.metadata.tasks.length,
            type: "local",
          }
        );

        await marqs?.updateEnvConcurrencyLimits(environment);
      } catch (err) {
        logger.error(
          "Error publishing WORKER_CREATED event or updating global concurrency limits",
          {
            error:
              err instanceof Error
                ? {
                    name: err.name,
                    message: err.message,
                    stack: err.stack,
                  }
                : err,
            project,
            environment,
            backgroundWorker,
          }
        );
      }

      return backgroundWorker;
    });
  }
}

export async function createBackgroundTasks(
  tasks: TaskResource[],
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
) {
  for (const task of tasks) {
    try {
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: generateFriendlyId("task"),
          projectId: worker.projectId,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
          workerId: worker.id,
          slug: task.id,
          filePath: task.filePath,
          exportName: task.exportName,
          retryConfig: task.retry,
          queueConfig: task.queue,
          machineConfig: task.machine,
          triggerSource: task.triggerSource === "schedule" ? "SCHEDULED" : "STANDARD",
          fileId: tasksToBackgroundFiles?.get(task.id) ?? null,
        },
      });

      let queueName = sanitizeQueueName(task.queue?.name ?? `task/${task.id}`);

      // Check that the queuename is not an empty string
      if (!queueName) {
        queueName = sanitizeQueueName(`task/${task.id}`);
      }

      const concurrencyLimit =
        typeof task.queue?.concurrencyLimit === "number"
          ? Math.max(
              Math.min(
                task.queue.concurrencyLimit,
                environment.maximumConcurrencyLimit,
                environment.organization.maximumConcurrencyLimit
              ),
              0
            )
          : null;

      const taskQueue = await prisma.taskQueue.upsert({
        where: {
          runtimeEnvironmentId_name: {
            runtimeEnvironmentId: worker.runtimeEnvironmentId,
            name: queueName,
          },
        },
        update: {
          concurrencyLimit,
          rateLimit: task.queue?.rateLimit,
        },
        create: {
          friendlyId: generateFriendlyId("queue"),
          name: queueName,
          concurrencyLimit,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
          projectId: worker.projectId,
          rateLimit: task.queue?.rateLimit,
          type: task.queue?.name ? "NAMED" : "VIRTUAL",
        },
      });

      if (typeof taskQueue.concurrencyLimit === "number") {
        await marqs?.updateQueueConcurrencyLimits(
          environment,
          taskQueue.name,
          taskQueue.concurrencyLimit
        );
      } else {
        await marqs?.removeQueueConcurrencyLimits(environment, taskQueue.name);
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // The error code for unique constraint violation in Prisma is P2002
        if (error.code === "P2002") {
          logger.warn("Task already exists", {
            task,
            worker,
          });
        } else {
          logger.error("Prisma Error creating background worker task", {
            error: {
              code: error.code,
              message: error.message,
            },
            task,
            worker,
          });
        }
      } else if (error instanceof Error) {
        logger.error("Error creating background worker task", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
          task,
          worker,
        });
      } else {
        logger.error("Unknown error creating background worker task", {
          error,
          task,
          worker,
        });
      }
    }
  }
}

//CreateDeclarativeScheduleError with a message
export class CreateDeclarativeScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateDeclarativeScheduleError";
  }
}

export async function syncDeclarativeSchedules(
  tasks: TaskResource[],
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  const tasksWithDeclarativeSchedules = tasks.filter((task) => task.schedule);
  logger.info("Syncing declarative schedules", {
    tasksWithDeclarativeSchedules,
    environment,
  });

  const existingDeclarativeSchedules = await prisma.taskSchedule.findMany({
    where: {
      type: "DECLARATIVE",
      projectId: environment.projectId,
    },
    include: {
      instances: true,
    },
  });

  const checkSchedule = new CheckScheduleService(prisma);
  const registerNextService = new RegisterNextTaskScheduleInstanceService(prisma);

  //start out by assuming they're all missing
  const missingSchedules = new Set<string>(
    existingDeclarativeSchedules.map((schedule) => schedule.id)
  );

  //create/update schedules (+ instances)
  for (const task of tasksWithDeclarativeSchedules) {
    if (task.schedule === undefined) continue;

    const existingSchedule = existingDeclarativeSchedules.find(
      (schedule) =>
        schedule.taskIdentifier === task.id &&
        schedule.instances.some((instance) => instance.environmentId === environment.id)
    );

    //this throws errors if the schedule is invalid
    await checkSchedule.call(environment.projectId, {
      cron: task.schedule.cron,
      timezone: task.schedule.timezone,
      taskIdentifier: task.id,
      friendlyId: existingSchedule?.friendlyId,
    });

    if (existingSchedule) {
      const schedule = await prisma.taskSchedule.update({
        where: {
          id: existingSchedule.id,
        },
        data: {
          generatorExpression: task.schedule.cron,
          generatorDescription: cronstrue.toString(task.schedule.cron),
          timezone: task.schedule.timezone,
        },
        include: {
          instances: true,
        },
      });

      missingSchedules.delete(existingSchedule.id);
      const instance = schedule.instances.at(0);
      if (instance) {
        await registerNextService.call(instance.id);
      } else {
        throw new CreateDeclarativeScheduleError(
          `Missing instance for declarative schedule ${schedule.id}`
        );
      }
    } else {
      const newSchedule = await prisma.taskSchedule.create({
        data: {
          friendlyId: generateFriendlyId("sched"),
          projectId: environment.projectId,
          taskIdentifier: task.id,
          generatorExpression: task.schedule.cron,
          generatorDescription: cronstrue.toString(task.schedule.cron),
          timezone: task.schedule.timezone,
          type: "DECLARATIVE",
          instances: {
            create: [
              {
                environmentId: environment.id,
              },
            ],
          },
        },
        include: {
          instances: true,
        },
      });

      const instance = newSchedule.instances.at(0);

      if (instance) {
        await registerNextService.call(instance.id);
      } else {
        throw new CreateDeclarativeScheduleError(
          `Missing instance for declarative schedule ${newSchedule.id}`
        );
      }
    }
  }

  //Delete instances for this environment
  //Delete schedules that have no instances left
  const potentiallyDeletableSchedules = await prisma.taskSchedule.findMany({
    where: {
      id: {
        in: Array.from(missingSchedules),
      },
    },
    include: {
      instances: true,
    },
  });

  for (const schedule of potentiallyDeletableSchedules) {
    const canDeleteSchedule =
      schedule.instances.length === 0 ||
      schedule.instances.every((instance) => instance.environmentId === environment.id);

    if (canDeleteSchedule) {
      //we can delete schedules with no instances other than ones for the current environment
      await prisma.taskSchedule.delete({
        where: {
          id: schedule.id,
        },
      });
    } else {
      //otherwise we delete the instance (other environments remain untouched)
      await prisma.taskScheduleInstance.deleteMany({
        where: {
          taskScheduleId: schedule.id,
          environmentId: environment.id,
        },
      });
    }
  }
}

export async function createBackgroundFiles(
  files: Array<BackgroundWorkerFileMetadata> | undefined,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  // Maps from each taskId to the backgroundWorkerFileId
  const results = new Map<string, string>();

  if (!files) {
    return results;
  }

  for (const file of files) {
    const backgroundWorkerFile = await prisma.backgroundWorkerFile.upsert({
      where: {
        projectId_contentHash: {
          projectId: environment.projectId,
          contentHash: file.contentHash,
        },
      },
      create: {
        friendlyId: generateFriendlyId("file"),
        projectId: environment.projectId,
        contentHash: file.contentHash,
        filePath: file.filePath,
        contents: Buffer.from(file.contents),
        backgroundWorkers: {
          connect: {
            id: worker.id,
          },
        },
      },
      update: {
        backgroundWorkers: {
          connect: {
            id: worker.id,
          },
        },
      },
    });

    for (const taskId of file.taskIds) {
      results.set(taskId, backgroundWorkerFile.id);
    }
  }

  return results;
}
