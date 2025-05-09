import {
  calculateNextRetryDelay,
  isOOMRunError,
  RetryOptions,
  sanitizeError,
  shouldRetryError,
  TaskRunError,
  taskRunErrorEnhancer,
  TaskRunExecutionRetry,
} from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { MAX_TASK_RUN_ATTEMPTS } from "./consts.js";
import { ServiceValidationError } from "./errors.js";

type Params = {
  runId: string;
  attemptNumber: number | null;
  error: TaskRunError;
  retryUsingQueue: boolean;
  retrySettings: TaskRunExecutionRetry | undefined;
};

export type RetryOutcome =
  | {
      outcome: "cancel_run";
      reason?: string;
    }
  | {
      outcome: "fail_run";
      sanitizedError: TaskRunError;
      wasOOMError?: boolean;
    }
  | {
      outcome: "retry";
      method: "queue" | "immediate";
      settings: TaskRunExecutionRetry;
      machine?: string;
      wasOOMError?: boolean;
    };

export async function retryOutcomeFromCompletion(
  prisma: PrismaClientOrTransaction,
  { runId, attemptNumber, error, retryUsingQueue, retrySettings }: Params
): Promise<RetryOutcome> {
  // Canceled
  if (error.type === "INTERNAL_ERROR" && error.code === "TASK_RUN_CANCELLED") {
    return { outcome: "cancel_run", reason: error.message };
  }

  const sanitizedError = sanitizeError(error);

  // OOM error (retry on a larger machine or fail)
  if (isOOMRunError(error)) {
    const oomResult = await retryOOMOnMachine(prisma, runId);
    if (!oomResult) {
      return { outcome: "fail_run", sanitizedError, wasOOMError: true };
    }

    const delay = calculateNextRetryDelay(oomResult.retrySettings, attemptNumber ?? 1);

    if (!delay) {
      //no more retries left
      return { outcome: "fail_run", sanitizedError, wasOOMError: true };
    }

    return {
      outcome: "retry",
      method: "queue",
      machine: oomResult.machine,
      settings: { timestamp: Date.now() + delay, delay },
      wasOOMError: true,
    };
  }

  // No retry settings
  if (!retrySettings) {
    return { outcome: "fail_run", sanitizedError };
  }

  // Not a retriable error: fail
  const retriableError = shouldRetryError(taskRunErrorEnhancer(error));
  if (!retriableError) {
    return { outcome: "fail_run", sanitizedError };
  }

  // Exceeded global max attempts
  if (attemptNumber !== null && attemptNumber > MAX_TASK_RUN_ATTEMPTS) {
    return { outcome: "fail_run", sanitizedError };
  }

  // Get the run settings
  const run = await prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
    select: {
      maxAttempts: true,
    },
  });

  if (!run) {
    throw new ServiceValidationError("Run not found", 404);
  }

  // No max attempts set
  if (!run.maxAttempts) {
    return { outcome: "fail_run", sanitizedError };
  }

  // No attempts left
  if (attemptNumber !== null && attemptNumber >= run.maxAttempts) {
    return { outcome: "fail_run", sanitizedError };
  }

  return {
    outcome: "retry",
    method: retryUsingQueue ? "queue" : "immediate",
    settings: retrySettings,
  };
}

async function retryOOMOnMachine(
  prisma: PrismaClientOrTransaction,
  runId: string
): Promise<{ machine: string; retrySettings: RetryOptions } | undefined> {
  try {
    const run = await prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      select: {
        machinePreset: true,
        lockedBy: {
          select: {
            retryConfig: true,
          },
        },
      },
    });

    if (!run || !run.lockedBy || !run.machinePreset) {
      return;
    }

    const retryConfig = run.lockedBy?.retryConfig;
    const parsedRetryConfig = RetryOptions.nullish().safeParse(retryConfig);

    if (!parsedRetryConfig.success) {
      return;
    }

    if (!parsedRetryConfig.data) {
      return;
    }

    const retryMachine = parsedRetryConfig.data.outOfMemory?.machine;

    if (!retryMachine) {
      return;
    }

    if (run.machinePreset === retryMachine) {
      return;
    }

    return { machine: retryMachine, retrySettings: parsedRetryConfig.data };
  } catch (error) {
    console.error("[FailedTaskRunRetryHelper] Failed to get execution retry", {
      runId,
      error,
    });

    return;
  }
}
