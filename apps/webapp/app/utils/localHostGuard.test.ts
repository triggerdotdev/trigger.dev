import { describe, expect, it } from "vitest";
import { checkLocalOrigin, isLocalHost, LOCAL_HOSTS } from "./localHostGuard";

describe("checkLocalOrigin", () => {
  it("accepts every host the Redis and ClickHouse guards accept", () => {
    for (const host of LOCAL_HOSTS) {
      const origin = host === "::1" ? "http://[::1]:3030" : `http://${host}:3030`;
      expect(checkLocalOrigin(origin)).toEqual({ ok: true, origin });
    }
  });

  it("refuses a remote origin, so a seed script can't send an API key off-box", () => {
    expect(checkLocalOrigin("https://cloud.trigger.dev")).toEqual({
      ok: false,
      reason: "non_local",
      hostname: "cloud.trigger.dev",
    });
    expect(checkLocalOrigin("http://10.0.0.7:3030")).toEqual({
      ok: false,
      reason: "non_local",
      hostname: "10.0.0.7",
    });
  });

  // "localhost.attacker.example" and "notlocalhost" both end or start with a local name.
  it("matches the whole hostname, never a prefix or suffix of one", () => {
    expect(checkLocalOrigin("http://localhost.attacker.example").ok).toBe(false);
    expect(checkLocalOrigin("http://notlocalhost:3030").ok).toBe(false);
    expect(isLocalHost("127.0.0.1.attacker.example")).toBe(false);
  });

  it("refuses what it cannot parse rather than passing it through", () => {
    expect(checkLocalOrigin("localhost:3030").ok).toBe(false);
    expect(checkLocalOrigin("").ok).toBe(false);
  });
});
