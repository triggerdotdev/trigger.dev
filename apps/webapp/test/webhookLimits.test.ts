import { describe, expect, it } from "vitest";
import { resolveWebhookLimits } from "~/v3/webhookLimits";

const defaults = {
  maxWaitersPerEnvironment: 1_000_000,
  maxWaitersPerEndpoint: 10_000,
  concurrency: 100,
  deliveryRetentionDays: 30,
  deliveryStorageDays: 30,
};

describe("resolveWebhookLimits", () => {
  it("uses the defaults when the org sets nothing", () => {
    expect(resolveWebhookLimits(null, defaults)).toEqual({
      limits: { ...defaults, deliveryRetentionStrict: false },
      overrides: {},
    });
  });

  it("takes each limit the org's plan sets and defaults the rest", () => {
    expect(
      resolveWebhookLimits({ maxWaitersPerEnvironment: 500, concurrency: 5 }, defaults)
    ).toEqual({
      limits: {
        maxWaitersPerEnvironment: 500,
        maxWaitersPerEndpoint: 10_000,
        concurrency: 5,
        deliveryRetentionDays: 30,
        deliveryRetentionStrict: false,
        deliveryStorageDays: 30,
      },
      overrides: { maxWaitersPerEnvironment: 500, concurrency: 5 },
    });
  });

  it("ignores a malformed config rather than applying part of it", () => {
    expect(
      resolveWebhookLimits({ maxWaitersPerEnvironment: -1, concurrency: 5 }, defaults)
    ).toEqual({ limits: { ...defaults, deliveryRetentionStrict: false }, overrides: {} });
  });

  it("shows the plan's delivery retention but stores deliveries for at least the default 30 days", () => {
    expect(resolveWebhookLimits({ deliveryRetentionDays: 3 }, defaults).limits).toMatchObject({
      deliveryRetentionDays: 3,
      deliveryRetentionStrict: false,
      deliveryStorageDays: 30,
    });
    expect(resolveWebhookLimits({ deliveryRetentionDays: 60 }, defaults).limits).toMatchObject({
      deliveryRetentionDays: 60,
      deliveryStorageDays: 90,
    });
    expect(resolveWebhookLimits({ deliveryRetentionDays: 365 }, defaults).limits).toMatchObject({
      deliveryStorageDays: 365,
    });
  });

  it("stores deliveries only for the retention, rounded up to a class, when it's strict", () => {
    expect(
      resolveWebhookLimits({ deliveryRetentionDays: 3, deliveryRetentionStrict: true }, defaults)
        .limits
    ).toMatchObject({ deliveryRetentionDays: 3, deliveryStorageDays: 3 });
    expect(
      resolveWebhookLimits({ deliveryRetentionDays: 10, deliveryRetentionStrict: true }, defaults)
        .limits
    ).toMatchObject({ deliveryRetentionDays: 10, deliveryStorageDays: 30 });
  });

  it("never shows more retention than the longest class can store", () => {
    expect(resolveWebhookLimits({ deliveryRetentionDays: 400 }, defaults).limits).toMatchObject({
      deliveryRetentionDays: 365,
      deliveryStorageDays: 365,
    });
  });
});
