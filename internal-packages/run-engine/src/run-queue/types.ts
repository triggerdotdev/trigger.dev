import { z } from "zod";
import { RuntimeEnvironmentType } from "../../../database/src/index.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";

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
  attempt: z.number(),
});
export type InputPayload = z.infer<typeof InputPayload>;

export const OutputPayload = InputPayload.extend({
  version: z.literal("1"),
  masterQueues: z.string().array(),
});
export type OutputPayload = z.infer<typeof OutputPayload>;

export type QueueDescriptor = {
  orgId: string;
  projectId: string;
  envId: string;
  queue: string;
  concurrencyKey: string | undefined;
};

export type EnvDescriptor = {
  orgId: string;
  projectId: string;
  envId: string;
};

export interface RunQueueKeyProducer {
  //queue
  queueKey(env: MinimalAuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  envQueueKey(env: MinimalAuthenticatedEnvironment): string;
  envQueueKeyFromQueue(queue: string): string;
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
  envCurrentConcurrencyKey(env: EnvDescriptor): string;
  envCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;

  envConcurrencyLimitKey(env: EnvDescriptor): string;
  envConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment): string;

  envReserveConcurrencyKey(env: EnvDescriptor): string;
  envReserveConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;

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
  orgIdFromQueue(queue: string): string;
  envIdFromQueue(queue: string): string;
  projectIdFromQueue(queue: string): string;
  descriptorFromQueue(queue: string): QueueDescriptor;
}

export type EnvQueues = {
  envId: string;
  queues: string[];
};

export interface RunQueueFairDequeueStrategy {
  distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>>;
}
