import { trace } from "@opentelemetry/api";
import { RetryOptions, calculateNextRetryDelay } from "@trigger.dev/core/v3";
import { ConcurrencyLimitGroup, Job, JobVersion } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { PerformRunExecutionV3Service } from "~/services/runs/performRunExecutionV3.server";
import { singleton } from "~/utils/singleton";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { MarQS } from "./index.server";
import { MarQSShortKeyProducer } from "./marqsKeyProducer.server";
import { RequeueV2Message } from "./requeueV2Message.server";
import {
  NoopWeightedChoiceStrategy,
  SimpleWeightedChoiceStrategy,
} from "./simpleWeightedPriorityStrategy.server";
import { VisibilityTimeoutStrategy } from "./types";

const KEY_PREFIX = "marqsv2:";
const SHARED_QUEUE_NAME = "sharedQueue";

export class V2VisibilityTimeout implements VisibilityTimeoutStrategy {
  async heartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    RequeueV2Message.enqueue(messageId, new Date(Date.now() + timeoutInMs));
  }

  async cancelHeartbeat(messageId: string): Promise<void> {
    RequeueV2Message.dequeue(messageId);
  }
}

export class MarQSV2KeyProducer extends MarQSShortKeyProducer {
  constructor(prefix: string) {
    super(prefix);
  }

  envSharedQueueKey(env: AuthenticatedEnvironment) {
    return SHARED_QUEUE_NAME;
  }

  sharedQueueKey(): string {
    return SHARED_QUEUE_NAME;
  }
}

export const marqsv2 = singleton("marqsv2", getMarQSClient);

function getMarQSClient() {
  if (env.V2_MARQS_ENABLED === "0") {
    return;
  }

  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    throw new Error(
      "Could not initialize marqsv2 because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v2 will not work without this."
    );
  }

  const redisOptions = {
    keyPrefix: KEY_PREFIX,
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  return new MarQS({
    verbose: env.V2_MARQS_VERBOSE === "1",
    name: "marqsv2",
    tracer: trace.getTracer("marqsv2"),
    visibilityTimeoutStrategy: new V2VisibilityTimeout(),
    keysProducer: new MarQSV2KeyProducer(KEY_PREFIX),
    queuePriorityStrategy: new SimpleWeightedChoiceStrategy({
      queueSelectionCount: env.V2_MARQS_QUEUE_SELECTION_COUNT,
    }),
    envQueuePriorityStrategy: new NoopWeightedChoiceStrategy(), // We don't use this in v2, since all queues go through the shared queue
    workers: 0,
    redis: redisOptions,
    defaultEnvConcurrency: env.V2_MARQS_DEFAULT_ENV_CONCURRENCY, // this is so we aren't limited by the environment concurrency
    defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
    visibilityTimeoutInMs: env.V2_MARQS_VISIBILITY_TIMEOUT_MS, // 15 minutes
    enableRebalancing: false,
  });
}

export type V2QueueConsumerOptions = {
  pollInterval?: number;
  retryOptions?: RetryOptions;
};

const MessageBody = z.object({
  version: z.literal("v1").default("v1"),
  runId: z.string(),
  attempt: z.number().default(1),
});

export class V2QueueConsumer {
  private _enabled = false;
  private _pollInterval: number;
  private _retryOptions: RetryOptions = {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60000,
    randomize: true,
  };
  private _id: string;

  constructor(private _options: V2QueueConsumerOptions = {}) {
    this._pollInterval = this._options.pollInterval || 1000;
    this._retryOptions = {
      ...this._retryOptions,
      ...this._options.retryOptions,
    };
    this._id = generateFriendlyId("v2-consumer", 6);
  }

  async start(startDelay: number = 0) {
    if (this._enabled) {
      return;
    }

    this._enabled = true;

    // Only putting this here once does not actually delay the start of the consumer (for some reason)
    await new Promise((resolve) => setTimeout(resolve, startDelay));
    await new Promise((resolve) => setTimeout(resolve, startDelay));

    logger.debug(`[marqsv2] Starting V2QueueConsumer`, {
      startDelay,
    });

    return this.#doWork().catch(console.error);
  }

  async stop() {
    if (!this._enabled) {
      return;
    }

    logger.debug("[marqsv2] Stopping V2QueueConsumer");

    this._enabled = false;
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    await this.#doWorkInternal();
  }

  async #doWorkInternal() {
    const message = await marqsv2?.dequeueMessageInSharedQueue(this._id);

    if (!message) {
      setTimeout(() => this.#doWork(), this._pollInterval);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("[marqsv2] Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
      });

      await marqsv2?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), this._pollInterval);
      return;
    }

    logger.debug("[V2QueueConsumer] Received message", {
      messageData: messageBody.data,
    });

    try {
      const service = new PerformRunExecutionV3Service();

      await service.call({
        id: messageBody.data.runId,
        reason: "EXECUTE_JOB",
        isRetry: false,
        lastAttempt: false,
      });
    } catch (error) {
      logger.error("[marqsv2] Failed to execute job", {
        runId: messageBody.data.runId,
        error,
      });

      const attempt = messageBody.data.attempt + 1;

      const retryDelay = calculateNextRetryDelay(this._retryOptions, attempt);

      if (!retryDelay) {
        logger.error("[marqsv2] Job failed after max attempts", {
          runId: messageBody.data.runId,
          attempt,
        });

        await marqsv2?.acknowledgeMessage(message.messageId);
      } else {
        await marqsv2?.nackMessage(message.messageId, Date.now() + retryDelay, {
          attempt,
        });
      }
    } finally {
      setTimeout(() => this.#doWork(), this._pollInterval);
    }
  }
}

interface V2QueueConsumerPoolOptions {
  poolSize: number;
  pollInterval: number;
}

class V2QueueConsumerPool {
  #consumers: V2QueueConsumer[];
  #shuttingDown: boolean = false;

  constructor(private opts: V2QueueConsumerPoolOptions) {
    this.#consumers = Array(opts.poolSize)
      .fill(null)
      .map((_, i) => new V2QueueConsumer({ pollInterval: opts.pollInterval }));

    process.on("SIGTERM", this.#handleSignal.bind(this));
    process.on("SIGINT", this.#handleSignal.bind(this));
  }

  async start() {
    await Promise.allSettled(
      this.#consumers.map((consumer, i) =>
        consumer.start(i * (this.opts.pollInterval / this.opts.poolSize))
      )
    );
  }

  async stop() {
    await Promise.allSettled(this.#consumers.map((consumer) => consumer.stop()));
  }

  async #handleSignal(signal: string) {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;

    logger.debug(`[V2QueueConsumerPool] Received ${signal}, shutting down...`);

    this.stop().finally(() => {
      logger.debug("V2QueueConsumerPool shutdown");
    });
  }
}

export const v2QueueConsumerPool = singleton("v2QueueConsumerPool", initalizePool);

async function initalizePool() {
  if (env.V2_MARQS_ENABLED === "0") {
    return;
  }

  if (env.V2_MARQS_CONSUMER_POOL_ENABLED === "0") {
    return;
  }

  console.log(
    `🎱 Initializing V2QueueConsumerPool (poolSize=${env.V2_MARQS_CONSUMER_POOL_SIZE}, pollInterval=${env.V2_MARQS_CONSUMER_POLL_INTERVAL_MS})`
  );

  const pool = new V2QueueConsumerPool({
    poolSize: env.V2_MARQS_CONSUMER_POOL_SIZE,
    pollInterval: env.V2_MARQS_CONSUMER_POLL_INTERVAL_MS,
  });

  await pool.start();

  return pool;
}

export async function putConcurrencyLimitGroup(
  concurrencyLimitGroup: ConcurrencyLimitGroup,
  env: AuthenticatedEnvironment
): Promise<void> {
  logger.debug(`[marqsv2] Updating concurrency limit group`, {
    concurrencyLimitGroup,
    environment: env,
  });

  await marqsv2?.updateQueueConcurrencyLimits(
    env,
    `group/${concurrencyLimitGroup.name}`,
    concurrencyLimitGroup.concurrencyLimit
  );
}

export async function putJobConcurrencyLimit(
  job: Job,
  version: JobVersion,
  env: AuthenticatedEnvironment
): Promise<void> {
  logger.debug(`[marqsv2] Updating job concurrency limit`, {
    job,
    version,
    environment: env,
  });

  if (typeof version.concurrencyLimit === "number" && version.concurrencyLimit > 0) {
    await marqsv2?.updateQueueConcurrencyLimits(env, `job/${job.slug}`, version.concurrencyLimit);
  } else {
    await marqsv2?.removeQueueConcurrencyLimits(env, `job/${job.slug}`);
  }
}
