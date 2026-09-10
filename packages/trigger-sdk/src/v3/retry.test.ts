import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { describe, expect, it } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
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
