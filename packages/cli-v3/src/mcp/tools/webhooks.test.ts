import { describe, expect, it } from "vitest";
import { formatDelivery, formatDeliveryList } from "./webhooks.js";

const base = {
  id: "whd_1",
  endpoint: { id: "wh_1", declaredId: "payments" },
  status: "succeeded" as const,
  externalDeliveryId: "evt_1",
  isTest: false,
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  processedAt: new Date("2026-09-30T10:00:01.000Z"),
};

describe("formatDeliveryList", () => {
  it("lists deliveries with their endpoint and points at the next page", () => {
    const text = formatDeliveryList([{ ...base, isTest: true }], "cursor_2");
    expect(text).toContain(
      "- whd_1 · succeeded · payments · evt_1 · 2026-09-30T10:00:00.000Z · test"
    );
    expect(text).toContain('cursor "cursor_2"');
  });

  it("says when nothing matches, and keeps the cursor when only this page is empty", () => {
    expect(formatDeliveryList([], undefined)).toBe("No deliveries match.");
    expect(formatDeliveryList([], "cursor_3")).toContain('cursor "cursor_3"');
  });
});

describe("formatDelivery", () => {
  it("shows each target's outcome, the waiter summary, the event and the headers", () => {
    const text = formatDelivery({
      ...base,
      idempotencyKey: "evt_1",
      event: { id: "evt_1", type: "checkout.session.completed" },
      headers: { "user-agent": "Stripe/1.0", accept: "*/*" },
      rawBodyHash: null,
      error: null,
      filterReason: null,
      updatedAt: base.processedAt,
      targets: [
        {
          id: "orders",
          type: "task",
          status: "succeeded",
          reason: null,
          error: null,
          runId: "run_1",
          sessionId: null,
          waiters: null,
        },
        {
          id: "refunds",
          type: "task",
          status: "filtered",
          reason: 'event.type is "checkout.session.completed"',
          error: null,
          runId: null,
          sessionId: null,
          waiters: null,
        },
        {
          id: "waiters",
          type: "waiter",
          status: "succeeded",
          reason: null,
          error: null,
          runId: null,
          sessionId: null,
          waiters: { matched: 2, resumed: 2, failed: 0 },
        },
      ],
    });

    expect(text).toContain("Endpoint: payments (wh_1)");
    expect(text).toContain("- orders (task) · succeeded · run run_1");
    expect(text).toContain(
      '- refunds (task) · filtered · event.type is "checkout.session.completed"'
    );
    expect(text).toContain("- waiting runs · succeeded · 2 of 2 waiting runs resumed, 0 failed");
    expect(text).toContain('"type": "checkout.session.completed"');
    expect(text.indexOf("- accept: */*")).toBeLessThan(text.indexOf("- user-agent: Stripe/1.0"));
  });

  it("truncates a large event", () => {
    const text = formatDelivery({
      ...base,
      idempotencyKey: "evt_1",
      event: { blob: "x".repeat(10_000) },
      headers: null,
      rawBodyHash: null,
      error: "Session key resolved empty: {event.customer}",
      filterReason: null,
      updatedAt: base.processedAt,
      targets: [],
    });

    expect(text).toContain("Error: Session key resolved empty: {event.customer}");
    expect(text).toContain("No subscribers or waiters to route to.");
    expect(text).toContain("… (truncated)");
    expect(text.length).toBeLessThan(5_000);
  });
});
