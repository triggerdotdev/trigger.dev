import { z } from "zod";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { RuntimeEnvironmentType } from "../../../database/src/index.js";
import { env } from "process";
import { version } from "os";

export const InputPayload = z.object({
  runId: z.string(),
  taskIdentifier: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  environmentType: z.nativeEnum(RuntimeEnvironmentType),
  queue: z.string(),
  concurrencyKey: z.string().optional(),
  timestamp: z.number(),
});
export type InputPayload = z.infer<typeof InputPayload>;

export const OutputPayload = InputPayload.extend({
  version: z.literal("1"),
  parentQueue: z.string(),
});
export type OutputPayload = z.infer<typeof OutputPayload>;

export type QueueCapacity = {
  current: number;
  limit: number;
};

export type QueueCapacities = {
  queue: QueueCapacity;
  env: QueueCapacity;
};

export type QueueWithScores = {
  queue: string;
  capacities: QueueCapacities;
  age: number;
  size: number;
};

export type QueueRange = { offset: number; count: number };

export interface RunQueueKeyProducer {
  envSharedQueueKey(env: MinimalAuthenticatedEnvironment): string;
  sharedQueueKey(): string;
  sharedQueueScanPattern(): string;
  queueCurrentConcurrencyScanPattern(): string;
  //queue
  queueKey(env: MinimalAuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  queueConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment, queue: string): string;
  concurrencyLimitKeyFromQueue(queue: string): string;
  currentConcurrencyKeyFromQueue(queue: string): string;
  currentConcurrencyKey(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;
  disabledConcurrencyLimitKeyFromQueue(queue: string): string;
  //env oncurrency
  envCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;
  envConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment): string;
  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  //task concurrency
  taskIdentifierCurrentConcurrencyKey(
    env: MinimalAuthenticatedEnvironment,
    taskIdentifier: string
  ): string;
  taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(queue: string): string;
  taskIdentifierCurrentConcurrencyKeyFromQueue(queue: string, taskIdentifier: string): string;
  //project concurrency
  projectCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;
  projectCurrentConcurrencyKeyFromQueue(queue: string): string;
  //message payload
  messageKeyPrefixFromQueue(queue: string): string;
  messageKey(orgId: string, messageId: string): string;
  //utils
  stripKeyPrefix(key: string): string;
  extractComponentsFromQueue(queue: string): {
    orgId: string;
    projectId: string;
    envId: string;
    queue: string;
    concurrencyKey: string | undefined;
  };
}

export type PriorityStrategyChoice = string | { abort: true };

export interface RunQueuePriorityStrategy {
  /**
   * chooseQueue is called to select the next queue to process a message from
   *
   * @param queues
   * @param parentQueue
   * @param consumerId
   *
   * @returns The queue to process the message from, or an object with `abort: true` if no queue is available
   */
  chooseQueue(
    queues: Array<QueueWithScores>,
    parentQueue: string,
    consumerId: string,
    previousRange: QueueRange
  ): { choice: PriorityStrategyChoice; nextRange: QueueRange };

  /**
   * This function is called to get the next candidate selection for the queue
   * The `range` is used to select the set of queues that will be considered for the next selection (passed to chooseQueue)
   * The `selectionId` is used to identify the selection and should be passed to chooseQueue
   *
   * @param parentQueue The parent queue that holds the candidate queues
   * @param consumerId The consumerId that is making the request
   *
   * @returns The scores and the selectionId for the next candidate selection
   */
  nextCandidateSelection(parentQueue: string, consumerId: string): Promise<{ range: QueueRange }>;
}
