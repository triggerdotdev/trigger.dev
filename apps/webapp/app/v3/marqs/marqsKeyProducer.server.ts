import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { MarQSKeyProducer } from "./types";

const constants = {
  SHARED_QUEUE: "sharedQueue",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  DISABLED_CONCURRENCY_LIMIT_PART: "disabledConcurrency",
  ENV_PART: "env",
  ORG_PART: "org",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  MESSAGE_PART: "message",
} as const;

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

  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(env: AuthenticatedEnvironment) {
    return [this.envKeySection(env.id), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  orgConcurrencyLimitKey(env: AuthenticatedEnvironment) {
    return [this.orgKeySection(env.organizationId), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string) {
    return [
      this.orgKeySection(env.organizationId),
      this.envKeySection(env.id),
      this.queueSection(queue),
    ]
      .concat(concurrencyKey ? this.concurrencyKeySection(concurrencyKey) : [])
      .join(":");
  }

  envSharedQueueKey(env: AuthenticatedEnvironment) {
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

  concurrencyLimitKeyFromQueue(queue: string) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");

    return `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  currentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  currentConcurrencyKey(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  disabledConcurrencyLimitKeyFromQueue(queue: string) {
    const orgId = this.normalizeQueue(queue).split(":")[1];

    return `${constants.ORG_PART}:${orgId}:${constants.DISABLED_CONCURRENCY_LIMIT_PART}`;
  }

  orgConcurrencyLimitKeyFromQueue(queue: string) {
    const orgId = this.normalizeQueue(queue).split(":")[1];

    return `${constants.ORG_PART}:${orgId}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  orgCurrentConcurrencyKeyFromQueue(queue: string) {
    const orgId = this.normalizeQueue(queue).split(":")[1];

    return `${constants.ORG_PART}:${orgId}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  orgCurrentConcurrencyKey(env: AuthenticatedEnvironment): string {
    return [this.orgKeySection(env.organizationId), constants.CURRENT_CONCURRENCY_PART].join(":");
  }

  envCurrentConcurrencyKey(env: AuthenticatedEnvironment): string {
    return [this.envKeySection(env.id), constants.CURRENT_CONCURRENCY_PART].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.QUEUE_PART}`;
  }

  envQueueKey(env: AuthenticatedEnvironment): string {
    return [constants.ENV_PART, this.shortId(env.id), constants.QUEUE_PART].join(":");
  }

  messageKey(messageId: string) {
    return `${constants.MESSAGE_PART}:${messageId}`;
  }

  nackCounterKey(messageId: string): string {
    return `${constants.MESSAGE_PART}:${messageId}:nacks`;
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

  // This removes the leading prefix from the queue name if it exists
  private normalizeQueue(queue: string) {
    if (queue.startsWith(this._prefix)) {
      return queue.slice(this._prefix.length);
    }

    return queue;
  }
}
