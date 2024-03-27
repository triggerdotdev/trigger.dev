import { CreateBackgroundWorkerRequestBody, TaskResource } from "@trigger.dev/core/v3";
import type { BackgroundWorker } from "@trigger.dev/database";
import { Prisma, PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { BaseService } from "./baseService.server";
import { projectPubSub } from "./projectPubSub.server";

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
        },
      });

      await createBackgroundTasks(body.metadata.tasks, backgroundWorker, environment, this._prisma);

      //send a notification that a new worker has been created
      await projectPubSub.publish(`project:${project.id}:env:${environment.id}`, "WORKER_CREATED", {
        environmentId: environment.id,
        environmentType: environment.type,
        createdAt: backgroundWorker.createdAt,
        taskCount: body.metadata.tasks.length,
        type: "local",
      });

      return backgroundWorker;
    });
  }
}

export async function createBackgroundTasks(
  tasks: TaskResource[],
  worker: BackgroundWorker,
  env: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
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
        },
      });

      const queueName = task.queue?.name ?? `task/${task.id}`;

      const taskQueue = await prisma.taskQueue.upsert({
        where: {
          runtimeEnvironmentId_name: {
            runtimeEnvironmentId: worker.runtimeEnvironmentId,
            name: queueName,
          },
        },
        update: {
          concurrencyLimit: task.queue?.concurrencyLimit,
          rateLimit: task.queue?.rateLimit,
        },
        create: {
          friendlyId: generateFriendlyId("queue"),
          name: queueName,
          concurrencyLimit: task.queue?.concurrencyLimit,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
          projectId: worker.projectId,
          rateLimit: task.queue?.rateLimit,
          type: task.queue?.name ? "NAMED" : "VIRTUAL",
        },
      });

      if (taskQueue.concurrencyLimit) {
        await marqs?.updateQueueConcurrency(env, taskQueue.name, taskQueue.concurrencyLimit);
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
