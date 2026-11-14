import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
  retry,
} from "./retry.js";

vi.mock("./wait.js", () => ({
  wait: {
    until: vi.fn(async () => undefined),
  },
}));

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

describe("retry.fetch abort signal", () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  beforeEach(() => {
    fetchCount = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects immediately when init.signal is already aborted", async () => {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("ok");
    }) as typeof fetch;

    await expect(retry.fetch("https://example.com", { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchCount).toBe(0);
  });

  it("rejects when a Request input carries an already-aborted signal", async () => {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("ok");
    }) as typeof fetch;

    await expect(
      retry.fetch(new Request("https://example.com", { signal: AbortSignal.abort() }))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchCount).toBe(0);
  });

  it("does not retry when the caller aborts mid-request", async () => {
    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }

        if (signal.aborted) {
          const error = new Error("This operation was aborted.");
          error.name = "AbortError";
          reject(error);
          return;
        }

        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("This operation was aborted.");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = retry.fetch("https://example.com/slow", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchCount).toBe(1);
  });
});
