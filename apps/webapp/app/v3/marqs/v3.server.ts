import { trace } from "@opentelemetry/api";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { MarQSShortKeyProducer } from "./marqsKeyProducer.server";
import { MarQS } from "./queue.server";
import { SimpleWeightedChoiceStrategy } from "./simpleWeightedPriorityStrategy.server";
import { V3VisibilityTimeout } from "./v3VisibilityTimeout.server";

const KEY_PREFIX = "marqs:";

export const marqsv3 = singleton("marqsv3", getMarQSClient);

function getMarQSClient() {
  if (env.V3_ENABLED) {
    if (env.REDIS_HOST && env.REDIS_PORT) {
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
        name: "marqs",
        tracer: trace.getTracer("marqs"),
        keysProducer: new MarQSShortKeyProducer(KEY_PREFIX),
        visibilityTimeoutStrategy: new V3VisibilityTimeout(),
        queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
        envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
        workers: 1,
        redis: redisOptions,
        defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
        defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
        defaultParentQueueConcurrency: env.DEFAULT_PARENT_QUEUE_EXECUTION_CONCURRENCY_LIMIT,
        visibilityTimeoutInMs: 120 * 1000, // 2 minutes,
        enableRebalancing: !env.MARQS_DISABLE_REBALANCING,
        verbose: false,
      });
    } else {
      console.warn(
        "Could not initialize MarQS because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v3 will not work without this."
      );
    }
  }
}
