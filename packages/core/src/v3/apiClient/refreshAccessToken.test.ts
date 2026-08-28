import { describe, expect, it } from "vitest";
import { refreshAccessTokenOnce } from "./refreshAccessToken.js";

describe("refreshAccessTokenOnce", () => {
  it("shares one in-flight mint between concurrent callers", async () => {
    let calls = 0;
    let release: (token: string) => void = () => {};
    const refresh = () => {
      calls++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const results = Promise.all([
      refreshAccessTokenOnce(refresh),
      refreshAccessTokenOnce(refresh),
      refreshAccessTokenOnce(refresh),
    ]);
    release("fresh");

    expect(await results).toEqual(["fresh", "fresh", "fresh"]);
    expect(calls).toBe(1);
  });

  it("does not share a mint between different refreshers", async () => {
    const a = async () => "a";
    const b = async () => "b";

    expect(await Promise.all([refreshAccessTokenOnce(a), refreshAccessTokenOnce(b)])).toEqual([
      "a",
      "b",
    ]);
  });

  it("mints again once the previous call has settled", async () => {
    let calls = 0;
    const refresh = async () => `token-${++calls}`;

    expect(await refreshAccessTokenOnce(refresh)).toBe("token-1");
    expect(await refreshAccessTokenOnce(refresh)).toBe("token-2");
  });

  it("rejects every concurrent caller and does not poison later calls", async () => {
    let calls = 0;
    const refresh = async () => {
      calls++;
      if (calls === 1) throw new Error("mint failed");
      return "recovered";
    };

    const first = refreshAccessTokenOnce(refresh);
    const second = refreshAccessTokenOnce(refresh);

    await expect(first).rejects.toThrow("mint failed");
    await expect(second).rejects.toThrow("mint failed");
    expect(calls).toBe(1);

    // The failed mint was evicted, so the next call tries again.
    expect(await refreshAccessTokenOnce(refresh)).toBe("recovered");
    expect(calls).toBe(2);
  });
});
