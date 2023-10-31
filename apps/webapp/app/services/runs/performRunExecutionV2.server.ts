import {
  API_VERSIONS,
  BloomFilter,
  ConnectionAuth,
  EndpointHeadersSchema,
  RunJobAutoYieldWithCompletedTaskExecutionError,
  RunJobError,
  RunJobInvalidPayloadError,
  RunJobResumeWithTask,
  RunJobRetryWithTask,
  RunJobSuccess,
  RunJobUnresolvedAuthError,
  RunSourceContext,
  RunSourceContextSchema,
  supportsFeature,
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
import { prepareTasksForCaching, prepareTasksForCachingLegacy } from "~/models/task.server";
import {
  MAX_RUN_CHUNK_EXECUTION_LIMIT,
  MAX_RUN_YIELDED_EXECUTIONS,
  RESPONSE_TIMEOUT_STATUS_CODES,
  RUN_CHUNK_EXECUTION_BUFFER,
} from "~/consts";
import { ApiEventLog } from "@trigger.dev/core";
import { RunJobBody } from "@trigger.dev/core";
import { CompleteRunTaskService } from "~/routes/api.v1.runs.$runId.tasks.$id.complete";
import { detectResponseIsTimeout } from "~/models/endpoint.server";
import { forceYieldCoordinator } from "./forceYieldCoordinator.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type FoundTask = FoundRun["tasks"][number];

// We need to limit the cached tasks to not be too large >3.5MB when serialized
const TOTAL_CACHED_TASK_BYTE_LIMIT = 3500000;

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
            forceYieldImmediately: false,
          },
        });

        await enqueueRunExecutionV2(run, tx, {
          skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        });
      });
    }
  }
  async #executeJob(run: FoundRun, input: PerformRunExecutionV2Input) {
    try {
      const { isRetry, resumeTaskId } = input;

      if (run.status === "CANCELED") {
        await this.#cancelExecution(run);
        return;
      }

      try {
        if (
          typeof process.env.BLOCKED_ORGS === "string" &&
          process.env.BLOCKED_ORGS.includes(run.organizationId)
        ) {
          logger.debug("Skipping execution for blocked org", {
            orgId: run.organizationId,
          });

          await this.#prismaClient.jobRun.update({
            where: {
              id: run.id,
            },
            data: {
              status: "CANCELED",
              completedAt: new Date(),
            },
          });

          return;
        }
      } catch (e) {}

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

      const executionBody = await this.#createExecutionBody(
        run,
        [run.tasks, resumedTask].flat().filter(Boolean),
        startedAt,
        isRetry,
        connections.auth,
        event,
        sourceContext.success ? sourceContext.data : undefined
      );

      forceYieldCoordinator.registerRun(run.id);

      const { response, parser, errorParser, durationInMs } = await client.executeJobRequest(
        executionBody
      );

      forceYieldCoordinator.deregisterRun(run.id);

      if (!response) {
        return await this.#failRunExecutionWithRetry({
          message: `Connection could not be established to the endpoint (${run.endpoint.url})`,
        });
      }

      // Update the endpoint version if it has changed
      const rawHeaders = Object.fromEntries(response.headers.entries());
      const headers = EndpointHeadersSchema.safeParse(rawHeaders);

      if (
        headers.success &&
        headers.data["trigger-version"] &&
        headers.data["trigger-version"] !== run.endpoint.version
      ) {
        await this.#prismaClient.endpoint.update({
          where: {
            id: run.endpoint.id,
          },
          data: {
            version: headers.data["trigger-version"],
          },
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
          // If the error is a timeout, we should mark this execution as succeeded (by not throwing an error) and enqueue a new execution
          if (detectResponseIsTimeout(response)) {
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
        case "UNRESOLVED_AUTH_ERROR": {
          await this.#failRunWithUnresolvedAuthError(run, safeBody.data, durationInMs);

          break;
        }
        case "INVALID_PAYLOAD": {
          await this.#failRunWithInvalidPayloadError(run, safeBody.data, durationInMs);

          break;
        }
        case "YIELD_EXECUTION": {
          await this.#resumeYieldedRun(
            run,
            safeBody.data.key,
            isRetry,
            durationInMs,
            executionCount
          );
          break;
        }
        case "AUTO_YIELD_EXECUTION": {
          await this.#resumeAutoYieldedRun(
            run,
            safeBody.data,
            isRetry,
            durationInMs,
            executionCount
          );
          break;
        }
        case "AUTO_YIELD_EXECUTION_WITH_COMPLETED_TASK": {
          await this.#resumeAutoYieldedRunWithCompletedTask(
            run,
            safeBody.data,
            isRetry,
            durationInMs,
            executionCount
          );
          break;
        }
        default: {
          const _exhaustiveCheck: never = status;
          throw new Error(`Non-exhaustive match for value: ${status}`);
        }
      }
    } finally {
      forceYieldCoordinator.deregisterRun(run.id);
    }
  }

  async #createExecutionBody(
    run: FoundRun,
    tasks: FoundTask[],
    startedAt: Date,
    isRetry: boolean,
    connections: Record<string, ConnectionAuth>,
    event: ApiEventLog,
    source?: RunSourceContext
  ): Promise<RunJobBody> {
    if (supportsFeature("lazyLoadedCachedTasks", run.endpoint.version)) {
      const preparedTasks = prepareTasksForCaching(tasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

      return {
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
        connections,
        source,
        tasks: preparedTasks.tasks,
        cachedTaskCursor: preparedTasks.cursor,
        noopTasksSet: prepareNoOpTasksBloomFilter(tasks),
        yieldedExecutions: run.yieldedExecutions,
        runChunkExecutionLimit: run.endpoint.runChunkExecutionLimit - RUN_CHUNK_EXECUTION_BUFFER,
        autoYieldConfig: {
          startTaskThreshold: run.endpoint.startTaskThreshold,
          beforeExecuteTaskThreshold: run.endpoint.beforeExecuteTaskThreshold,
          beforeCompleteTaskThreshold: run.endpoint.beforeCompleteTaskThreshold,
          afterCompleteTaskThreshold: run.endpoint.afterCompleteTaskThreshold,
        },
      };
    }

    const preparedTasks = prepareTasksForCachingLegacy(tasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

    return {
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
      connections,
      source,
      tasks: preparedTasks.tasks,
    };
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
      // Tasks with callbacks enabled will also get processed separately, i.e. when
      // they time out, or on valid requests to their callbackUrl
      if (!data.task.operation && !data.task.callbackUrl) {
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

  async #failRunWithUnresolvedAuthError(
    execution: FoundRun,
    data: RunJobUnresolvedAuthError,
    durationInMs: number
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await this.#failRunExecution(
        tx,
        "EXECUTE_JOB",
        execution,
        data.issues,
        "UNRESOLVED_AUTH",
        durationInMs
      );
    });
  }

  async #failRunWithInvalidPayloadError(
    execution: FoundRun,
    data: RunJobInvalidPayloadError,
    durationInMs: number
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      await this.#failRunExecution(
        tx,
        "EXECUTE_JOB",
        execution,
        data.errors,
        "INVALID_PAYLOAD",
        durationInMs
      );
    });
  }

  async #resumeYieldedRun(
    run: FoundRun,
    key: string,
    isRetry: boolean,
    durationInMs: number,
    executionCount: number
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      if (run.yieldedExecutions.length + 1 > MAX_RUN_YIELDED_EXECUTIONS) {
        return await this.#failRunExecution(
          tx,
          "EXECUTE_JOB",
          run,
          {
            message: `Run has yielded too many times, the maximum is ${MAX_RUN_YIELDED_EXECUTIONS}`,
          },
          "FAILURE",
          durationInMs
        );
      }

      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
          yieldedExecutions: {
            push: key,
          },
          forceYieldImmediately: false,
        },
        select: {
          yieldedExecutions: true,
          executionCount: true,
        },
      });

      await enqueueRunExecutionV2(run, tx, {
        isRetry,
        skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        executionCount,
      });
    });
  }

  async #resumeAutoYieldedRun(
    run: FoundRun,
    data: { location: string; timeRemaining: number; timeElapsed: number; limit?: number },
    isRetry: boolean,
    durationInMs: number,
    executionCount: number
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
          autoYieldExecution: {
            create: [
              {
                location: data.location,
                timeRemaining: data.timeRemaining,
                timeElapsed: data.timeElapsed,
                limit: data.limit ?? 0,
              },
            ],
          },
          forceYieldImmediately: false,
        },
        select: {
          executionCount: true,
        },
      });

      await enqueueRunExecutionV2(run, tx, {
        isRetry,
        skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        executionCount,
      });
    });
  }

  async #resumeAutoYieldedRunWithCompletedTask(
    run: FoundRun,
    data: RunJobAutoYieldWithCompletedTaskExecutionError,
    isRetry: boolean,
    durationInMs: number,
    executionCount: number
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.jobRun.update({
        where: {
          id: run.id,
        },
        data: {
          executionDuration: {
            increment: durationInMs,
          },
          executionCount: {
            increment: 1,
          },
          autoYieldExecution: {
            create: [
              {
                location: data.data.location,
                timeRemaining: data.data.timeRemaining,
                timeElapsed: data.data.timeElapsed,
                limit: data.data.limit ?? 0,
              },
            ],
          },
          forceYieldImmediately: false,
        },
        select: {
          executionCount: true,
        },
      });

      const service = new CompleteRunTaskService(tx);

      await service.call(run.environment, run.id, data.id, {
        properties: data.properties,
        output: data.output,
      });

      await enqueueRunExecutionV2(run, tx, {
        isRetry,
        skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
        executionCount,
      });
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

      const runWithLatestTask = await tx.jobRun.findUniqueOrThrow({
        where: {
          id: run.id,
        },
        select: {
          tasks: {
            select: {
              id: true,
              name: true,
              status: true,
              displayKey: true,
            },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
          _count: {
            select: {
              tasks: true,
            },
          },
        },
      });

      if (runWithLatestTask._count.tasks === run._count.tasks) {
        const latestTask = runWithLatestTask.tasks[0];

        const cause =
          latestTask?.status === "RUNNING"
            ? `This is likely caused by task "${
                latestTask.displayKey ?? latestTask.name
              }" execution exceeding the function timeout`
            : "This is likely caused by executing code outside of a task that exceeded the function timeout";

        await this.#failRunExecution(
          tx,
          "EXECUTE_JOB",
          run,
          {
            message: `Function timeout detected in ${
              durationInMs / 1000.0
            }s without any task creation. This is unexpected behavior and could lead to an infinite execution error because the run will never finish. ${cause}`,
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
          endpoint: {
            update: {
              // Never allow the execution limit to be less than 10 seconds or more than MAX_RUN_CHUNK_EXECUTION_LIMIT
              runChunkExecutionLimit: Math.min(
                Math.max(durationInMs, 10000),
                MAX_RUN_CHUNK_EXECUTION_LIMIT
              ),
            },
          },
          forceYieldImmediately: false,
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
    status: "FAILURE" | "ABORTED" | "TIMED_OUT" | "UNRESOLVED_AUTH" | "INVALID_PAYLOAD" = "FAILURE",
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
              tasks: {
                updateMany: {
                  where: {
                    status: {
                      in: ["WAITING", "RUNNING", "PENDING"],
                    },
                  },
                  data: {
                    status: status === "TIMED_OUT" ? "CANCELED" : "ERRORED",
                    completedAt: new Date(),
                  },
                },
              },
              forceYieldImmediately: false,
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

function prepareNoOpTasksBloomFilter(possibleTasks: FoundTask[]): string {
  const tasks = possibleTasks.filter((task) => task.status === "COMPLETED" && task.noop);

  const filter = new BloomFilter(BloomFilter.NOOP_TASK_SET_SIZE);

  for (const task of tasks) {
    filter.add(task.idempotencyKey);
  }

  return filter.serialize();
}

async function findRun(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRun.findUnique({
    where: { id },
    include: {
      environment: {
        include: {
          project: true,
          organization: true,
        },
      },
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
        orderBy: {
          id: "asc",
        },
      },
      event: true,
      version: {
        include: {
          job: true,
          organization: true,
        },
      },
      _count: {
        select: {
          tasks: true,
        },
      },
    },
  });
}
