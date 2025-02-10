import { z } from "zod";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";

export type QueueRange = { offset: number; count: number };

export interface MarQSKeyProducer {
  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string): string;

  envConcurrencyLimitKey(envId: string): string;
  envConcurrencyLimitKey(env: AuthenticatedEnvironment): string;

  envCurrentConcurrencyKey(envId: string): string;
  envCurrentConcurrencyKey(env: AuthenticatedEnvironment): string;

  queueKey(orgId: string, envId: string, queue: string, concurrencyKey?: string): string;
  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;

  envQueueKey(env: AuthenticatedEnvironment): string;
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
  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  envQueueKeyFromQueue(queue: string): string;
  messageKey(messageId: string): string;
  nackCounterKey(messageId: string): string;
  stripKeyPrefix(key: string): string;
  orgIdFromQueue(queue: string): string;
  envIdFromQueue(queue: string): string;
}

export interface MarQSFairDequeueStrategy {
  distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<string>>;
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

export interface MessageQueueSubscriber {
  messageEnqueued(message: MessagePayload): Promise<void>;
  messageDequeued(message: MessagePayload): Promise<void>;
  messageAcked(message: MessagePayload): Promise<void>;
  messageNacked(message: MessagePayload): Promise<void>;
  messageReplaced(message: MessagePayload): Promise<void>;
}

export interface VisibilityTimeoutStrategy {
  heartbeat(messageId: string, timeoutInMs: number): Promise<void>;
  cancelHeartbeat(messageId: string): Promise<void>;
}
