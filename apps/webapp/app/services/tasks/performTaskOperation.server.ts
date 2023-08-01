import type { Task } from "@trigger.dev/database";
import { EXECUTE_JOB_RETRY_LIMIT } from "~/consts";
import {
  $transaction,
  PrismaClient,
  PrismaClientOrTransaction,
  prisma,
} from "~/db.server";
import { workerQueue } from "../worker.server";
import {
  FetchOperationSchema,
  FetchRequestInit,
  FetchRetryOptions,
  FetchRetryStrategy,
  RedactString,
  calculateRetryAt,
} from "@trigger.dev/core";
import { safeJsonFromResponse } from "~/utils/json";
import { logger } from "../logger.server";
import { formatUnknownError } from "~/utils/formatErrors.server";

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

    if (task.status === "COMPLETED" || task.status === "ERRORED") {
      return await this.#resumeRunExecution(task, this.#prismaClient);
    }

    if (!task.operation) {
      return await this.#resumeTask(task, null);
    }

    logger.debug("PerformTaskOperationService.call", { task });

    switch (task.operation) {
      case "fetch": {
        const fetchOperation = FetchOperationSchema.safeParse(task.params);

        if (!fetchOperation.success) {
          return await this.#resumeTaskWithError(
            task,
            `Invalid fetch operation: ${fetchOperation.error.message}`
          );
        }

        const { url, requestInit, retry } = fetchOperation.data;

        const response = await fetch(url, {
          method: requestInit?.method ?? "GET",
          headers: normalizeHeaders(requestInit?.headers ?? {}),
          body: requestInit?.body,
        });

        const jsonBody = await safeJsonFromResponse(response);

        logger.debug("PerformTaskOperationService.call.fetch", {
          url,
          requestInit,
          retry,
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          jsonBody,
        });

        if (!response.ok) {
          const retryAt = this.#calculateRetryForResponse(
            task,
            retry,
            response
          );

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

        return await this.#resumeTask(task, jsonBody);
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
    response: Response
  ): Date | undefined {
    if (!retry) {
      return;
    }

    const strategy = this.#getRetryStrategyForStatusCode(
      response.status,
      retry
    );

    if (!strategy) {
      return;
    }

    logger.debug("Calculating retry at for strategy", {
      strategy,
    });

    switch (strategy.strategy) {
      case "backoff": {
        return calculateRetryAt(strategy, task.attempts.length - 1);
      }
      case "headers": {
        const remaining = response.headers.get(strategy.remainingHeader);
        const resetAt = response.headers.get(strategy.resetHeader);

        if (
          typeof remaining === "string" &&
          typeof resetAt === "string" &&
          remaining === "0"
        ) {
          return new Date(Number(resetAt) * 1000 + addJitterInMs());
        }
      }
    }
  }

  #getRetryStrategyForStatusCode(
    statusCode: number,
    retry: FetchRetryOptions
  ): FetchRetryStrategy | undefined {
    const statusCodes = Object.keys(retry);

    for (let i = 0; i < statusCodes.length; i++) {
      const statusRange = statusCodes[i];
      const strategy = retry[statusRange];

      if (isStatusCodeInRange(statusCode, statusRange)) {
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

      await workerQueue.enqueue(
        "performTaskOperation",
        {
          id: task.id,
        },
        { tx, runAt: retryAt }
      );
    });
  }

  async #resumeTaskWithError(task: Task, output: any) {
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

  async #resumeTask(task: NonNullable<FoundTask>, output: any) {
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

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output ? output : undefined,
        },
      });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeRunExecution(task: Task, prisma: PrismaClientOrTransaction) {
    await $transaction(prisma, async (tx) => {
      const newJobExecution = await tx.jobRunExecution.create({
        data: {
          runId: task.runId,
          reason: "EXECUTE_JOB",
          status: "PENDING",
          retryLimit: EXECUTE_JOB_RETRY_LIMIT,
        },
      });

      const graphileJob = await workerQueue.enqueue(
        "performRunExecution",
        {
          id: newJobExecution.id,
        },
        { tx }
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
}

function normalizeHeaders(
  headers: FetchRequestInit["headers"]
): Record<string, string> {
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
