import { logger, retry, task, wait } from "@trigger.dev/sdk/v3";
import { cache } from "./utils/cache";
import { interceptor } from "./utils/interceptor";

export const taskWithRetries = task({
  id: "task-with-retries",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: any, { ctx }) => {
    const result = await retry.onThrow(
      async ({ attempt }) => {
        if (attempt < 4) throw new Error("failedd");

        return {
          foo: "bar",
        };
      },
      { maxAttempts: 4, randomize: false, factor: 4 }
    );

    const user = await cache("user", async () => {
      return logger.trace("fetch-user", async (span) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        span.setAttribute("user.id", "1");

        return {
          id: "1",
          name: "John Doe",
          fetchedAt: new Date(),
        };
      });
    });

    logger.info("Fetched user", { user });

    if (ctx.attempt.number <= 2) {
      throw new Error(`Attempt ${ctx.attempt.number} failed: ${payload}`);
    }

    return {
      result: "success",
      payload,
    };
  },
});

export const taskThatErrors = task({
  id: "task-that-errors",
  run: async (payload: any, { ctx }) => {
    connectToDatabase();
  },
});

function connectToDatabase() {
  initializeConnection();
}

function initializeConnection() {
  throw new Error("Access denied. You do not have the necessary permissions.");
}

export const taskWithFetchRetries = task({
  id: "task-with-fetch-retries",
  middleware: (payload: any, { next }) => {
    return interceptor.run(next);
  },
  run: async (payload: any, { ctx }) => {
    logger.info("Fetching data", { foo: [1, 2, 3], bar: [{ hello: "world" }] });

    //if the fetch fails, it will retry
    const headersResponse = await retry.fetch("http://my.host/test-headers", {
      retry: {
        byStatus: {
          "429": {
            strategy: "headers",
            limitHeader: "x-ratelimit-limit",
            remainingHeader: "x-ratelimit-remaining",
            resetHeader: "x-ratelimit-reset",
            resetFormat: "unix_timestamp_in_ms",
          },
        },
      },
    });
    const json = await headersResponse.json();

    logger.info("Fetched headers response", { json });

    const backoffResponse = await retry.fetch("http://my.host/test-backoff", {
      timeoutInMs: 1000,
      retry: {
        byStatus: {
          "500-599": {
            strategy: "backoff",
            maxAttempts: 5,
            factor: 2,
            minTimeoutInMs: 1_000,
            maxTimeoutInMs: 30_000,
            randomize: false,
          },
        },
      },
    });

    const json2 = await backoffResponse.json();

    // This should use the defaults.
    await retry.fetch("http://my.host/test-connection-errors");

    logger.info("Fetched backoff response", { json2 });

    const timeoutResponse = await retry.fetch("https://httpbin.org/delay/2", {
      timeoutInMs: 1000,
      retry: {
        timeout: {
          maxAttempts: 5,
          factor: 1.8,
          minTimeoutInMs: 500,
          maxTimeoutInMs: 30_000,
          randomize: false,
        },
      },
    });

    return {
      result: "successss",
      payload,
      json,
      json2,
    };
  },
});
