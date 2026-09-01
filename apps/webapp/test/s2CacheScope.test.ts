import { describe, expect, it } from "vitest";
import { s2CacheScope } from "~/v3/s2CacheScope";

describe("s2CacheScope", () => {
  // Hosted must keep the keys it already has in Redis, or every project takes a needless miss.
  it("adds nothing when no endpoint is configured", () => {
    expect(s2CacheScope(undefined)).toBe("");
  });

  // Redis outlives a restart, so a token issued by the previous S2 service must not be served
  // once the endpoint changes.
  it("gives each endpoint its own namespace", () => {
    const local = s2CacheScope("http://localhost:4566");
    const other = s2CacheScope("http://s2/v1");

    expect(local).not.toBe("");
    expect(local).not.toBe(other);
    expect(local).toBe(s2CacheScope("http://localhost:4566"));
  });
});
