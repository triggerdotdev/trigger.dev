import { describe, expect, it } from "vitest";
import {
  isLiveCountTick,
  liveCountScope,
  MAX_LIVE_ENDPOINT_IDS,
} from "~/components/webhookDeliveries/v1/liveCountScope";

const ids = (count: number) => Array.from({ length: count }, (_, i) => `wh_${i}`);

describe("liveCountScope", () => {
  // Catches: a webhook task's page asking the server to find the task's endpoints on every poll,
  // when the page already has them.
  it("sends a task's endpoint ids when they fit in the URL", () => {
    expect(liveCountScope({ webhookTaskSlug: "orders", webhookEndpointIds: ids(3) })).toEqual({
      kind: "endpoints",
      ids: "wh_0,wh_1,wh_2",
      everyTicks: 2,
    });
    expect(
      liveCountScope({ webhookTaskSlug: "orders", webhookEndpointIds: ids(MAX_LIVE_ENDPOINT_IDS) })
        .kind
    ).toBe("endpoints");
  });

  it("asks by task, less often, when the task has more endpoints than fit", () => {
    const scope = liveCountScope({
      webhookTaskSlug: "orders",
      webhookEndpointIds: ids(MAX_LIVE_ENDPOINT_IDS + 1),
    });
    expect(scope).toEqual({ kind: "task", slug: "orders", everyTicks: 10 });
  });

  it("watches nothing for an empty endpoint list, with or without a task", () => {
    expect(liveCountScope({ webhookEndpointIds: [] })).toEqual({ kind: "none" });
    expect(liveCountScope({ webhookTaskSlug: "orders", webhookEndpointIds: [] })).toEqual({
      kind: "none",
    });
  });

  it("counts the whole environment when no endpoints are named", () => {
    expect(liveCountScope({})).toEqual({ kind: "environment", everyTicks: 2 });
  });

  it("sends an endpoint page's own id", () => {
    expect(liveCountScope({ webhookEndpointIds: ["wh_1"] })).toEqual({
      kind: "endpoints",
      ids: "wh_1",
      everyTicks: 2,
    });
  });
});

describe("isLiveCountTick", () => {
  it("counts on the first tick, then every nth", () => {
    const ticks = (every: number) =>
      Array.from({ length: 20 }, (_, i) => i + 1).filter((tick) => isLiveCountTick(tick, every));
    expect(ticks(2)).toEqual([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(ticks(10)).toEqual([1, 10, 20]);
  });
});
