import { ApiEventLogSchema, CachedTaskSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { resolveRunConnections } from "~/models/runConnection.server";

export class ResumeTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, output?: any) {
    const task = await this.#prismaClient.task.findUniqueOrThrow({
      where: { id },
      include: {
        run: {
          include: {
            version: {
              include: {
                endpoint: true,
                job: true,
              },
            },
            environment: true,
            event: true,
            organization: true,
            tasks: {
              where: {
                status: {
                  in: ["COMPLETED"],
                },
              },
            },
            queue: true,
            runConnections: {
              include: {
                apiConnection: {
                  include: {
                    dataReference: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const { run } = task;

    const connections = await resolveRunConnections(run.runConnections);

    if (Object.keys(connections).length < run.runConnections.length) {
      throw new Error(
        `Could not resolve all connections for run ${run.id} and task ${
          task.id
        }, there should be ${run.runConnections.length} connections but only ${
          Object.keys(connections).length
        } were resolved.`
      );
    }

    const updatedTask = await this.#prismaClient.task.update({
      where: {
        id: task.id,
      },
      data: {
        status: task.noop || output ? "COMPLETED" : "RUNNING",
        completedAt: task.noop ? new Date() : undefined,
        output: task.noop ? undefined : output,
      },
    });

    const client = new ClientApi(
      run.environment.apiKey,
      run.version.endpoint.url
    );

    const event = ApiEventLogSchema.parse({ ...run.event, id: run.eventId });

    try {
      const results = await client.executeJob({
        event,
        job: {
          id: run.version.job.slug,
          version: run.version.version,
        },
        run: {
          id: run.id,
          isTest: run.isTest,
          startedAt: run.startedAt ?? new Date(),
        },
        environment: {
          id: run.environment.id,
          slug: run.environment.slug,
          type: run.environment.type,
        },
        organization: {
          id: run.organization.id,
          slug: run.organization.slug,
          title: run.organization.title,
        },
        tasks: [run.tasks, updatedTask]
          .flat()
          .map((t) => CachedTaskSchema.parse(t)),
        connections,
      });

      if (results.completed) {
        await this.#prismaClient.$transaction(async (tx) => {
          await tx.jobRun.update({
            where: { id: run.id },
            data: {
              completedAt: new Date(),
              status: "SUCCESS",
              output: results.output ?? undefined,
              queue: {
                update: {
                  jobCount: {
                    decrement: 1,
                  },
                },
              },
            },
          });

          await tx.jobQueue.update({
            where: { id: run.queueId },
            data: {
              jobCount: {
                decrement: 1,
              },
            },
          });

          await workerQueue.enqueue(
            "runFinished",
            {
              id: run.id,
            },
            { tx }
          );
        });

        return;
      }

      if (results.task) {
        await workerQueue.enqueue(
          "resumeTask",
          {
            id: results.task.id,
          },
          { runAt: results.task.delayUntil ?? undefined }
        );

        return;
      }
    } catch (error) {
      await this.#prismaClient.$transaction(async (tx) => {
        if (error instanceof ClientApiError) {
          await tx.jobRun.update({
            where: { id: run.id },
            data: {
              completedAt: new Date(),
              status: "FAILURE",
              output: { message: error.message, stack: error.stack },
            },
          });
        } else {
          await tx.jobRun.update({
            where: { id: run.id },
            data: {
              completedAt: new Date(),
              status: "FAILURE",
              output: {
                message:
                  error instanceof Error ? error.message : "Unknown Error",
                stack: error instanceof Error ? error.stack : undefined,
              },
            },
          });
        }

        await tx.jobQueue.update({
          where: { id: run.queueId },
          data: {
            jobCount: {
              decrement: 1,
            },
          },
        });

        await workerQueue.enqueue(
          "runFinished",
          {
            id: run.id,
          },
          { tx }
        );
      });
    }
  }
}
