import { describe, expect, it, vi } from "vitest";
import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";
import {
  createdAtMsBounds,
  deliveryIdsCreatedAtBounds,
  deliveryIdsRetentionDays,
  retentionFloor,
} from "../app/services/webhookDeliveriesRepository/deliveryIdBounds";

function idAt(iso: string, retentionDays = 30): string {
  vi.setSystemTime(new Date(iso));
  return WebhookDeliveryId.generate({ retentionDays }).friendlyId;
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

  it("returns undefined when an id fails to decode, so the caller skips pruning", () => {
    expect(deliveryIdsCreatedAtBounds(["whd_notavaliddeliveryid"])).toBeUndefined();
  });
});

describe("createdAtMsBounds", () => {
  it("returns undefined for an empty set", () => {
    expect(createdAtMsBounds([])).toBeUndefined();
  });

  it("returns a zero-width span for a single value", () => {
    const bounds = createdAtMsBounds([1_000]);
    expect(bounds?.gte.getTime()).toBe(1_000);
    expect(bounds?.lte.getTime()).toBe(1_000);
  });

  it("spans the smallest and largest value regardless of input order", () => {
    const bounds = createdAtMsBounds([50, 10, 30, 90, 40]);
    expect(bounds?.gte.getTime()).toBe(10);
    expect(bounds?.lte.getTime()).toBe(90);
  });

  it("handles a large input without a stack overflow (unlike Math.min(...spread))", () => {
    const values = Array.from({ length: 300_000 }, (_, i) => i);
    const bounds = createdAtMsBounds(values);
    expect(bounds?.gte.getTime()).toBe(0);
    expect(bounds?.lte.getTime()).toBe(299_999);
  });
});

describe("deliveryIdsRetentionDays", () => {
  it("returns each distinct class the ids were minted in", () => {
    const ids = [
      WebhookDeliveryId.generate({ retentionDays: 3 }).friendlyId,
      WebhookDeliveryId.generate({ retentionDays: 90 }).friendlyId,
      WebhookDeliveryId.generate({ retentionDays: 3 }).friendlyId,
    ];
    expect(deliveryIdsRetentionDays(ids)?.sort((a, b) => a - b)).toEqual([3, 90]);
  });

  it("returns undefined when any id carries no class, so the lookup isn't narrowed", () => {
    const v2 = WebhookDeliveryId.generate({ retentionDays: 7 }).friendlyId;
    const v1 = `whd_${WebhookDeliveryId.toId(v2).slice(0, 24)}1`;
    expect(deliveryIdsRetentionDays([v2, v1])).toBeUndefined();
  });
});

describe("retentionFloor", () => {
  it("is the given number of days before now", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    expect(retentionFloor(7, now).toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });
});
