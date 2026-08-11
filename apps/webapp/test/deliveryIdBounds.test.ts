import { describe, expect, it, vi } from "vitest";
import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";
import { deliveryIdsCreatedAtBounds } from "../app/services/webhookDeliveriesRepository/deliveryIdBounds";

function idAt(iso: string): string {
  vi.setSystemTime(new Date(iso));
  return WebhookDeliveryId.generate().friendlyId;
}

describe("deliveryIdsCreatedAtBounds", () => {
  it("returns undefined for an empty set", () => {
    expect(deliveryIdsCreatedAtBounds([])).toBeUndefined();
  });

  it("returns a zero-width span for a single id (gte == lte == its mint time)", () => {
    vi.useFakeTimers();
    try {
      const at = "2026-08-11T10:00:00.000Z";
      const friendlyId = idAt(at);
      const bounds = deliveryIdsCreatedAtBounds([friendlyId]);
      expect(bounds?.gte.toISOString()).toBe(at);
      expect(bounds?.lte.toISOString()).toBe(at);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spans the earliest and latest mint times across ids, regardless of input order", () => {
    vi.useFakeTimers();
    try {
      const early = idAt("2026-08-09T00:00:00.000Z");
      const mid = idAt("2026-08-10T12:00:00.000Z");
      const late = idAt("2026-08-11T23:59:59.000Z");
      const bounds = deliveryIdsCreatedAtBounds([mid, late, early]);
      expect(bounds?.gte.toISOString()).toBe("2026-08-09T00:00:00.000Z");
      expect(bounds?.lte.toISOString()).toBe("2026-08-11T23:59:59.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined when any id is legacy (non-time-encoded), so the caller skips pruning", () => {
    vi.useFakeTimers();
    try {
      const v1 = idAt("2026-08-11T10:00:00.000Z");
      expect(deliveryIdsCreatedAtBounds([v1, "whd_legacycuidstyleid"])).toBeUndefined();
      expect(deliveryIdsCreatedAtBounds(["whd_legacycuidstyleid"])).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
