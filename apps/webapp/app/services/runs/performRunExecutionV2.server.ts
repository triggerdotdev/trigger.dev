import {
  CachedTask,
  RunJobError,
  RunJobResumeWithTask,
  RunJobRetryWithTask,
  RunJobSuccess,
  RunSourceContextSchema,
} from "@trigger.dev/core";
import { RuntimeEnvironmentType, type Task } from "@trigger.dev/database";
import { generateErrorMessage } from "zod-error";
import { eventRecordToApiJson } from "~/api.server";
import { $transaction, PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { enqueueRunExecutionV2 } from "~/models/jobRunExecution.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { formatError } from "~/utils/formatErrors.server";
import { safeJsonZodParse } from "~/utils/json";
import { EndpointApi } from "../endpointApi.server";
import { logger } from "../logger.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type FoundTask = FoundRun["tasks"][number];

export type PerformRunExecutionV2Input = {
  id: string;
  reason: "PREPROCESS" | "EXECUTE_JOB";
  isRetry: boolean;
  resumeTaskId?: string;
};

export class PerformRunExecutionV2Service {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: PerformRunExecutionV2Input) {
    const run = await findRun(this.#prismaClient, input.id);

    if (!run) {
      return;
    }

    switch (input.reason) {
      case "PREPROCESS": {
        await this.#executePreprocessing(run);
        break;
      }
      case "EXECUTE_JOB": {
        await this.#executeJob(run, input);
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
    const event = eventRecordToApiJson(run.event);

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
      return await this.#failRunExecution(this.#prismaClient, "PREPROCESS", run, {
        message: "Could not connect to the endpoint",
      });
    }

    if (!response.ok) {
      return await this.#failRunExecution(this.#prismaClient, "PREPROCESS", run, {
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

        await enqueueRunExecutionV2(run, tx, {
          skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        });
      });
    }
  }
  async #executeJob(run: FoundRun, input: PerformRunExecutionV2Input) {
    const { isRetry, resumeTaskId } = input;

    if (run.status === "CANCELED") {
      await this.#cancelExecution(run);
      return;
    }

    const client = new EndpointApi(run.environment.apiKey, run.endpoint.url);
    const event = eventRecordToApiJson(run.event);

    const startedAt = new Date();

    const { executionCount } = await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: run.status === "QUEUED" ? "STARTED" : run.status,
        startedAt: run.startedAt ?? new Date(),
        executionCount: {
          increment: 1,
        },
      },
      select: {
        executionCount: true,
      },
    });

    const connections = await resolveRunConnections(run.runConnections);

    if (!connections.success) {
      return this.#failRunExecution(this.#prismaClient, "EXECUTE_JOB", run, {
        message: `Could not resolve all connections for run ${run.id}. This should not happen`,
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

    const { response, parser, errorParser, durationInMs } = await client.executeJobRequest({
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
      tasks: prepareTasksForRun([run.tasks, resumedTask].flat().filter(Boolean)),
    });

    if (!response) {
      return await this.#failRunExecutionWithRetry({
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
          return await this.#failRunExecutionWithRetry(errorBody.data);
        }
      }

      // Only retry if the error isn't a 4xx
      if (response.status >= 400 && response.status <= 499 && response.status !== 408) {
        return await this.#failRunExecution(
          this.#prismaClient,
          "EXECUTE_JOB",
          run,
          {
            message: `Endpoint responded with ${response.status} status code`,
          },
          "FAILURE",
          durationInMs
        );
      } else {
        // If the error is a 504 timeout, we should mark this execution as succeeded (by not throwing an error) and enqueue a new execution
        if (response.status === 504) {
          return await this.#resumeRunExecutionAfterTimeout(
            this.#prismaClient,
            run,
            input,
            durationInMs,
            executionCount
          );
        } else {
          return await this.#failRunExecutionWithRetry({
            message: `Endpoint responded with ${response.status} status code`,
          });
        }
      }
    }

    const safeBody = safeJsonZodParse(parser, rawBody);

    if (!safeBody) {
      return await this.#failRunExecution(
        this.#prismaClient,
        "EXECUTE_JOB",
        run,
        {
          message: "Endpoint responded with invalid JSON",
        },
        "FAILURE",
        durationInMs
      );
    }

    if (!safeBody.success) {
      return await this.#failRunExecution(
        this.#prismaClient,
        "EXECUTE_JOB",
        run,
        {
          message: generateErrorMessage(safeBody.error.issues),
        },
        "FAILURE",
        durationInMs
      );
    }

    const status = safeBody.data.status;

    switch (status) {
      case "SUCCESS": {
        await this.#completeRunWithSuccess(run, safeBody.data, durationInMs);

        break;
      }
      case "RESUME_WITH_TASK": {
        await this.#resumeRunWithTask(run, safeBody.data, isRetry, durationInMs, executionCount);

        break;
      }
      case "ERROR": {
        await this.#failRunWithError(run, safeBody.data, durationInMs);

        break;
      }
      case "RETRY_WITH_TASK": {
        await this.#retryRunWithTask(run, safeBody.data, isRetry, durationInMs, executionCount);

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

  async #completeRunWithSuccess(run: FoundRun, data: RunJobSuccess, durationInMs: number) {
    await this.#prismaClient.jobRun.update({
      where: { id: run.id },
      data: {
        completedAt: new Date(),
        status: "SUCCESS",
        output: data.output ?? undefined,
        executionDuration: {
          increment: durationInMs,
        },
      },
    });
  }

  async #resumeRunWithTask(
    run: FoundRun,
    data: RunJobResumeWithTask,
    isRetry: boolean,
    durationInMs: number,
    executionCount: number
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
        },
      });

      // If the task has an operation, then the next performRunExecution will occur
      // when that operation has finished
      if (!data.task.operation) {
        await enqueueRunExecutionV2(run, tx, {
          runAt: data.task.delayUntil ?? undefined,
          resumeTaskId: data.task.id,
          isRetry,
          skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
          executionCount,
        });
      }
    });
  }

  async #failRunWithError(execution: FoundRun, data: RunJobError, durationInMs: number) {
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

      await this.#failRunExecution(
        tx,
        "EXECUTE_JOB",
        execution,
        data.error ?? undefined,
        "FAILURE",
        durationInMs
      );
    });
  }

  async #retryRunWithTask(
    run: FoundRun,
    data: RunJobRetryWithTask,
    isRetry: boolean,
    durationInMs: number,
    executionCount: number
  ) {
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
          run: {
            update: {
              executionDuration: {
                increment: durationInMs,
              },
            },
          },
        },
      });

      await enqueueRunExecutionV2(run, tx, {
        runAt: data.retryAt,
        resumeTaskId: data.task.id,
        isRetry,
        skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        executionCount,
      });
    });
  }

  async #resumeRunExecutionAfterTimeout(
    prisma: PrismaClientOrTransaction,
    run: FoundRun,
    input: PerformRunExecutionV2Input,
    durationInMs: number,
    executionCount: number
  ) {
    await $transaction(prisma, async (tx) => {
      const executionDuration = run.executionDuration + durationInMs;

      // If the execution duration is greater than the maximum execution time, we need to fail the run
      if (executionDuration >= run.organization.maximumExecutionTimePerRunInMs) {
        await this.#failRunExecution(
          tx,
          "EXECUTE_JOB",
          run,
          {
            message: `Execution timed out after ${
              run.organization.maximumExecutionTimePerRunInMs / 1000
            } seconds`,
          },
          "TIMED_OUT",
          durationInMs
        );
        return;
      }

      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
        },
      });

      // The run has timed out, so we need to enqueue a new execution
      await enqueueRunExecutionV2(run, tx, {
        resumeTaskId: input.resumeTaskId,
        isRetry: input.isRetry,
        skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        executionCount,
      });
    });
  }

  async #failRunExecutionWithRetry(output: Record<string, any>): Promise<void> {
    throw new Error(JSON.stringify(output));
  }

  async #failRunExecution(
    prisma: PrismaClientOrTransaction,
    reason: "EXECUTE_JOB" | "PREPROCESS",
    run: FoundRun,
    output: Record<string, any>,
    status: "FAILURE" | "ABORTED" | "TIMED_OUT" = "FAILURE",
    durationInMs: number = 0
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
              executionDuration: {
                increment: durationInMs,
              },
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

          await enqueueRunExecutionV2(run, tx, {
            skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
          });

          break;
        }
      }
    });
  }

  async #cancelExecution(run: FoundRun) {
    return;
  }
}

function prepareTasksForRun(possibleTasks: FoundTask[]): CachedTask[] {
  const tasks = possibleTasks.filter((task) => task.status === "COMPLETED");

  // We need to limit the cached tasks to not be too large >3.5MB when serialized
  const TOTAL_CACHED_TASK_BYTE_LIMIT = 3500000;

  const cachedTasks = new Map<string, CachedTask>(); // Cache for prepared tasks
  const cachedTaskSizes = new Map<string, number>(); // Cache for calculated task sizes

  // Helper function to get the cached prepared task, or prepare and cache if not already cached
  function getCachedTask(task: FoundTask): CachedTask {
    const taskId = task.id;
    if (!cachedTasks.has(taskId)) {
      cachedTasks.set(taskId, prepareTaskForRun(task));
    }
    return cachedTasks.get(taskId)!;
  }

  // Helper function to get the cached task size, or calculate and cache if not already cached
  function getCachedTaskSize(task: CachedTask): number {
    const taskId = task.id;
    if (!cachedTaskSizes.has(taskId)) {
      cachedTaskSizes.set(taskId, calculateCachedTaskSize(task));
    }
    return cachedTaskSizes.get(taskId)!;
  }

  // Prepare tasks and calculate their sizes
  const availableTasks = tasks.map((task) => {
    const cachedTask = getCachedTask(task);
    return { task: cachedTask, size: getCachedTaskSize(cachedTask) };
  });

  // Sort tasks in ascending order by size
  availableTasks.sort((a, b) => a.size - b.size);

  // Select tasks using greedy approach
  const tasksToRun: CachedTask[] = [];
  let remainingSize = TOTAL_CACHED_TASK_BYTE_LIMIT;

  for (const { task, size } of availableTasks) {
    if (size <= remainingSize) {
      tasksToRun.push(task);
      remainingSize -= size;
    }
  }

  return tasksToRun;
}

function prepareTaskForRun(task: FoundTask): CachedTask {
  return {
    id: task.idempotencyKey, // We should eventually move this back to task.id
    status: task.status,
    idempotencyKey: task.idempotencyKey,
    noop: task.noop,
    output: task.output as any,
    parentId: task.parentId,
  };
}

function calculateCachedTaskSize(task: CachedTask): number {
  return JSON.stringify(task).length;
}

async function findRun(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRun.findUnique({
    where: { id },
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
        select: {
          id: true,
          idempotencyKey: true,
          status: true,
          noop: true,
          output: true,
          parentId: true,
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
