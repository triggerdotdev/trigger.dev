import { logger, retry, task } from "@trigger.dev/sdk/v3";
import { cache } from "./utils/cache";
import { interceptor } from "./utils/interceptor";

export const taskWithRetries = task({
  id: "task-with-retries",
  retry: {
    maxAttempts: 4,
  },
  run: async (payload: any, { ctx }) => {
    const result = await retry.onThrow(
      async ({ attempt }) => {
        if (attempt < 3) throw new Error("failedd");

        return {
          foo: "bar",
        };
      },
      { maxAttempts: 3, randomize: false }
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

    if (ctx.attempt.number <= 3) {
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
    throw new Error("failed");
  },
});

export const taskWithFetchRetries = task({
  id: "task-with-fetch-retries",
  middleware: (payload: any, { next }) => {
    return interceptor.run(next);
  },
  run: async ({ payload, ctx }) => {
    //if the fetch fails, it will retry
    const headersResponse = await retry.fetch("http://my.host/test-headers", {
      retry: {
        "429": {
          strategy: "headers",
          limitHeader: "x-ratelimit-limit",
          remainingHeader: "x-ratelimit-remaining",
          resetHeader: "x-ratelimit-reset",
          resetFormat: "unix_timestamp_in_ms",
        },
      },
    });
    const json = await headersResponse.json();

    logger.info("Fetched headers response", { json });

    const backoffResponse = await retry.fetch("http://my.host/test-backoff", {
      retry: {
        "500-599": {
          strategy: "backoff",
          maxAttempts: 10,
          factor: 2,
          minTimeoutInMs: 1_000,
          maxTimeoutInMs: 30_000,
          randomize: false,
        },
      },
    });

    const json2 = await backoffResponse.json();

    logger.info("Fetched backoff response", { json2 });

    const timeoutResponse = await retry.fetch("https://httpbin.org/delay/2", {
      timeout: {
        durationInMs: 1000,
        retry: {
          maxAttempts: 5,
          factor: 1.8,
          minTimeoutInMs: 500,
          maxTimeoutInMs: 30_000,
          randomize: false,
        },
      },
    });

    const json3 = await timeoutResponse.json();

    logger.info("Fetched timeout response", { json3 });

    return {
      result: "successss",
      payload,
      json,
      json2,
      json3,
    };
  },
});
