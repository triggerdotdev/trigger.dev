import { logger, retry, runs, task, wait } from "@trigger.dev/sdk/v3";
import { cache } from "./utils/cache.js";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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

export const taskWithRateLimitRetries = task({
  id: "task-with-rate-limit-retries",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    factor: 1.8,
  },
  run: async (payload: { runId: string }, { ctx }) => {
    for (let i = 0; i < 100; i++) {
      const { response } = await runs.retrieve(payload.runId).withResponse();

      const limit = response.headers.get("x-ratelimit-limit");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");

      console.log(
        `Rate limit: ${remaining}/${limit} remaining. Reset at ${new Date(
          parseInt(reset!, 10)
        ).toISOString()}`
      );

      if (remaining === "0") {
        // break out of the loop
        break;
      }
    }

    console.log("Rate limit almost breached, triggering child task to test rate limit.");

    // Now we want to trigger a subtask to test the rate limit
    await childTaskWithRateLimitRetries.trigger({ runId: payload.runId });
  },
});

export const childTaskWithRateLimitRetries = task({
  id: "child-task-with-rate-limit-retries",
  run: async (payload: { runId: string }, { ctx }) => {
    return runs.retrieve(payload.runId);
  },
});

export const taskRetriesAfterRateLimitError = task({
  id: "task-retries-after-rate-limit-error",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    factor: 1.8,
  },
  run: async (payload: { runId: string }, { ctx }) => {
    for (let i = 0; i < 100; i++) {
      const { response } = await runs.retrieve(payload.runId).withResponse();

      const limit = response.headers.get("x-ratelimit-limit");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");

      console.log(
        `Rate limit: ${remaining}/${limit} remaining. Reset at ${new Date(
          parseInt(reset!, 10)
        ).toISOString()}`
      );

      if (remaining === "0") {
        // break out of the loop
        break;
      }
    }

    console.log("Rate limit almost breached, triggering child task to test rate limit.");

    // Now we are going to cause a rate limit error to test the retry mechanism
    await runs.retrieve(payload.runId, {
      retry: {
        maxAttempts: 1,
      },
    });
  },
});

export const spamRateLimiter = task({
  id: "spam-rate-limiter",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    factor: 1.8,
  },
  run: async (payload: { runId: string }, { ctx }) => {
    const requestStats = {
      total: 0,
    };

    while (requestStats.total < 100) {
      const { response } = await runs.retrieve(payload.runId).withResponse();

      const remaining = response.headers.get("x-ratelimit-remaining");

      await logRequest("runs/spam-run-test-3", ctx.run.id, remaining!);

      requestStats.total++;
    }

    return requestStats;
  },
});

// Write out a log entry for the request
async function logRequest(dir: string, file: string, remaining: string, ts: Date = new Date()) {
  const log = {
    ts,
    remaining,
  };

  const $dir = join(process.cwd(), dir);

  // Create the dir if it doesn't exist
  await mkdir($dir, { recursive: true });

  // Make sure to swap '/path/to/request/logs/' with an actual directory path
  const filePath = join($dir, `${file}-${log.ts.toISOString()}.json`);
  await writeFile(filePath, JSON.stringify(log, null, 2));
}
