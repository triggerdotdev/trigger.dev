import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";

export type QueueRange = { offset: number; count: number };

export type QueueDescriptor = {
  organization: string;
  environment: string;
  name: string;
  concurrencyKey?: string;
  priority?: number;
};

export type MarQSKeyProducerEnv = {
  id: string;
  organizationId: string;
  type: RuntimeEnvironmentType;
};

export interface MarQSKeyProducer {
  queueConcurrencyLimitKey(env: MarQSKeyProducerEnv, queue: string): string;

  envConcurrencyLimitKey(envId: string): string;
  envConcurrencyLimitKey(env: MarQSKeyProducerEnv): string;

  envCurrentConcurrencyKey(envId: string): string;
  envCurrentConcurrencyKey(env: MarQSKeyProducerEnv): string;

  envReserveConcurrencyKey(envId: string): string;

  queueKey(
    orgId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string,
    priority?: number
  ): string;
  queueKey(
    env: MarQSKeyProducerEnv,
    queue: string,
    concurrencyKey?: string,
    priority?: number
  ): string;

  envQueueKey(env: MarQSKeyProducerEnv): string;
  envSharedQueueKey(env: MarQSKeyProducerEnv): string;
  sharedQueueKey(): string;
  sharedQueueScanPattern(): string;
  queueCurrentConcurrencyScanPattern(): string;
  concurrencyLimitKeyFromQueue(queue: string): string;
  currentConcurrencyKeyFromQueue(queue: string): string;
  currentConcurrencyKey(env: MarQSKeyProducerEnv, queue: string, concurrencyKey?: string): string;
  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  envReserveConcurrencyKeyFromQueue(queue: string): string;
  envQueueKeyFromQueue(queue: string): string;
  messageKey(messageId: string): string;
  nackCounterKey(messageId: string): string;
  stripKeyPrefix(key: string): string;
  orgIdFromQueue(queue: string): string;
  envIdFromQueue(queue: string): string;

  queueReserveConcurrencyKeyFromQueue(queue: string): string;
  queueDescriptorFromQueue(queue: string): QueueDescriptor;
}

export type EnvQueues = {
  envId: string;
  queues: string[];
};

export interface MarQSFairDequeueStrategy {
  distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>>;
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

export type EnqueueMessageReserveConcurrencyOptions = {
  messageId: string;
  recursiveQueue: boolean;
};
