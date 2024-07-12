import { z } from "zod";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";

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
  size: number;
};

export type QueueRange = { offset: number; count: number };

export interface MarQSKeyProducer {
  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string): string;
  envConcurrencyLimitKey(env: AuthenticatedEnvironment): string;
  orgConcurrencyLimitKey(env: AuthenticatedEnvironment): string;
  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  envSharedQueueKey(env: AuthenticatedEnvironment): string;
  sharedQueueKey(): string;
  sharedQueueScanPattern(): string;
  queueCurrentConcurrencyScanPattern(): string;
  concurrencyLimitKeyFromQueue(queue: string): string;
  currentConcurrencyKeyFromQueue(queue: string): string;
  currentConcurrencyKey(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;
  disabledConcurrencyLimitKeyFromQueue(queue: string): string;
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
   * @param consumerId
   *
   * @returns The queue to process the message from, or an object with `abort: true` if no queue is available
   */
  chooseQueue(
    queues: Array<QueueWithScores>,
    parentQueue: string,
    consumerId: string,
    previousRange: QueueRange
  ): PriorityStrategyChoice;

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

export interface VisibilityTimeoutStrategy {
  heartbeat(messageId: string, timeoutInMs: number): Promise<void>;
  cancelHeartbeat(messageId: string): Promise<void>;
}
