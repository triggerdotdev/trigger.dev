import { z } from "zod";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

export type QueueCapacity = {
  current: number;
  limit: number;
};

export type QueueCapacities = {
  queue: QueueCapacity;
  env: QueueCapacity;
  org: QueueCapacity;
};

export type QueueWithScores = {
  queue: string;
  capacities: QueueCapacities;
  age: number;
};

export interface MarQSKeyProducer {
  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string): string;
  envConcurrencyLimitKey(env: AuthenticatedEnvironment): string;
  orgConcurrencyLimitKey(env: AuthenticatedEnvironment): string;
  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  envSharedQueueKey(env: AuthenticatedEnvironment): string;
  sharedQueueScanPattern(): string;
  concurrencyLimitKeyFromQueue(queue: string): string;
  currentConcurrencyKeyFromQueue(queue: string): string;
  currentConcurrencyKey(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;
  orgConcurrencyLimitKeyFromQueue(queue: string): string;
  orgCurrentConcurrencyKeyFromQueue(queue: string): string;
  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  orgCurrentConcurrencyKey(env: AuthenticatedEnvironment): string;
  envCurrentConcurrencyKey(env: AuthenticatedEnvironment): string;
  messageKey(messageId: string): string;
  stripKeyPrefix(key: string): string;
}

export type PriorityStrategyChoice = string | { abort: true };

export interface MarQSQueuePriorityStrategy {
  /**
   * chooseQueue is called to select the next queue to process a message from
   *
   * @param queues
   * @param parentQueue
   * @param selectionId
   *
   * @returns The queue to process the message from, or an object with `abort: true` if no queue is available
   */
  chooseQueue(
    queues: Array<QueueWithScores>,
    parentQueue: string,
    selectionId: string
  ): PriorityStrategyChoice;

  /**
   * This function is called to get the next candidate selection for the queue
   * The `range` is used to select the set of queues that will be considered for the next selection (passed to chooseQueue)
   * The `selectionId` is used to identify the selection and should be passed to chooseQueue
   *
   * @param parentQueue The parent queue that holds the candidate queues
   *
   * @returns The scores and the selectionId for the next candidate selection
   */
  nextCandidateSelection(
    parentQueue: string
  ): Promise<{ range: [number, number]; selectionId: string }>;
}

export const MessagePayload = z.object({
  version: z.literal("1"),
  data: z.record(z.unknown()),
  queue: z.string(),
  messageId: z.string(),
  timestamp: z.number(),
  parentQueue: z.string(),
  concurrencyKey: z.string().optional(),
});

export type MessagePayload = z.infer<typeof MessagePayload>;
