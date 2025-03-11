import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { EnvDescriptor, QueueDescriptor, RunQueueKeyProducer } from "./types.js";

const constants = {
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  DISABLED_CONCURRENCY_LIMIT_PART: "disabledConcurrency",
  ENV_PART: "env",
  ORG_PART: "org",
  PROJECT_PART: "proj",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  TASK_PART: "task",
  MESSAGE_PART: "message",
  RESERVE_CONCURRENCY_PART: "reserveConcurrency",
  DEAD_LETTER_QUEUE_PART: "deadLetter",
} as const;

export class RunQueueFullKeyProducer implements RunQueueKeyProducer {
  queueConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(env: EnvDescriptor): string;
  envConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment): string;
  envConcurrencyLimitKey(envOrDescriptor: EnvDescriptor | MinimalAuthenticatedEnvironment): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CONCURRENCY_LIMIT_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CONCURRENCY_LIMIT_PART,
      ].join(":");
    }
  }

  queueKey(
    orgId: string,
    projId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string
  ): string;
  queueKey(env: MinimalAuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  queueKey(
    envOrOrgId: MinimalAuthenticatedEnvironment | string,
    projIdOrQueue: string,
    envIdConcurrencyKey?: string,
    queue?: string,
    concurrencyKey?: string
  ): string {
    if (typeof envOrOrgId !== "string") {
      return [
        this.orgKeySection(envOrOrgId.organization.id),
        this.projKeySection(envOrOrgId.project.id),
        this.envKeySection(envOrOrgId.id),
        this.queueSection(projIdOrQueue),
      ]
        .concat(envIdConcurrencyKey ? this.concurrencyKeySection(envIdConcurrencyKey) : [])
        .join(":");
    }

    return [
      this.orgKeySection(envOrOrgId),
      this.projKeySection(projIdOrQueue),
      this.envKeySection(envIdConcurrencyKey!),
      this.queueSection(queue!),
    ]
      .concat(concurrencyKey ? this.concurrencyKeySection(concurrencyKey) : [])
      .join(":");
  }

  envQueueKey(env: MinimalAuthenticatedEnvironment) {
    return [this.orgKeySection(env.organization.id), this.envKeySection(env.id)].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const { orgId, envId } = this.descriptorFromQueue(queue);
    return [this.orgKeySection(orgId), this.envKeySection(envId)].join(":");
  }

  concurrencyLimitKeyFromQueue(queue: string) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");
    return `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  currentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  currentConcurrencyKey(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  reserveConcurrencyKey(env: MinimalAuthenticatedEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.RESERVE_CONCURRENCY_PART].join(":");
  }

  disabledConcurrencyLimitKeyFromQueue(queue: string) {
    const { orgId } = this.descriptorFromQueue(queue);
    return `{${constants.ORG_PART}:${orgId}}:${constants.DISABLED_CONCURRENCY_LIMIT_PART}`;
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const { orgId, projectId, envId } = this.descriptorFromQueue(queue);

    return this.envConcurrencyLimitKey({
      orgId,
      projectId,
      envId,
    });
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const { orgId, envId, projectId } = this.descriptorFromQueue(queue);

    return this.envCurrentConcurrencyKey({
      orgId,
      projectId,
      envId,
    });
  }

  envCurrentConcurrencyKey(env: EnvDescriptor): string;
  envCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;
  envCurrentConcurrencyKey(
    envOrDescriptor: EnvDescriptor | MinimalAuthenticatedEnvironment
  ): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CURRENT_CONCURRENCY_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CURRENT_CONCURRENCY_PART,
      ].join(":");
    }
  }

  envReserveConcurrencyKey(env: EnvDescriptor): string;
  envReserveConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;
  envReserveConcurrencyKey(
    envOrDescriptor: EnvDescriptor | MinimalAuthenticatedEnvironment
  ): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.RESERVE_CONCURRENCY_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.RESERVE_CONCURRENCY_PART,
      ].join(":");
    }
  }

  taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(queue: string) {
    const { orgId, envId, projectId } = this.descriptorFromQueue(queue);

    return `${[
      this.orgKeySection(orgId),
      this.projKeySection(projectId),
      this.envKeySection(envId),
      constants.TASK_PART,
    ]
      .filter(Boolean)
      .join(":")}:`;
  }

  taskIdentifierCurrentConcurrencyKeyFromQueue(queue: string, taskIdentifier: string) {
    return `${this.taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(queue)}${taskIdentifier}`;
  }

  taskIdentifierCurrentConcurrencyKey(
    env: MinimalAuthenticatedEnvironment,
    taskIdentifier: string
  ): string {
    return [
      this.orgKeySection(env.organization.id),
      this.projKeySection(env.project.id),
      this.envKeySection(env.id),
      constants.TASK_PART,
      taskIdentifier,
    ].join(":");
  }

  projectCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string {
    return [
      this.orgKeySection(env.organization.id),
      this.projKeySection(env.project.id),
      constants.CURRENT_CONCURRENCY_PART,
    ].join(":");
  }

  projectCurrentConcurrencyKeyFromQueue(queue: string): string {
    const { orgId, projectId } = this.descriptorFromQueue(queue);
    return `${this.orgKeySection(orgId)}:${this.projKeySection(projectId)}:${
      constants.CURRENT_CONCURRENCY_PART
    }`;
  }

  messageKeyPrefixFromQueue(queue: string) {
    const { orgId } = this.descriptorFromQueue(queue);
    return `${this.orgKeySection(orgId)}:${constants.MESSAGE_PART}:`;
  }

  messageKey(orgId: string, messageId: string) {
    return [this.orgKeySection(orgId), `${constants.MESSAGE_PART}:${messageId}`]
      .filter(Boolean)
      .join(":");
  }

  orgIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).orgId;
  }

  envIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).envId;
  }

  projectIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).projectId;
  }

  reserveConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.descriptorFromQueue(queue);

    return this.queueReserveConcurrencyKeyFromDescriptor(descriptor);
  }

  envReserveConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.descriptorFromQueue(queue);

    return this.envReserveConcurrencyKey(descriptor);
  }
  deadLetterQueueKey(env: MinimalAuthenticatedEnvironment): string;
  deadLetterQueueKey(env: EnvDescriptor): string;
  deadLetterQueueKey(envOrDescriptor: EnvDescriptor | MinimalAuthenticatedEnvironment): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.DEAD_LETTER_QUEUE_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.DEAD_LETTER_QUEUE_PART,
      ].join(":");
    }
  }
  deadLetterQueueKeyFromQueue(queue: string): string {
    const descriptor = this.descriptorFromQueue(queue);

    return this.deadLetterQueueKey(descriptor);
  }

  private queueReserveConcurrencyKeyFromDescriptor(descriptor: QueueDescriptor) {
    return [
      this.queueKey(descriptor.orgId, descriptor.projectId, descriptor.envId, descriptor.queue),
      constants.RESERVE_CONCURRENCY_PART,
    ].join(":");
  }

  descriptorFromQueue(queue: string): QueueDescriptor {
    const parts = queue.split(":");
    return {
      orgId: parts[1].replace("{", "").replace("}", ""),
      projectId: parts[3],
      envId: parts[5],
      queue: parts[7],
      concurrencyKey: parts.at(9),
    };
  }

  private envKeySection(envId: string) {
    return `${constants.ENV_PART}:${envId}`;
  }

  private projKeySection(projId: string) {
    return `${constants.PROJECT_PART}:${projId}`;
  }

  private orgKeySection(orgId: string) {
    return `{${constants.ORG_PART}:${orgId}}`;
  }

  private queueSection(queue: string) {
    return `${constants.QUEUE_PART}:${queue}`;
  }

  private concurrencyKeySection(concurrencyKey: string) {
    return `${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}`;
  }

  private taskIdentifierSection(taskIdentifier: string) {
    return `${constants.TASK_PART}:${taskIdentifier}`;
  }
}
