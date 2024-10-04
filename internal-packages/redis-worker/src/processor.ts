import { Logger } from "@trigger.dev/core/logger";
import { SimpleQueue } from "./queue.js";

//todo can we dequeue multiple items at once, pass in the number of items to dequeue.
//todo use Node workers so we make the most of the cores?

import { MessageCatalogKey, MessageCatalogSchema, MessageCatalogValue } from "./queue.js";

type QueueProcessorOptions<TMessageCatalog extends MessageCatalogSchema> = {
  timeout?: number;
  retry?: {
    delay?: {
      initial?: number;
      max?: number;
      factor?: number;
    };
    maxAttempts?: number;
  };
  logger?: Logger;
  onItem: (
    id: string,
    job: MessageCatalogKey<TMessageCatalog>,
    item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>
  ) => Promise<void>;
  shutdownTimeMs?: number;
};

const defaultRetryOptions = {
  delay: {
    initial: 1000,
    max: 10000,
    factor: 2,
  },
  maxAttempts: 10,
};

export function createQueueProcessor<TMessageCatalog extends MessageCatalogSchema>(
  queue: SimpleQueue<TMessageCatalog>,
  options: QueueProcessorOptions<TMessageCatalog>
) {
  let { timeout = 1000, onItem, logger = new Logger("QueueProcessor", "debug") } = options;

  const retry = deepMerge(defaultRetryOptions, options.retry ?? {});

  const failures = new Map<string, number>();
  let isRunning = false;

  let shutdown = false;
  const shutdownTimeMs = options.shutdownTimeMs ?? 5000; // Default to 5 seconds

  async function processQueue() {
    if (!isRunning || shutdown) return;

    try {
      const result = await queue.dequeue(1);
      if (result && result.length > 0) {
        const { id, job, item } = result[0];
        try {
          await onItem(id, job, item);
        } catch (error) {
          logger.warn("Error processing item:", { error, id, job, item, queue: queue.name });

          const retryCount = failures.get(id) || 0;
          if (retryCount >= retry.maxAttempts) {
            logger.error(`QueueProcessor: max attempts reached for item ${id}`, {
              queue: queue.name,
              id,
              job,
              item,
            });
            return;
          }

          //requeue with delay
          const delay = Math.min(
            retry.delay.initial * Math.pow(retry.delay.factor, retryCount),
            retry.delay.max
          );
          logger.log(`QueueProcessor: requeueing item`, {
            item,
            id,
            job,
            delay,
            queue: queue.name,
          });
          await queue.enqueue({ id, job, item, availableAt: new Date(Date.now() + delay) });

          failures.set(id, retryCount + 1);
        }
        // Continue processing immediately if still running and not shutting down
        if (isRunning && !shutdown) {
          setImmediate(processQueue);
        }
      } else {
        // No item found, wait before checking again if still running and not shutting down
        if (isRunning && !shutdown) {
          setTimeout(processQueue, timeout);
        }
      }
    } catch (error) {
      logger.error("Error processing queue:", { error });
      if (!shutdown) {
        setTimeout(processQueue, timeout);
      }
    }
  }

  function handleProcessSignal(signal: string) {
    if (shutdown) {
      return;
    }

    shutdown = true;

    logger.debug(
      `Received ${signal}, shutting down QueueProcessor for ${queue.name} with shutdown time ${shutdownTimeMs}ms`
    );

    setTimeout(() => {
      logger.debug(`Shutdown timeout of ${shutdownTimeMs}ms reached, exiting process`);
      process.exit(0);
    }, shutdownTimeMs);
  }

  process.on("SIGTERM", handleProcessSignal);
  process.on("SIGINT", handleProcessSignal);

  return {
    start: () => {
      if (!isRunning) {
        logger.log("Starting queue processor...");
        isRunning = true;
        processQueue();
      } else {
        logger.log("Queue processor is already running.");
      }
    },
    stop: () => {
      if (isRunning) {
        logger.log("Stopping queue processor...");
        isRunning = false;
      } else {
        logger.log("Queue processor is already stopped.");
      }
    },
  };
}

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

function isObject(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  if (!isObject(target) || !isObject(source)) {
    return source as T;
  }

  const output = { ...target } as T;

  (Object.keys(source) as Array<keyof T>).forEach((key) => {
    if (key in target) {
      const targetValue = target[key];
      const sourceValue = source[key];

      if (isObject(targetValue) && isObject(sourceValue)) {
        (output as any)[key] = deepMerge(
          targetValue,
          sourceValue as DeepPartial<typeof targetValue>
        );
      } else if (sourceValue !== undefined) {
        (output as any)[key] = sourceValue;
      }
    } else if (source[key as keyof DeepPartial<T>] !== undefined) {
      (output as any)[key] = source[key as keyof DeepPartial<T>];
    }
  });

  return output;
}
