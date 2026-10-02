import { describe, expect, it } from "vitest";
import { resolveWebhookLimits } from "~/v3/webhookLimits";

const defaults = {
  maxWaitersPerEnvironment: 1_000_000,
  maxWaitersPerEndpoint: 10_000,
  concurrency: 100,
};

describe("resolveWebhookLimits", () => {
  it("uses the defaults when the org sets nothing", () => {
    expect(resolveWebhookLimits(null, defaults)).toEqual({ limits: defaults, overrides: {} });
  });

  it("takes each limit the org's plan sets and defaults the rest", () => {
    expect(
      resolveWebhookLimits({ maxWaitersPerEnvironment: 500, concurrency: 5 }, defaults)
    ).toEqual({
      limits: { maxWaitersPerEnvironment: 500, maxWaitersPerEndpoint: 10_000, concurrency: 5 },
      overrides: { maxWaitersPerEnvironment: 500, concurrency: 5 },
    });
  });

  it("ignores a malformed config rather than applying part of it", () => {
    expect(
      resolveWebhookLimits({ maxWaitersPerEnvironment: -1, concurrency: 5 }, defaults)
    ).toEqual({ limits: defaults, overrides: {} });
  });
});
