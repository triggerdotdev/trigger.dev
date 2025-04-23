import { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { RunChainStateManager, TriggerTaskRequest } from "../types";
import { RunChainState } from "@trigger.dev/core/v3/schemas";
import { logger } from "~/services/logger.server";
import { EngineServiceValidationError } from "./errors";

export class DefaultRunChainStateManager implements RunChainStateManager {
  private readonly prisma: PrismaClientOrTransaction;
  private readonly isReleaseConcurrencyEnabled: boolean;

  constructor(prisma: PrismaClientOrTransaction, isReleaseConcurrencyEnabled: boolean) {
    this.prisma = prisma;
    this.isReleaseConcurrencyEnabled = isReleaseConcurrencyEnabled;
  }

  async validateRunChain(
    request: TriggerTaskRequest,
    {
      parentRun,
      queueName,
      lockedQueueId,
    }: { parentRun?: TaskRun; queueName: string; lockedQueueId?: string }
  ): Promise<RunChainState> {
    // if there is no parent run, the chain resets
    if (!parentRun) {
      return {};
    }

    const parsedParentRunChainState = RunChainState.safeParse(parentRun.runChainState ?? {});

    if (!parsedParentRunChainState.success) {
      logger.error("Invalid run chain state for parent run", {
        runId: parentRun.id,
        runState: parentRun.runChainState,
        error: parsedParentRunChainState.error,
      });

      return {};
    }

    const parentRunChainState = parsedParentRunChainState.data;

    if (
      typeof request.body.options?.resumeParentOnCompletion === "boolean" &&
      !request.body.options.resumeParentOnCompletion
    ) {
      return parentRunChainState;
    }

    // Now we need to check if the parent run will hold concurrency, or if it will release it
    // if it will hold concurrency, we need to account for the parent run's concurrency
    // Then, along with the new run's concurrency,
    // we need to determine if the new run will ever be able to run, or are we in a deadlock situation
    // We need to check the concurrency limit against the concurrency limit of the environment, and the queue of the new run
    // We'll also need the queue of the parent run, to determine if the parent run will release and which queue to add to
    // Since the parent run is already running, it will definitely have a locked queue associated with it
    const { concurrency } = parentRunChainState;

    const parentLockedQueueId = parentRun.lockedQueueId;

    if (!parentLockedQueueId) {
      logger.error("Parent run has no locked queue, cannot determine run chain state", {
        runId: parentRun.id,
        runState: parentRun.runChainState,
      });

      return {};
    }

    const parentQueueState = await this.#getParentQueueState(
      parentRunChainState,
      parentLockedQueueId
    );

    // We first need to check if the release concurrency system is enabled,
    // If it is not enabled, then we can assume the parent run will hold the concurrency,
    // for the env and the queue
    // If it is enabled, we never hold the concurrency for the env, just for the queue
    if (!this.isReleaseConcurrencyEnabled) {
      parentQueueState.holding += 1;

      const newRunChainState = {
        ...parentRunChainState,
        concurrency: {
          queues: [
            ...(concurrency?.queues ?? []).filter((queue) => queue.id !== parentLockedQueueId),
            parentQueueState,
          ],
          environment: (concurrency?.environment ?? 0) + 1,
        },
      };

      return await this.#validateNewRunChainState(request, newRunChainState, {
        parentRun,
        queueName,
        lockedQueueId,
      });
    }

    // Now we need to determine if the parent run will release the concurrency
    // if it does, we will add to the holding count for the queue
    const willReleaseConcurrency = await this.#determineIfParentRunWillReleaseConcurrency(
      request,
      parentLockedQueueId
    );

    if (!willReleaseConcurrency) {
      parentQueueState.holding += 1;
    }

    const newRunChainState = {
      ...parentRunChainState,
      concurrency: {
        queues: [
          ...(concurrency?.queues ?? []).filter((queue) => queue.id !== parentLockedQueueId),
          parentQueueState,
        ],
        environment: concurrency?.environment ?? 0,
      },
    };

    return await this.#validateNewRunChainState(request, newRunChainState, {
      parentRun,
      queueName,
      lockedQueueId,
    });
  }

  // Performs the deadlock detection logic once the new run chain state is determined
  // Needs to account for everything held, plus the new run's concurrency
  async #validateNewRunChainState(
    request: TriggerTaskRequest,
    runChainState: RunChainState,
    {
      parentRun,
      queueName,
      lockedQueueId,
    }: { parentRun?: TaskRun; queueName: string; lockedQueueId?: string }
  ) {
    logger.debug("Validating new run chain state", {
      runChainState,
    });

    const environmentConcurrency = (runChainState.concurrency?.environment ?? 0) + 1;

    if (environmentConcurrency > request.environment.maximumConcurrencyLimit) {
      const environmentDetails = `The environment has a concurrency limit of ${request.environment.maximumConcurrencyLimit}, and the chain would require ${environmentConcurrency}`;
      throw new EngineServiceValidationError(this.createDeadlockErrorMessage(environmentDetails));
    }

    if (!lockedQueueId) {
      return runChainState;
    }

    const queueConcurrencyState = runChainState.concurrency?.queues.find(
      (queue) => queue.id === lockedQueueId
    );

    if (!queueConcurrencyState) {
      return runChainState;
    }

    const queueConcurrency = queueConcurrencyState.holding + 1;

    const queue = await this.prisma.taskQueue.findFirst({
      where: {
        id: lockedQueueId,
      },
      select: {
        concurrencyLimit: true,
      },
    });

    if (!queue) {
      return runChainState;
    }

    const queueConcurrencyLimit = queue.concurrencyLimit;

    if (
      typeof queueConcurrencyLimit === "number" &&
      queueConcurrencyLimit !== 0 &&
      queueConcurrency > queueConcurrencyLimit
    ) {
      const queueDetails = `The queue '${queueName}' has a concurrency limit of ${queueConcurrencyLimit}, and the chain would require ${queueConcurrency}`;
      throw new EngineServiceValidationError(this.createDeadlockErrorMessage(queueDetails));
    }

    return runChainState;
  }

  async #determineIfParentRunWillReleaseConcurrency(
    request: TriggerTaskRequest,
    parentLockedQueueId: string
  ) {
    if (typeof request.body.options?.releaseConcurrency === "boolean") {
      return request.body.options.releaseConcurrency;
    }

    const parentQueue = await this.prisma.taskQueue.findFirst({
      where: {
        id: parentLockedQueueId,
      },
      select: {
        releaseConcurrencyOnWaitpoint: true,
        concurrencyLimit: true,
      },
    });

    logger.debug("Determining if parent run will release concurrency", {
      parentQueue,
    });

    if (
      typeof parentQueue?.concurrencyLimit === "undefined" ||
      parentQueue.concurrencyLimit === null
    ) {
      return true;
    }

    if (typeof parentQueue?.releaseConcurrencyOnWaitpoint === "boolean") {
      return parentQueue.releaseConcurrencyOnWaitpoint;
    }

    return false;
  }

  async #getParentQueueState(runChainState: RunChainState, parentLockedQueueId: string) {
    const newQueueState = runChainState.concurrency?.queues.find(
      (queue) => queue.id === parentLockedQueueId
    );

    if (newQueueState) {
      return newQueueState;
    }

    const parentQueue = await this.prisma.taskQueue.findFirst({
      where: {
        id: parentLockedQueueId,
      },
    });

    if (!parentQueue) {
      throw new Error("Deadlock detection failed, parent queue not found");
    }

    return {
      id: parentQueue.id,
      name: parentQueue.name,
      holding: 0,
    };
  }

  private createDeadlockErrorMessage(details: string) {
    return `Deadlock detected: This task run cannot be triggered because it would create a concurrency deadlock. 

A deadlock occurs when a chain of task runs (parent -> child) would collectively hold more concurrency than is available, making it impossible for the child run to ever execute.

Current situation:
${details}

This usually happens when:
1. A parent task triggers a child task using triggerAndWait()
2. Both tasks use the same queue
3. The parent task doesn't release its concurrency while waiting (releaseConcurrency: false)

To fix this, you can:
1. Enable releaseConcurrencyOnWaitpoint on the queue
2. Use a different queue for the child task
3. Increase the concurrency limits
4. Use trigger() instead of triggerAndWait() if you don't need to wait

Learn more about concurrency and deadlocks at https://trigger.dev/docs/queue-concurrency`;
  }
}
