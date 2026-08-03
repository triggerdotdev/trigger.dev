import { describe, expect, it } from "vitest";
import { scopeRequestIdempotencyKey } from "./requestIdempotencyKey";

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

  it("preserves missing request keys", () => {
    expect(scopeRequestIdempotencyKey(undefined, ["env-1", "task-a"])).toBeUndefined();
    expect(scopeRequestIdempotencyKey(null, ["env-1", "task-a"])).toBeNull();
  });
});
