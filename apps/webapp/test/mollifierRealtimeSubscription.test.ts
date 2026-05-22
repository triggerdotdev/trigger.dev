import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { isInitialBufferedSubscriptionRequest } from "~/v3/mollifier/mollifierTelemetry.server";

describe("isInitialBufferedSubscriptionRequest", () => {
  // Electric's shape-stream protocol returns a `handle=<shape-id>` in
  // the first response. The SDK echoes that handle on every reconnect /
  // live-poll iteration thereafter. The realtime route logs +
  // increments the mollifier.realtime_subscriptions.buffered counter
  // only on the initial connect (handle absent) so each subscription
  // produces a single observability event instead of one per
  // long-poll round-trip (~20s).
  it("returns true for the SDK's initial GET (no handle param)", () => {
    expect(
      isInitialBufferedSubscriptionRequest(
        "http://localhost:3030/realtime/v1/runs/run_x?log=full&offset=-1",
      ),
    ).toBe(true);
  });

  it("returns false for Electric's reconnects (handle present)", () => {
    expect(
      isInitialBufferedSubscriptionRequest(
        "http://localhost:3030/realtime/v1/runs/run_x?handle=100344308-1779&log=full&offset=0_0",
      ),
    ).toBe(false);
  });

  it("returns false for Electric live-poll reconnects (handle + cursor)", () => {
    expect(
      isInitialBufferedSubscriptionRequest(
        "http://localhost:3030/realtime/v1/runs/run_x?cursor=51020980&handle=100344308&live=true&log=full&offset=0_inf",
      ),
    ).toBe(false);
  });

  it("accepts a URL instance as well as a string", () => {
    const url = new URL("http://localhost:3030/realtime/v1/runs/run_x?log=full");
    expect(isInitialBufferedSubscriptionRequest(url)).toBe(true);
  });
});
