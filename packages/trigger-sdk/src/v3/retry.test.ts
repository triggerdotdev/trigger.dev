import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// Catches: retry.fetch retrying caller-aborted requests, ignoring Request.signal, and sending requests when the signal is already aborted.
describe("retry.fetch abort handling", () => {
  let server: Server;
  let baseURL: string;
  let attempts: number;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    attempts = 0;
    handler = (_req, res) => res.writeHead(200).end("ok");
    server = createServer((req, res) => {
      attempts++;
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects with AbortError and does not retry when init.signal aborts mid-request", async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200).end("ok");
        }
      }, 300);
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(baseURL, {
          signal: controller.signal,
          retry: { timeout: { maxAttempts: 3, minTimeoutInMs: 10, randomize: false } },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(1);
  });

  it("rejects with AbortError and does not retry when Request.signal aborts mid-request", async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200).end("ok");
        }
      }, 300);
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(new Request(baseURL, { signal: controller.signal }), {
          retry: { timeout: { maxAttempts: 3, minTimeoutInMs: 10, randomize: false } },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(1);
  });

  it("rejects without sending a request when init.signal is already aborted", async () => {
    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(baseURL, {
          signal: AbortSignal.abort(),
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(0);
  });

  it("rejects without sending a request when Request.signal is already aborted", async () => {
    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(new Request(baseURL, { signal: AbortSignal.abort() }))
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(0);
  });

  it("uses init.signal instead of Request.signal when both are provided", async () => {
    const controller = new AbortController();

    const response = await runInMockTaskContext(async () => {
      return retry.fetch(new Request(baseURL, { signal: AbortSignal.abort() }), {
        signal: controller.signal,
      });
    });

    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
  });

  it("still retries timeoutInMs aborts when caller signal is not aborted", async () => {
    handler = (_req, res) => {
      if (attempts === 1) {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200).end("slow");
          }
        }, 300);
        return;
      }

      res.writeHead(200).end("ok");
    };

    const controller = new AbortController();

    const response = await runInMockTaskContext(async () => {
      return retry.fetch(baseURL, {
        signal: controller.signal,
        timeoutInMs: 30,
        retry: { timeout: { maxAttempts: 3, minTimeoutInMs: 10, randomize: false } },
      });
    });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("aborts immediately during retry backoff without sending another attempt", async () => {
    handler = (_req, res) => {
      res.writeHead(503).end("unavailable");
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(baseURL, {
          signal: controller.signal,
          retry: {
            byStatus: {
              "5xx": {
                strategy: "backoff",
                maxAttempts: 3,
                minTimeoutInMs: 400,
                randomize: false,
              },
            },
          },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(1);
  });

  it("stops on caller abort during a retry attempt after a timeoutInMs retry", async () => {
    const controller = new AbortController();

    handler = (_req, res) => {
      if (attempts === 2) {
        setTimeout(() => controller.abort(), 10);
      }
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200).end("slow");
        }
      }, 300);
    };

    await runInMockTaskContext(async () => {
      await expect(
        retry.fetch(baseURL, {
          signal: controller.signal,
          timeoutInMs: 40,
          retry: { timeout: { maxAttempts: 4, minTimeoutInMs: 10, randomize: false } },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    expect(attempts).toBe(2);
  });
});
