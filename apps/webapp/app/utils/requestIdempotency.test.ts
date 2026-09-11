import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scopeRequestIdempotencyHeader, scopeRequestIdempotencyKey } from "./requestIdempotencyKey";

describe("scopeRequestIdempotencyKey", () => {
  it("keeps retries stable within the same environment and task scope", () => {
    expect(scopeRequestIdempotencyKey("request-1", ["env-1", "task-a"])).toBe(
      scopeRequestIdempotencyKey("request-1", ["env-1", "task-a"])
    );
  });

  it("does not share cache entries across environments or tasks", () => {
    const original = scopeRequestIdempotencyKey("request-1", ["env-1", "task-a"]);

    expect(scopeRequestIdempotencyKey("request-1", ["env-1", "task-b"])).not.toBe(original);
    expect(scopeRequestIdempotencyKey("request-1", ["env-2", "task-a"])).not.toBe(original);
  });

  it("skips missing request keys", () => {
    expect(scopeRequestIdempotencyKey(undefined, ["env-1", "task-a"])).toBeUndefined();
    expect(scopeRequestIdempotencyKey(null, ["env-1", "task-a"])).toBeUndefined();
  });
});

describe("scopeRequestIdempotencyHeader", () => {
  it("scopes a v4 UUID header", () => {
    const requestIdempotencyKey = randomUUID();

    expect(scopeRequestIdempotencyHeader(requestIdempotencyKey, ["env-1", "task-a"])).toBe(
      scopeRequestIdempotencyKey(requestIdempotencyKey, ["env-1", "task-a"])
    );
  });

  it("ignores a header that is not a v4 UUID, instead of failing the request", () => {
    for (const requestIdempotencyKey of [
      "not-a-uuid",
      "",
      "00000000-0000-0000-0000-000000000000",
      "1b4e28ba-2fa1-11d2-883f-0016d3cca427", // v1
      `${randomUUID()} `,
    ]) {
      expect(
        scopeRequestIdempotencyHeader(requestIdempotencyKey, ["env-1", "task-a"])
      ).toBeUndefined();
    }
  });

  it("skips missing headers", () => {
    expect(scopeRequestIdempotencyHeader(undefined, ["env-1", "task-a"])).toBeUndefined();
    expect(scopeRequestIdempotencyHeader(null, ["env-1", "task-a"])).toBeUndefined();
  });
});
