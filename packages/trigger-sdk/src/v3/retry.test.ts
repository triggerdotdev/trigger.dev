import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
  retry,
} from "./retry.js";
import { wait } from "./wait.js";

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

describe("retry.fetch response body lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels retried response bodies and skips cloning when no bodyFilter is configured", async () => {
    vi.spyOn(wait, "until").mockResolvedValue(undefined as never);

    const firstResponse = new Response("temporary outage", { status: 503 });
    const cloneSpy = vi.spyOn(firstResponse, "clone");
    const cancelSpy = vi.spyOn(firstResponse.body!, "cancel");
    const secondResponse = new Response("ok", { status: 200 });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);
    vi.stubGlobal("fetch", fetchMock);

    const result = await retry.fetch("https://example.com/api", {
      retry: {
        byStatus: {
          "503": { strategy: "backoff", maxAttempts: 2, factor: 1, minTimeoutInMs: 1, maxTimeoutInMs: 10 },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toBe("ok");
  });

  it("does not clone or cancel a non-retried response returned to the caller", async () => {
    const notFoundResponse = new Response("missing", { status: 404 });
    const cloneSpy = vi.spyOn(notFoundResponse, "clone");
    const cancelSpy = vi.spyOn(notFoundResponse.body!, "cancel");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(notFoundResponse));

    const result = await retry.fetch("https://example.com/missing");

    expect(result.status).toBe(404);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe("missing");
  });

  it("reads the cloned body once across multiple matching bodyFilter rules and cancels before retry", async () => {
    vi.spyOn(wait, "until").mockResolvedValue(undefined as never);

    const firstResponse = new Response(JSON.stringify({ code: "RETRY_B" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const cloneSpy = vi.spyOn(firstResponse, "clone");
    const secondResponse = new Response("recovered", { status: 200 });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);
    vi.stubGlobal("fetch", fetchMock);

    const result = await retry.fetch("https://example.com/api", {
      retry: {
        byStatus: {
          "500": {
            strategy: "backoff",
            maxAttempts: 2,
            factor: 1,
            minTimeoutInMs: 1,
            maxTimeoutInMs: 10,
            bodyFilter: { code: ["RETRY_A"] },
          },
          "5xx": {
            strategy: "backoff",
            maxAttempts: 2,
            factor: 1,
            minTimeoutInMs: 1,
            maxTimeoutInMs: 10,
            bodyFilter: { code: ["RETRY_B"] },
          },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    const reader = firstResponse.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toBe("recovered");
  });
});
