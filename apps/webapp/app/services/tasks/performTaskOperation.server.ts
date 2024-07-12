import { FetchOperationSchema , FetchPollOperationSchema , type FetchRequestInit , type FetchRetryOptions , type FetchRetryStrategy , type RedactString , type RetryOptions } from '@trigger.dev/core/schemas';
import { calculateResetAt , calculateRetryAt } from '@trigger.dev/core/retry';
import { eventFilterMatches } from '@trigger.dev/core/eventFilterMatches';
import { responseFilterMatches } from '@trigger.dev/core/requestFilterMatches';
import { type Task } from "@trigger.dev/database";
import { $transaction, type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { formatUnknownError } from "~/utils/formatErrors.server";
import { safeJsonFromResponse } from "~/utils/json";
import { logger } from "../logger.server";
import { taskOperationWorker, workerQueue } from "../worker.server";
import { ResumeTaskService } from "./resumeTask.server";
import { fetch } from "@whatwg-node/fetch";
import { fromZodError } from "zod-validation-error";
import { ulid } from "../ulid.server";

type FoundTask = Awaited<ReturnType<typeof findTask>>;

export class PerformTaskOperationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const task = await findTask(this.#prismaClient, id);

    if (!task) {
      return;
    }

    if (task.status === "CANCELED") {
      return;
    }

    if (task.status === "COMPLETED" || task.status === "ERRORED") {
      return await this.#resumeRunExecution(task, this.#prismaClient);
    }

    if (!task.operation) {
      return await this.#resumeTask(task, null, null, 200, "fetch", 0);
    }

    switch (task.operation) {
      case "fetch-poll": {
        const pollOperation = FetchPollOperationSchema.safeParse(task.params);

        if (!pollOperation.success) {
          return await this.#resumeTaskWithError(
            task,
            fromZodError(pollOperation.error, {
              prefix: "Invalid fetch poll params",
            }).message
          );
        }

        const { url, requestInit, timeout, interval, responseFilter, requestTimeout } =
          pollOperation.data;

        // check if we need to fail the task because it's timed out
        const startedAt = task.startedAt;

        if (!startedAt) {
          return await this.#resumeTaskWithError(task, {
            message: "Task has not been started",
          });
        }

        if (Date.now() - startedAt.getTime() > timeout * 1000) {
          return await this.#resumeTaskWithError(task, {
            message: `Task timed out after ${timeout} seconds`,
          });
        }

        const startTimeInMs = performance.now();

        const abortController = new AbortController();

        // calculate the actual timeout. If timeoutInMs is undefined, we use the default of 5s
        // Also make sure the timeout is at least 1s, but not bigger than 5s
        const actualTimeoutInMs = Math.min(
          Math.max(requestTimeout?.durationInMs ?? 5000, 1000),
          5000
        );

        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, actualTimeoutInMs);

        try {
          logger.debug("PerformTaskOperationService.call poll request", {
            task,
            actualTimeoutInMs,
            url,
            responseFilter,
          });

          const startedAt = new Date();

          const method = requestInit?.method ?? "GET";

          const response = await fetch(url, {
            method,
            headers: normalizeHeaders(requestInit?.headers ?? {}),
            body: requestInit?.body,
            signal: abortController.signal,
          });

          clearTimeout(timeoutId);

          const durationInMs = Math.floor(performance.now() - startTimeInMs);

          const headers = Object.fromEntries(response.headers.entries());

          logger.debug("PerformTaskOperationService.call poll response", {
            url,
            requestInit,
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            durationInMs,
          });

          const matchResult = await responseFilterMatches(response, responseFilter);

          await this.#prismaClient.task.create({
            data: {
              id: ulid(),
              idempotencyKey: ulid(),
              runId: task.runId,
              parentId: task.id,
              name: "poll attempt",
              icon: "activity",
              status: "COMPLETED",
              noop: true,
              style: { style: "minimal", variant: "info" },
              description: `${method} ${url} ${response.status}`,
              params: {
                status: response.status,
                headers,
                body: matchResult.body as any,
              },
              startedAt,
              completedAt: new Date(),
            },
          });

          if (matchResult.match) {
            logger.debug("PerformTaskOperationService.call poll response matched", {
              url,
              matchResult,
            });

            return await this.#resumeTask(
              task,
              matchResult.body,
              Object.fromEntries(response.headers.entries()),
              response.status,
              "fetch",
              durationInMs
            );
          } else {
            const retryAt = new Date(Date.now() + interval * 1000);

            return await this.#retryTask(task, retryAt);
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            const durationInMs = Math.floor(performance.now() - startTimeInMs);

            logger.debug("PerformTaskOperationService.call poll timed out", {
              url,
              durationInMs,
              error,
            });

            const retryAt = this.#calculateRetryForTimeout(task, requestTimeout?.retry);

            if (retryAt) {
              return await this.#retryTask(task, retryAt);
            }

            return await this.#resumeTaskWithError(task, {
              message: `Fetch timed out after ${actualTimeoutInMs.toFixed(0)}ms`,
            });
          }

          throw error;
        }
      }
      case "fetch":
      case "fetch-response": {
        const fetchOperation = FetchOperationSchema.safeParse(task.params);

        if (!fetchOperation.success) {
          return await this.#resumeTaskWithError(
            task,
            `Invalid fetch operation: ${fetchOperation.error.message}`
          );
        }

        const { url, requestInit, retry, timeout } = fetchOperation.data;

        const startTimeInMs = performance.now();

        const abortController = new AbortController();

        // calculate the actual timeout. If timeoutInMs is undefined, we use the default of 120s
        // Also make sure the timeout is at least 1s, but not bigger than 300s
        const actualTimeoutInMs = Math.min(Math.max(timeout?.durationInMs ?? 120000, 1000), 300000);

        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, actualTimeoutInMs);

        try {
          logger.debug("PerformTaskOperationService.call fetch request", {
            task,
            actualTimeoutInMs,
            url,
            retry,
          });

          const response = await fetch(url, {
            method: requestInit?.method ?? "GET",
            headers: normalizeHeaders(requestInit?.headers ?? {}),
            body: requestInit?.body,
            signal: abortController.signal,
          });

          clearTimeout(timeoutId);

          const durationInMs = Math.floor(performance.now() - startTimeInMs);

          const jsonBody = await safeJsonFromResponse(response);

          logger.debug("PerformTaskOperationService.call fetch response", {
            url,
            requestInit,
            retry,
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            jsonBody,
            durationInMs,
          });

          if (!response.ok) {
            const retryAt = this.#calculateRetryForResponse(task, retry, response, jsonBody);

            if (retryAt) {
              return await this.#retryTaskWithError(
                task,
                `Fetch failed with status ${response.status}`,
                retryAt
              );
            }

            // See if there is a json body
            if (jsonBody) {
              return await this.#resumeTaskWithError(task, jsonBody);
            } else {
              return await this.#resumeTaskWithError(task, {
                message: `Fetch failed with status ${response.status}`,
              });
            }
          }

          return await this.#resumeTask(
            task,
            jsonBody,
            Object.fromEntries(response.headers.entries()),
            response.status,
            task.operation,
            durationInMs
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            const durationInMs = Math.floor(performance.now() - startTimeInMs);

            logger.debug("PerformTaskOperationService.call fetch timed out", {
              url,
              durationInMs,
              error,
            });

            const retryAt = this.#calculateRetryForTimeout(task, timeout?.retry);

            if (retryAt) {
              return await this.#retryTaskWithError(
                task,
                `Fetch timed out after ${actualTimeoutInMs.toFixed(0)}ms`,
                retryAt
              );
            }

            return await this.#resumeTaskWithError(task, {
              message: `Fetch timed out after ${actualTimeoutInMs.toFixed(0)}ms`,
            });
          }

          throw error;
        }
      }
      default: {
        await this.#resumeTaskWithError(task, {
          message: `Unknown operation: ${task.operation}`,
        });
      }
    }
  }

  #calculateRetryForResponse(
    task: NonNullable<FoundTask>,
    retry: FetchRetryOptions | undefined,
    response: Response,
    body: any
  ): Date | undefined {
    if (!retry) {
      return;
    }

    const strategy = this.#getRetryStrategyForResponse(response, body, retry);

    if (!strategy) {
      return;
    }

    logger.debug("Calculating retry at for strategy", {
      strategy,
      status: response.status,
      retry,
    });

    switch (strategy.strategy) {
      case "backoff": {
        return calculateRetryAt(strategy, task.attempts.length - 1);
      }
      case "headers": {
        const resetAt = response.headers.get(strategy.resetHeader);

        if (typeof resetAt === "string") {
          return calculateResetAt(resetAt, strategy.resetFormat);
        }
      }
    }
  }

  #calculateRetryForTimeout(
    task: NonNullable<FoundTask>,
    retry: RetryOptions | undefined
  ): Date | undefined {
    if (!retry) {
      return;
    }

    return calculateRetryAt(retry, task.attempts.length - 1);
  }

  #getRetryStrategyForResponse(
    response: Response,
    body: any,
    retry: FetchRetryOptions
  ): FetchRetryStrategy | undefined {
    const statusCodes = Object.keys(retry);

    for (let i = 0; i < statusCodes.length; i++) {
      const statusRange = statusCodes[i];
      const strategy = retry[statusRange];

      if (isStatusCodeInRange(response.status, statusRange)) {
        if (strategy.bodyFilter) {
          if (!body) {
            continue;
          }

          if (eventFilterMatches(body, strategy.bodyFilter)) {
            return strategy;
          } else {
            continue;
          }
        }

        return strategy;
      }
    }

    return;
  }

  async #retryTaskWithError(task: Task, error: string, retryAt: Date) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "ERRORED",
          error,
        },
      });

      const currentMaxNumber = await tx.taskAttempt.aggregate({
        where: { taskId: task.id },
        _max: { number: true },
      });

      const newNumber = (currentMaxNumber._max.number ?? 0) + 1;

      await tx.taskAttempt.create({
        data: {
          status: "PENDING",
          taskId: task.id,
          number: newNumber,
          runAt: retryAt,
        },
      });

      await taskOperationWorker.enqueue(
        "performTaskOperation",
        {
          id: task.id,
        },
        { tx, runAt: retryAt, jobKey: `operation:${task.id}` }
      );
    });
  }

  async #retryTask(task: Task, retryAt: Date) {
    await taskOperationWorker.enqueue(
      "performTaskOperation",
      {
        id: task.id,
      },
      { runAt: retryAt, jobKey: `operation:${task.id}` }
    );
  }

  async #resumeTaskWithError(task: NonNullable<FoundTask>, output: any) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "ERRORED",
          completedAt: new Date(),
          output,
        },
      });

      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "ERRORED",
          error: formatUnknownError(output),
        },
      });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeTask(
    task: NonNullable<FoundTask>,
    output: any,
    context: any,
    status: number,
    operation: "fetch" | "fetch-response",
    durationInMs: number
  ) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "COMPLETED",
        },
      });

      const taskOutput =
        operation === "fetch"
          ? output
          : {
              data: output,
              headers: context,
              status,
            };

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: taskOutput,
          context: context ? context : undefined,
          run: {
            update: {
              executionDuration: {
                increment: durationInMs,
              },
            },
          },
        },
      });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeRunExecution(task: NonNullable<FoundTask>, prisma: PrismaClientOrTransaction) {
    await ResumeTaskService.enqueue(task.id, undefined, prisma);
  }
}

function normalizeHeaders(headers: FetchRequestInit["headers"]): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      typeof value === "string" ? value : hydrateRedactedString(value),
    ])
  );
}

function hydrateRedactedString(value: RedactString): string {
  let result = "";

  for (let i = 0; i < value.strings.length; i++) {
    result += value.strings[i];
    if (i < value.interpolations.length) {
      result += value.interpolations[i];
    }
  }

  return result;
}

async function findTask(prisma: PrismaClient, id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      attempts: true,
      run: {
        include: {
          environment: true,
          queue: true,
        },
      },
    },
  });
}

// Add a random number of ms between 0ms and 5000ms
function addJitterInMs() {
  return Math.floor(Math.random() * 5000);
}

/**
 * Checks if a given status code falls within a given range.
 * The range can be a single status code (e.g. "200"),
 * a range of status codes (e.g. "500-599"),
 * a range of status codes with a wildcard (e.g. "4xx" for any 4xx status code),
 * or a list of status codes separated by commas (e.g. "401,403,404").
 * Returns `true` if the status code falls within the range, and `false` otherwise.
 */
function isStatusCodeInRange(statusCode: number, statusRange: string): boolean {
  if (statusRange === "all") {
    return true;
  }

  if (statusRange.includes(",")) {
    const statusCodes = statusRange.split(",").map((s) => s.trim());
    return statusCodes.includes(statusCode.toString());
  }

  const [start, end] = statusRange.split("-");

  if (end) {
    return statusCode >= parseInt(start, 10) && statusCode <= parseInt(end, 10);
  }

  if (start.endsWith("xx")) {
    const prefix = start.slice(0, -2);
    const statusCodePrefix = Math.floor(statusCode / 100).toString();
    return statusCodePrefix === prefix;
  }

  const statusCodeString = statusCode.toString();
  const rangePrefix = start.slice(0, -1);

  if (start.endsWith("x") && statusCodeString.startsWith(rangePrefix)) {
    return true;
  }

  return statusCode === parseInt(start, 10);
}
