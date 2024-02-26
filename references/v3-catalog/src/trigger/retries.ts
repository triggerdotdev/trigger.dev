import { logger, retry, task } from "@trigger.dev/sdk/v3";
import { cache } from "./utils/cache";
import { HttpResponse, http } from "msw";

export const taskWithRetries = task({
  id: "task-with-retries",
  retry: {
    maxAttempts: 10,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  run: async ({ payload, ctx }) => {
    const result = await retry.onThrow(
      async ({ attempt }) => {
        if (attempt < 3) throw new Error("failed");

        return {
          foo: "bar",
        };
      },
      { maxAttempts: 3 }
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

    if (ctx.attempt.number <= 9) {
      throw new Error(`Attempt ${ctx.attempt.number} failed: ${payload}`);
    }

    return {
      result: "success",
      payload,
    };
  },
});

const interceptor = retry.interceptFetch(
  http.get("http://my.host/test-headers", ({ request }) => {
    const retryCount = request.headers.get("x-retry-count");

    if (retryCount === "1") {
      return new HttpResponse(null, {
        status: 429,
        headers: {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.now() + 1000 * 10), // 10 seconds
        },
      });
    }

    return HttpResponse.json({ foo: "bar" });
  }),
  http.get("http://my.host/test-backoff", ({ request }) => {
    const retryCount = request.headers.get("x-retry-count");

    if (retryCount === "10") {
      return HttpResponse.json({ foo: "bar" });
    }

    return new HttpResponse(null, {
      status: 500,
    });
  })
);

export const taskWithFetchRetries = task({
  id: "task-with-fetch-retries",
  middleware: ({ payload, ctx, next }) => {
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
          factor: 1.8,
          minTimeoutInMs: 500,
          maxTimeoutInMs: 30_000,
          randomize: false,
        },
      },
    });

    const json2 = await backoffResponse.json();

    logger.info("Fetched backoff response", { json2 });

    return {
      result: "success",
      payload,
    };
  },
});
