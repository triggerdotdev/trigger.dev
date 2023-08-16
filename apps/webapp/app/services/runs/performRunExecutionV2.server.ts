import {
  ApiEventLogSchema,
  CachedTaskSchema,
  RunJobError,
  RunJobResumeWithTask,
  RunJobRetryWithTask,
  RunJobSuccess,
  RunSourceContextSchema,
} from "@trigger.dev/core";
import type { Task } from "@trigger.dev/database";
import { generateErrorMessage } from "zod-error";
import { $transaction, PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { enqueueRunExecutionV2 } from "~/models/jobRunExecution.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { formatError } from "~/utils/formatErrors.server";
import { safeJsonZodParse } from "~/utils/json";
import { EndpointApi } from "../endpointApi.server";
import { logger } from "../logger.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;

// Run starts in PENDING status in CreateRunService which is called from InvokeDispatcherService
// CreateRunService enqueues a job to StartRunService
// StartRunService checks to see if all the connections are ready
// If they are, it starts the run (setting the status to QUEUED)
// StartRunService creates a JobRunExecution and enqueues a performJobExecution job
// The performJobExecution job is added to a JobQueue, with a suffix to control the concurrency (job:queue:<queueId>:<concurrency>)
// The performJobExecution job is picked up by a worker
// PerformRunExecutionService will update the run status to STARTED

export class PerformRunExecutionV2Service {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    id: string,
    reason: "PREPROCESS" | "EXECUTE_JOB",
    isRetry: boolean = false,
    resumeTaskId?: string
  ) {
    const run = await findRun(this.#prismaClient, id);

    if (!run) {
      return;
    }

    switch (reason) {
      case "PREPROCESS": {
        await this.#executePreprocessing(run);
        break;
      }
      case "EXECUTE_JOB": {
        await this.#executeJob(run, isRetry, resumeTaskId);
        break;
      }
    }
  }

  // Execute the preprocessing step of a run, which will send the payload to the endpoint and give the job
  // an opportunity to generate run properties based on the payload.
  // If the endpoint is not available, or the response is not ok,
  // the run execution will be marked as failed and the run will start
  async #executePreprocessing(run: FoundRun) {
    const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
    const event = ApiEventLogSchema.parse({ ...run.event, id: run.eventId });

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
      return await this.#failRunExecutionWithRetry("PREPROCESS", run, {
        message: "Could not connect to the endpoint",
      });
    }

    if (!response.ok) {
      return await this.#failRunExecutionWithRetry("PREPROCESS", run, {
        message: `Endpoint responded with ${response.status} status code`,
      });
    }

    const rawBody = await response.text();
    const safeBody = safeJsonZodParse(parser, rawBody);

    if (!safeBody) {
      return await this.#failRunExecution(this.#prismaClient, "PREPROCESS", run, {
        message: "Endpoint responded with invalid JSON",
      });
    }

    if (!safeBody.success) {
      return await this.#failRunExecution(this.#prismaClient, "PREPROCESS", run, {
        message: generateErrorMessage(safeBody.error.issues),
      });
    }

    if (safeBody.data.abort) {
      return this.#failRunExecution(
        this.#prismaClient,
        "PREPROCESS",
        run,
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

        await enqueueRunExecutionV2(run, run.queue.id, run.queue.maxJobs, tx);
      });
    }
  }
  async #executeJob(run: FoundRun, isRetry: boolean, resumeTaskId?: string) {
    if (run.status === "CANCELED") {
      await this.#cancelExecution(run);
      return;
    }

    const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
    const event = ApiEventLogSchema.parse({ ...run.event, id: run.eventId });

    const startedAt = new Date();

    await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: run.status === "QUEUED" ? "STARTED" : run.status,
        startedAt: run.startedAt ?? new Date(),
      },
    });

    const connections = await resolveRunConnections(run.runConnections);

    if (!connections.success) {
      return this.#failRunExecutionWithRetry("EXECUTE_JOB", run, {
        message: `Could not resolve all connections for run ${run.id}, attempting to retry`,
      });
    }

    let resumedTask: Task | undefined;

    if (resumeTaskId) {
      resumedTask =
        (await this.#prismaClient.task.findUnique({
          where: {
            id: resumeTaskId,
          },
        })) ?? undefined;

      if (resumedTask) {
        resumedTask = await this.#prismaClient.task.update({
          where: {
            id: resumeTaskId,
          },
          data: {
            status: resumedTask.noop ? "COMPLETED" : "RUNNING",
            completedAt: resumedTask.noop ? new Date() : undefined,
          },
        });
      }
    }

    const sourceContext = RunSourceContextSchema.safeParse(run.event.sourceContext);

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
      return await this.#failRunExecutionWithRetry("EXECUTE_JOB", run, {
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
            "EXECUTE_JOB",
            run,
            errorBody.data
          );
        } else {
          return await this.#failRunExecutionWithRetry("EXECUTE_JOB", run, errorBody.data);
        }
      }

      // Only retry if the error isn't a 4xx
      if (response.status >= 400 && response.status <= 499 && response.status !== 408) {
        return await this.#failRunExecution(this.#prismaClient, "EXECUTE_JOB", run, {
          message: `Endpoint responded with ${response.status} status code`,
        });
      } else {
        return await this.#failRunExecutionWithRetry("EXECUTE_JOB", run, {
          message: `Endpoint responded with ${response.status} status code`,
        });
      }
    }

    const safeBody = safeJsonZodParse(parser, rawBody);

    if (!safeBody) {
      return await this.#failRunExecution(this.#prismaClient, "EXECUTE_JOB", run, {
        message: "Endpoint responded with invalid JSON",
      });
    }

    if (!safeBody.success) {
      return await this.#failRunExecution(this.#prismaClient, "EXECUTE_JOB", run, {
        message: generateErrorMessage(safeBody.error.issues),
      });
    }

    const status = safeBody.data.status;

    switch (status) {
      case "SUCCESS": {
        await this.#completeRunWithSuccess(run, safeBody.data);

        break;
      }
      case "RESUME_WITH_TASK": {
        await this.#resumeRunWithTask(run, safeBody.data, isRetry);

        break;
      }
      case "ERROR": {
        await this.#failRunWithError(run, safeBody.data);

        break;
      }
      case "RETRY_WITH_TASK": {
        await this.#retryRunWithTask(run, safeBody.data, isRetry);

        break;
      }
      case "CANCELED": {
        await this.#cancelExecution(run);
        break;
      }
      default: {
        const _exhaustiveCheck: never = status;
        throw new Error(`Non-exhaustive match for value: ${status}`);
      }
    }
  }

  async #completeRunWithSuccess(run: FoundRun, data: RunJobSuccess) {
    await this.#prismaClient.jobRun.update({
      where: { id: run.id },
      data: {
        completedAt: new Date(),
        status: "SUCCESS",
        output: data.output ?? undefined,
      },
    });
  }

  async #resumeRunWithTask(run: FoundRun, data: RunJobResumeWithTask, isRetry: boolean) {
    return await $transaction(this.#prismaClient, async (tx) => {
      // If the task has an operation, then the next performRunExecution will occur
      // when that operation has finished
      if (!data.task.operation) {
        await enqueueRunExecutionV2(run, run.queue.id, run.queue.maxJobs, tx, {
          runAt: data.task.delayUntil ?? undefined,
          resumeTaskId: data.task.id,
          isRetry,
        });
      }
    });
  }

  async #failRunWithError(execution: FoundRun, data: RunJobError) {
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

      await this.#failRunExecution(tx, "EXECUTE_JOB", execution, data.error ?? undefined);
    });
  }

  async #retryRunWithTask(run: FoundRun, data: RunJobRetryWithTask, isRetry: boolean) {
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

      await enqueueRunExecutionV2(run, run.queue.id, run.queue.maxJobs, tx, {
        runAt: data.retryAt,
        resumeTaskId: data.task.id,
        isRetry,
      });
    });
  }

  async #failRunExecutionWithRetry(
    reason: "PREPROCESS" | "EXECUTE_JOB",
    run: FoundRun,
    output: Record<string, any>
  ): Promise<void> {
    await this.#failRunExecution(this.#prismaClient, reason, run, output);

    throw new Error(JSON.stringify(output));
  }

  async #failRunExecution(
    prisma: PrismaClientOrTransaction,
    reason: "EXECUTE_JOB" | "PREPROCESS",
    run: FoundRun,
    output: Record<string, any>,
    status: "FAILURE" | "ABORTED" = "FAILURE"
  ): Promise<void> {
    await $transaction(prisma, async (tx) => {
      switch (reason) {
        case "EXECUTE_JOB": {
          // If the execution is an EXECUTE_JOB reason, we need to fail the run
          await tx.jobRun.update({
            where: { id: run.id },
            data: {
              completedAt: new Date(),
              status,
              output,
            },
          });

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
              },
            });

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

          await enqueueRunExecutionV2(run, run.queue.id, run.queue.maxJobs, tx);

          break;
        }
      }
    });
  }

  async #cancelExecution(run: FoundRun) {
    return;
  }
}

async function findRun(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRun.findUnique({
    where: { id },
    include: {
      environment: true,
      endpoint: true,
      organization: true,
      externalAccount: true,
      queue: true,
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
  });
}
