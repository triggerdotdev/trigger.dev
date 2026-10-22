import { describe, expect, it } from "vitest";
import { ReplayRunData } from "~/v3/replayTask";

describe("ReplayRunData", () => {
  it("leaves the payload unset when the form does not send one", () => {
    const result = ReplayRunData.safeParse({ failedRedirect: "/runs" });

    expect(result.success).toBe(true);
    expect(result.data?.payload).toBeUndefined();
  });

  it("keeps an edited payload", () => {
    const result = ReplayRunData.safeParse({ failedRedirect: "/runs", payload: '{"n":2}' });

    expect(result.success).toBe(true);
    expect(result.data?.payload).toBe('{"n":2}');
  });

  it("rejects a payload that is not JSON", () => {
    const result = ReplayRunData.safeParse({ failedRedirect: "/runs", payload: "{nope" });

    expect(result.success).toBe(false);
  });
});
