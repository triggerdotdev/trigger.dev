import { MarQSKeyProducer, MarQSKeyProducerEnv, QueueDescriptor } from "./types";

const constants = {
  SHARED_QUEUE: "sharedQueue",
  SHARED_WORKER_QUEUE: "sharedWorkerQueue",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  DISABLED_CONCURRENCY_LIMIT_PART: "disabledConcurrency",
  ENV_PART: "env",
  ORG_PART: "org",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  MESSAGE_PART: "message",
  RESERVE_CONCURRENCY_PART: "reserveConcurrency",
} as const;

const ORG_REGEX = /org:([^:]+):/;
const ENV_REGEX = /env:([^:]+):/;
const QUEUE_REGEX = /queue:([^:]+)(?::|$)/;
const CONCURRENCY_KEY_REGEX = /ck:([^:]+)(?::|$)/;

export class MarQSShortKeyProducer implements MarQSKeyProducer {
  constructor(private _prefix: string) {}

  sharedQueueScanPattern() {
    return `${this._prefix}*${constants.SHARED_QUEUE}`;
  }

  queueCurrentConcurrencyScanPattern() {
    return `${this._prefix}${constants.ORG_PART}:*:${constants.ENV_PART}:*:queue:*:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  stripKeyPrefix(key: string): string {
    if (key.startsWith(this._prefix)) {
      return key.slice(this._prefix.length);
    }

    return key;
  }

  queueConcurrencyLimitKey(env: MarQSKeyProducerEnv, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(envId: string): string;
  envConcurrencyLimitKey(env: MarQSKeyProducerEnv): string;
  envConcurrencyLimitKey(envOrId: MarQSKeyProducerEnv | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CONCURRENCY_LIMIT_PART,
    ].join(":");
  }

  queueKey(orgId: string, envId: string, queue: string, concurrencyKey?: string): string;
  queueKey(env: MarQSKeyProducerEnv, queue: string, concurrencyKey?: string): string;
  queueKey(
    envOrOrgId: MarQSKeyProducerEnv | string,
    queueOrEnvId: string,
    queueOrConcurrencyKey: string,
    concurrencyKeyOrPriority?: string | number
  ): string {
    if (typeof envOrOrgId === "string") {
      return [
        this.orgKeySection(envOrOrgId),
        this.envKeySection(queueOrEnvId),
        this.queueSection(queueOrConcurrencyKey),
      ]
        .concat(
          typeof concurrencyKeyOrPriority === "string"
            ? this.concurrencyKeySection(concurrencyKeyOrPriority)
            : []
        )
        .join(":");
    } else {
      return [
        this.orgKeySection(envOrOrgId.organizationId),
        this.envKeySection(envOrOrgId.id),
        this.queueSection(queueOrEnvId),
      ]
        .concat(queueOrConcurrencyKey ? this.concurrencyKeySection(queueOrConcurrencyKey) : [])
        .join(":");
    }
  }

  queueKeyFromQueue(queue: string): string {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return this.queueKey(
      descriptor.organization,
      descriptor.environment,
      descriptor.name,
      descriptor.concurrencyKey
    );
  }

  envSharedQueueKey(env: MarQSKeyProducerEnv) {
    if (env.type === "DEVELOPMENT") {
      return [
        this.orgKeySection(env.organizationId),
        this.envKeySection(env.id),
        constants.SHARED_QUEUE,
      ].join(":");
    }

    return this.sharedQueueKey();
  }

  sharedQueueKey(): string {
    return constants.SHARED_QUEUE;
  }

  sharedWorkerQueueKey(): string {
    return constants.SHARED_WORKER_QUEUE;
  }

  queueConcurrencyLimitKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return this.queueConcurrencyLimitKeyFromDescriptor(descriptor);
  }

  queueCurrentConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);
    return this.currentConcurrencyKeyFromDescriptor(descriptor);
  }

  queueReserveConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return this.queueReserveConcurrencyKeyFromDescriptor(descriptor);
  }

  queueCurrentConcurrencyKey(
    env: MarQSKeyProducerEnv,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return `${constants.ENV_PART}:${descriptor.environment}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return `${constants.ENV_PART}:${descriptor.environment}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  envReserveConcurrencyKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return this.envReserveConcurrencyKey(descriptor.environment);
  }

  envReserveConcurrencyKey(envId: string): string {
    return `${constants.ENV_PART}:${this.shortId(envId)}:${constants.RESERVE_CONCURRENCY_PART}`;
  }

  envCurrentConcurrencyKey(envId: string): string;
  envCurrentConcurrencyKey(env: MarQSKeyProducerEnv): string;
  envCurrentConcurrencyKey(envOrId: MarQSKeyProducerEnv | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CURRENT_CONCURRENCY_PART,
    ].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return `${constants.ENV_PART}:${descriptor.environment}:${constants.QUEUE_PART}`;
  }

  envQueueKey(env: MarQSKeyProducerEnv): string {
    return [constants.ENV_PART, this.shortId(env.id), constants.QUEUE_PART].join(":");
  }

  messageKey(messageId: string) {
    return `${constants.MESSAGE_PART}:${messageId}`;
  }

  nackCounterKey(messageId: string): string {
    return `${constants.MESSAGE_PART}:${messageId}:nacks`;
  }

  orgIdFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return descriptor.organization;
  }

  envIdFromQueue(queue: string) {
    const descriptor = this.queueDescriptorFromQueue(queue);

    return descriptor.environment;
  }

  queueDescriptorFromQueue(queue: string): QueueDescriptor {
    const match = queue.match(QUEUE_REGEX);

    if (!match) {
      throw new Error(`Invalid queue: ${queue}, no queue name found`);
    }

    const [, queueName] = match;

    const envMatch = queue.match(ENV_REGEX);

    if (!envMatch) {
      throw new Error(`Invalid queue: ${queue}, no environment found`);
    }

    const [, envId] = envMatch;

    const orgMatch = queue.match(ORG_REGEX);

    if (!orgMatch) {
      throw new Error(`Invalid queue: ${queue}, no organization found`);
    }

    const [, orgId] = orgMatch;

    const concurrencyKeyMatch = queue.match(CONCURRENCY_KEY_REGEX);

    const concurrencyKey = concurrencyKeyMatch ? concurrencyKeyMatch[1] : undefined;

    return {
      name: queueName,
      environment: envId,
      organization: orgId,
      concurrencyKey,
    };
  }

  private shortId(id: string) {
    // Return the last 12 characters of the id
    return id.slice(-12);
  }

  private envKeySection(envId: string) {
    return `${constants.ENV_PART}:${this.shortId(envId)}`;
  }

  private orgKeySection(orgId: string) {
    return `${constants.ORG_PART}:${this.shortId(orgId)}`;
  }

  private queueSection(queue: string) {
    return `${constants.QUEUE_PART}:${queue}`;
  }

  private concurrencyKeySection(concurrencyKey: string) {
    return `${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}`;
  }

  private currentConcurrencyKeyFromDescriptor(descriptor: QueueDescriptor) {
    return [
      this.queueKey(
        descriptor.organization,
        descriptor.environment,
        descriptor.name,
        descriptor.concurrencyKey
      ),
      constants.CURRENT_CONCURRENCY_PART,
    ].join(":");
  }

  private queueReserveConcurrencyKeyFromDescriptor(descriptor: QueueDescriptor) {
    return [
      this.queueKey(descriptor.organization, descriptor.environment, descriptor.name),
      constants.RESERVE_CONCURRENCY_PART,
    ].join(":");
  }

  private queueConcurrencyLimitKeyFromDescriptor(descriptor: QueueDescriptor) {
    return [
      this.queueKey(descriptor.organization, descriptor.environment, descriptor.name),
      constants.CONCURRENCY_LIMIT_PART,
    ].join(":");
  }
}
