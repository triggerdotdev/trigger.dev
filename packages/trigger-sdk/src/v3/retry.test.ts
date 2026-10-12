import { createServer } from "node:http";
import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import type { EventFilter } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
  retry,
} from "./retry.js";

describe("retry fetch telemetry", () => {
  it("omits URL credentials, query parameters, and fragments", () => {
    const attributes = createFetchAttributes(
      "https://user:password@example.com/path?token=secret#fragment"
    );

    expect(attributes[SEMATTRS_HTTP_URL]).toBe("https://example.com/path");
  });

  it("records only explicitly allowed response headers", () => {
    const attributes = createAttributesFromHeaders(
      new Headers({
        authorization: "secret",
        "content-type": "application/json",
        "retry-after": "10",
        "set-cookie": "session=secret",
        "x-api-key": "secret",
        "x-ratelimit-remaining": "9",
      })
    );

    expect(attributes).toEqual({
      "http.response.header.content-type": "application/json",
      "http.response.header.retry-after": "10",
    });
  });

  it("keeps status and content length response diagnostics", () => {
    const attributes = createFetchResponseAttributes(
      new Response(null, {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-length": "123",
          "set-cookie": "session=secret",
        },
      })
    );

    expect(attributes).toMatchObject({
      "http.status_code": 429,
      "http.status_text": "Too Many Requests",
      "http.response_content_length": "123",
      "http.response.header.content-length": "123",
    });
    expect(attributes).not.toHaveProperty("http.response.header.set-cookie");
  });
});

/**
 * Starts a local HTTP server that answers with JSON, and records the `x-retry-count`
 * header of every request it receives (the SDK sends the current attempt number).
 */
async function startJsonServer(
  responder: (requestIndex: number) => { status: number; body: unknown }
) {
  const retryCounts: (string | undefined)[] = [];

  const server = createServer((request, response) => {
    const requestIndex = retryCounts.push(request.headers["x-retry-count"] as string | undefined);

    const { status, body } = responder(requestIndex);

    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to start the retry test server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    retryCounts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Retries a 429 using a `backoff` strategy that waits ~1ms, when the `bodyFilter` matches. */
const fetchWithBodyFilter = (url: string, bodyFilter: EventFilter) =>
  runInMockTaskContext(() =>
    retry.fetch(url, {
      retry: {
        byStatus: {
          "429": {
            strategy: "backoff",
            bodyFilter,
            maxAttempts: 3,
            minTimeoutInMs: 1,
            maxTimeoutInMs: 5,
            factor: 1,
            randomize: false,
          },
        },
      },
    })
  );

describe("retry.fetch bodyFilter", () => {
  it("retries when a nested $exists = false filter matches a body without the parent key", async () => {
    const server = await startJsonServer((requestIndex) =>
      requestIndex === 1
        ? { status: 429, body: { message: "slow down" } }
        : { status: 200, body: { ok: true } }
    );

    try {
      const response = await fetchWithBodyFilter(server.url, {
        error: { retryAfter: [{ $exists: false }] },
      });

      expect(response.status).toBe(200);
      expect(server.retryCounts).toEqual(["1", "2"]);
    } finally {
      await server.close();
    }
  });

  it("does not retry when a nested $exists = false filter has the key in the body", async () => {
    const server = await startJsonServer(() => ({
      status: 429,
      body: { error: { retryAfter: 30 } },
    }));

    try {
      const response = await fetchWithBodyFilter(server.url, {
        error: { retryAfter: [{ $exists: false }] },
      });

      expect(response.status).toBe(429);
      expect(server.retryCounts).toEqual(["1"]);
    } finally {
      await server.close();
    }
  });

  it("does not retry when a nested $exists = true filter has no parent key in the body", async () => {
    const server = await startJsonServer(() => ({
      status: 429,
      body: { message: "slow down" },
    }));

    try {
      const response = await fetchWithBodyFilter(server.url, {
        error: { retryAfter: [{ $exists: true }] },
      });

      expect(response.status).toBe(429);
      expect(server.retryCounts).toEqual(["1"]);
    } finally {
      await server.close();
    }
  });
});
