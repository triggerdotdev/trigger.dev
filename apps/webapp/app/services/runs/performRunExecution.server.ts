import type { Task } from "@trigger.dev/database";
import {
  ApiEventLogSchema,
  CachedTaskSchema,
  RunJobCanceledWithTask,
  RunJobError,
  RunJobResumeWithTask,
  RunJobRetryWithTask,
  RunJobSuccess,
  RunSourceContextSchema,
} from "@trigger.dev/core";
import { generateErrorMessage } from "zod-error";
import { EXECUTE_JOB_RETRY_LIMIT } from "~/consts";
import {
  $transaction,
  PrismaClient,
  PrismaClientOrTransaction,
  prisma,
} from "~/db.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { safeJsonZodParse } from "~/utils/json";
import { EndpointApi } from "../endpointApi.server";
import { workerQueue } from "../worker.server";
import { formatError } from "~/utils/formatErrors.server";
import { logger } from "../logger.server";

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

    const client = new EndpointApi(
      run.environment.apiKey,
      run.endpoint.url,
      run.endpoint.slug
    );
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
    const { run, isRetry } = execution;

    if (run.status === "CANCELED") {
      await this.#cancelExecution(execution);
      return;
    }

    const client = new EndpointApi(
      run.environment.apiKey,
      run.endpoint.url,
      run.endpoint.slug
    );
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

    if (!connections.success) {
      return this.#failRunExecutionWithRetry(execution, {
        message: `Could not resolve all connections for run ${run.id}, attempting to retry`,
      });
    }

    let resumedTask: Task | undefined;

    if (execution.resumeTaskId) {
      resumedTask =
        (await this.#prismaClient.task.findUnique({
          where: {
            id: execution.resumeTaskId,
          },
        })) ?? undefined;

      if (resumedTask) {
        resumedTask = await this.#prismaClient.task.update({
          where: {
            id: execution.resumeTaskId,
          },
          data: {
            status: resumedTask.noop ? "COMPLETED" : "RUNNING",
            completedAt: resumedTask.noop ? new Date() : undefined,
          },
        });
      }
    }

    const sourceContext = RunSourceContextSchema.safeParse(
      run.event.sourceContext
    );

    const { response, parser, errorParser } = await client.executeJobRequest({
      event,
      job: {
        id: run.version.job.slug,
        version: run.version.version,
      },
      run: {
        id: run.id,
        isTest: run.isTest,
        startedAt,
        isRetry,
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
      connections: connections.auth,
      source: sourceContext.success ? sourceContext.data : undefined,
      tasks: [run.tasks, resumedTask]
        .flat()
        .filter(Boolean)
        .map((t) => CachedTaskSchema.parse(t)),
    });

    if (!response) {
      return await this.#failRunExecutionWithRetry(execution, {
        message: `Connection could not be established to the endpoint (${run.endpoint.url})`,
      });
    }

    const rawBody = await response.text();

    if (!response.ok) {
      logger.debug("Endpoint responded with non-200 status code", {
        status: response.status,
        runId: run.id,
        endpoint: run.endpoint.url,
      });

      const errorBody = safeJsonZodParse(errorParser, rawBody);

      if (errorBody && errorBody.success) {
        // Only retry if the error isn't a 4xx
        if (response.status >= 400 && response.status <= 499) {
          return await this.#failRunExecution(
            this.#prismaClient,
            execution,
            errorBody.data
          );
        } else {
          return await this.#failRunExecutionWithRetry(
            execution,
            errorBody.data
          );
        }
      }

      // Only retry if the error isn't a 4xx
      if (response.status >= 400 && response.status <= 499) {
        return await this.#failRunExecution(this.#prismaClient, execution, {
          message: `Endpoint responded with ${response.status} status code`,
        });
      } else {
        return await this.#failRunExecutionWithRetry(execution, {
          message: `Endpoint responded with ${response.status} status code`,
        });
      }
    }

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

    const status = safeBody.data.status;

    switch (status) {
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
      case "RETRY_WITH_TASK": {
        await this.#retryRunWithTask(execution, safeBody.data);

        break;
      }
      case "CANCELED": {
        await this.#cancelExecution(execution);
        break;
      }
      default: {
        const _exhaustiveCheck: never = status;
        throw new Error(`Non-exhaustive match for value: ${status}`);
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

      // If the task has an operation, then the next performRunExecution will occur
      // when that operation has finished
      if (!data.task.operation) {
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
      }
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

  async #retryRunWithTask(
    execution: FoundRunExecution,
    data: RunJobRetryWithTask
  ) {
    const { run } = execution;

    return await $transaction(this.#prismaClient, async (tx) => {
      // We need to check for an existing task attempt
      const existingAttempt = await tx.taskAttempt.findFirst({
        where: {
          taskId: data.task.id,
          status: "PENDING",
        },
        orderBy: {
          number: "desc",
        },
      });

      if (existingAttempt) {
        await tx.taskAttempt.update({
          where: {
            id: existingAttempt.id,
          },
          data: {
            status: "ERRORED",
            error: formatError(data.error),
          },
        });
      }

      // We need to create a new task attempt
      await tx.taskAttempt.create({
        data: {
          taskId: data.task.id,
          number: existingAttempt ? existingAttempt.number + 1 : 1,
          status: "PENDING",
          runAt: data.retryAt,
        },
      });

      await tx.task.update({
        where: {
          id: data.task.id,
        },
        data: {
          status: "WAITING",
        },
      });

      // Now we need to create a new job execution
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
        { tx, runAt: data.retryAt }
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

  async #cancelExecution(execution: FoundRunExecution) {
    await this.#prismaClient.jobRunExecution.update({
      where: {
        id: execution.id,
      },
      data: {
        status: "FAILURE",
        completedAt: new Date(),
        error: "This never ran because it was canceled by the user.",
      },
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
              integration: true,
              connection: {
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
