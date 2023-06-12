import {
  ApiEventLogSchema,
  CachedTaskSchema,
  RunJobError,
  RunJobResumeWithTask,
  RunJobSuccess,
} from "@trigger.dev/internal";
import { generateErrorMessage } from "zod-error";
import {
  $transaction,
  PrismaClient,
  PrismaClientOrTransaction,
  prisma,
} from "~/db.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { safeJsonZodParse } from "~/utils/json";
import { EndpointApi } from "../endpointApi";
import { workerQueue } from "../worker.server";
import type { Task } from ".prisma/client";
import { EXECUTE_JOB_RETRY_LIMIT } from "~/consts";

type FoundRunExecution = NonNullable<
  Awaited<ReturnType<typeof findRunExecution>>
>;

export class PerformRunExecutionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const runExecution = await findRunExecution(this.#prismaClient, id);

    if (!runExecution) {
      return;
    }

    switch (runExecution.reason) {
      case "PREPROCESS": {
        await this.#executePreprocessing(runExecution);
        break;
      }
      case "EXECUTE_JOB": {
        await this.#executeJob(runExecution);
        break;
      }
    }
  }

  // Execute the preprocessing step of a run, which will send the payload to the endpoint and give the job
  // an opportunity to generate run properties based on the payload.
  // If the endpoint is not available, or the response is not ok,
  // the run execution will be marked as failed and the run will start
  async #executePreprocessing(execution: FoundRunExecution) {
    const { run } = execution;

    const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
    const event = ApiEventLogSchema.parse({ ...run.event, id: run.eventId });
    const startedAt = new Date();

    await this.#prismaClient.jobRunExecution.update({
      where: {
        id: execution.id,
      },
      data: {
        status: "STARTED",
        startedAt,
      },
    });

    const { response, parser } = await client.preprocessRunRequest({
      event,
      job: {
        id: run.version.job.slug,
        version: run.version.version,
      },
      run: {
        id: run.id,
        isTest: run.isTest,
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
      account: run.externalAccount
        ? {
            id: run.externalAccount.identifier,
            metadata: run.externalAccount.metadata,
          }
        : undefined,
    });

    if (!response) {
      return await this.#failRunExecutionWithRetry(execution, {
        message: "Could not connect to the endpoint",
      });
    }

    if (!response.ok) {
      return await this.#failRunExecutionWithRetry(execution, {
        message: `Endpoint responded with ${response.status} status code`,
      });
    }

    const rawBody = await response.text();
    const safeBody = safeJsonZodParse(parser, rawBody);

    if (!safeBody) {
      return await this.#failRunExecution(this.#prismaClient, execution, {
        message: "Endpoint responded with invalid JSON",
      });
    }

    if (!safeBody.success) {
      return await this.#failRunExecution(this.#prismaClient, execution, {
        message: generateErrorMessage(safeBody.error.issues),
      });
    }

    if (safeBody.data.abort) {
      return this.#failRunExecution(
        this.#prismaClient,
        execution,
        { message: "Endpoint aborted the run" },
        "ABORTED"
      );
    } else {
      await $transaction(this.#prismaClient, async (tx) => {
        await tx.jobRun.update({
          where: {
            id: run.id,
          },
          data: {
            status: "STARTED",
            startedAt: new Date(),
            properties: safeBody.data.properties,
          },
        });

        await tx.jobRunExecution.update({
          where: {
            id: execution.id,
          },
          data: {
            status: "SUCCESS",
            completedAt: new Date(),
          },
        });

        const runExecution = await tx.jobRunExecution.create({
          data: {
            runId: run.id,
            reason: "EXECUTE_JOB",
            status: "PENDING",
            retryLimit: EXECUTE_JOB_RETRY_LIMIT,
          },
        });

        const job = await workerQueue.enqueue(
          "performRunExecution",
          {
            id: runExecution.id,
          },
          { tx }
        );

        await tx.jobRunExecution.update({
          where: {
            id: runExecution.id,
          },
          data: {
            graphileJobId: job.id,
          },
        });
      });
    }
  }
  async #executeJob(execution: FoundRunExecution) {
    const { run } = execution;

    const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
    const event = ApiEventLogSchema.parse({ ...run.event, id: run.eventId });

    const startedAt = new Date();

    await this.#prismaClient.jobRunExecution.update({
      where: {
        id: execution.id,
      },
      data: {
        status: "STARTED",
        startedAt,
      },
    });

    const connections = await resolveRunConnections(run.runConnections);

    if (Object.keys(connections).length < run.runConnections.length) {
      return this.#failRunExecutionWithRetry(execution, {
        message: `Could not resolve all connections for run ${
          run.id
        }, there should be ${run.runConnections.length} connections but only ${
          Object.keys(connections).length
        } were resolved.`,
      });
    }

    let resumedTask: Task | undefined;

    if (execution.resumeTaskId) {
      resumedTask = await this.#prismaClient.task.update({
        where: {
          id: execution.resumeTaskId,
        },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
    }

    const { response, parser } = await client.executeJobRequest({
      event,
      job: {
        id: run.version.job.slug,
        version: run.version.version,
      },
      run: {
        id: run.id,
        isTest: run.isTest,
        startedAt,
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
      account: run.externalAccount
        ? {
            id: run.externalAccount.identifier,
            metadata: run.externalAccount.metadata,
          }
        : undefined,
      connections,
      tasks: [run.tasks, resumedTask]
        .flat()
        .filter(Boolean)
        .map((t) => CachedTaskSchema.parse(t)),
    });

    if (!response) {
      return await this.#failRunExecutionWithRetry(execution, {
        message: "Could not connect to the endpoint",
      });
    }

    // TODO: handle timeouts
    if (!response.ok) {
      return await this.#failRunExecutionWithRetry(execution, {
        message: `Endpoint responded with ${response.status} status code`,
      });
    }

    const rawBody = await response.text();
    const safeBody = safeJsonZodParse(parser, rawBody);

    if (!safeBody) {
      return await this.#failRunExecution(this.#prismaClient, execution, {
        message: "Endpoint responded with invalid JSON",
      });
    }

    if (!safeBody.success) {
      return await this.#failRunExecution(this.#prismaClient, execution, {
        message: generateErrorMessage(safeBody.error.issues),
      });
    }

    switch (safeBody.data.status) {
      case "SUCCESS": {
        await this.#completeRunWithSuccess(execution, safeBody.data);

        break;
      }
      case "RESUME_WITH_TASK": {
        await this.#resumeRunWithTask(execution, safeBody.data);

        break;
      }
      case "ERROR": {
        await this.#failRunWithError(execution, safeBody.data);

        break;
      }
    }
  }

  async #completeRunWithSuccess(
    execution: FoundRunExecution,
    data: RunJobSuccess
  ) {
    const { run } = execution;

    return await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          completedAt: new Date(),
          status: "SUCCESS",
          output: data.output ?? undefined,
          queue: {
            update: {
              jobCount: {
                decrement: 1,
              },
            },
          },
        },
      });

      await tx.jobRunExecution.update({
        where: {
          id: execution.id,
        },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
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

  async #resumeRunWithTask(
    execution: FoundRunExecution,
    data: RunJobResumeWithTask
  ) {
    const { run } = execution;

    return await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRunExecution.update({
        where: {
          id: execution.id,
        },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
        },
      });

      const newJobExecution = await tx.jobRunExecution.create({
        data: {
          runId: run.id,
          reason: "EXECUTE_JOB",
          status: "PENDING",
          retryLimit: EXECUTE_JOB_RETRY_LIMIT,
          resumeTaskId: data.task.id,
        },
      });

      const graphileJob = await workerQueue.enqueue(
        "performRunExecution",
        {
          id: newJobExecution.id,
        },
        { tx, runAt: data.task.delayUntil ?? undefined }
      );

      await tx.jobRunExecution.update({
        where: {
          id: newJobExecution.id,
        },
        data: {
          graphileJobId: graphileJob.id,
        },
      });
    });
  }

  async #failRunWithError(execution: FoundRunExecution, data: RunJobError) {
    return await $transaction(this.#prismaClient, async (tx) => {
      if (data.task) {
        await tx.task.update({
          where: {
            id: data.task.id,
          },
          data: {
            status: "ERRORED",
            completedAt: new Date(),
            output: data.error ?? undefined,
          },
        });
      }

      await this.#failRunExecution(tx, execution, data.error ?? undefined);
    });
  }

  async #failRunExecutionWithRetry(
    execution: FoundRunExecution,
    output: Record<string, any>
  ): Promise<void> {
    await $transaction(this.#prismaClient, async (tx) => {
      if (execution.retryCount + 1 > execution.retryLimit) {
        // We've reached the retry limit, so we need to fail the execution and stop retrying
        return await this.#failRunExecution(tx, execution, output);
      }

      // We need to retry execution
      const retryCount = execution.retryCount + 1;
      // Use an exponential backoff strategy with the exponent being 1.5
      // So when retryCount is 1, retryDelayInMs is 500ms
      // When retryCount is 2, retryDelayInMs is 750ms
      // When retryCount is 3, retryDelayInMs is 1125ms
      const retryDelayInMs = Math.round(500 * Math.pow(1.5, retryCount - 1));

      await tx.jobRunExecution.update({
        where: {
          id: execution.id,
        },
        data: {
          retryCount,
          retryDelayInMs,
          error: JSON.stringify(output),
        },
      });

      const runAt = new Date(Date.now() + retryDelayInMs);

      const job = await workerQueue.enqueue(
        "performRunExecution",
        { id: execution.id },
        { runAt, tx }
      );

      await tx.jobRunExecution.update({
        where: {
          id: execution.id,
        },
        data: {
          graphileJobId: job.id,
        },
      });
    });
  }

  async #failRunExecution(
    prisma: PrismaClientOrTransaction,
    execution: FoundRunExecution,
    output: Record<string, any>,
    status: "FAILURE" | "ABORTED" = "FAILURE"
  ): Promise<void> {
    const { run } = execution;

    await $transaction(prisma, async (tx) => {
      switch (execution.reason) {
        case "EXECUTE_JOB": {
          // If the execution is an EXECUTE_JOB reason, we need to fail the run
          await tx.jobRun.update({
            where: { id: run.id },
            data: {
              completedAt: new Date(),
              status,
              output,
              queue: {
                update: {
                  jobCount: {
                    decrement: 1,
                  },
                },
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
          break;
        }
        case "PREPROCESS": {
          // If the status is ABORTED, we need to fail the run
          if (status === "ABORTED") {
            await tx.jobRun.update({
              where: { id: run.id },
              data: {
                completedAt: new Date(),
                status,
                output,
                queue: {
                  update: {
                    jobCount: {
                      decrement: 1,
                    },
                  },
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

            break;
          }

          await tx.jobRun.update({
            where: {
              id: run.id,
            },
            data: {
              status: "STARTED",
              startedAt: new Date(),
            },
          });

          const runExecution = await tx.jobRunExecution.create({
            data: {
              runId: run.id,
              reason: "EXECUTE_JOB",
              status: "PENDING",
              retryLimit: EXECUTE_JOB_RETRY_LIMIT,
            },
          });

          const job = await workerQueue.enqueue(
            "performRunExecution",
            {
              id: runExecution.id,
            },
            { tx }
          );

          await tx.jobRunExecution.update({
            where: {
              id: runExecution.id,
            },
            data: {
              graphileJobId: job.id,
            },
          });

          break;
        }
      }

      await tx.jobRunExecution.update({
        where: {
          id: execution.id,
        },
        data: {
          status: "FAILURE",
          completedAt: new Date(),
          error: JSON.stringify(output),
        },
      });
    });
  }
}

async function findRunExecution(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRunExecution.findUnique({
    where: { id },
    include: {
      run: {
        include: {
          environment: true,
          endpoint: true,
          organization: true,
          externalAccount: true,
          runConnections: {
            include: {
              apiConnection: {
                include: {
                  dataReference: true,
                },
              },
            },
          },
          tasks: {
            where: {
              status: {
                in: ["COMPLETED"],
              },
            },
          },
          event: true,
          version: {
            include: {
              job: true,
              organization: true,
            },
          },
        },
      },
    },
  });
}
