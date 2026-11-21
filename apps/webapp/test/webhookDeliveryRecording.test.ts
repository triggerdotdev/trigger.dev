import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
import { isDeliveryStillBeingRecorded } from "~/v3/webhookDeliveryRecording";

const now = new Date("2026-11-20T06:00:00.000Z");

function deliveryMintedAt(timestamp: Date) {
  return WebhookDeliveryId.generate({ retentionDays: 30, timestamp }).friendlyId;
}

describe("isDeliveryStillBeingRecorded", () => {
  // Catches: replaying a delivery from the dashboard landing on "Delivery not available". The
  // replay redirects to the new delivery before its row is written, and the page has to tell
  // that apart from a delivery that aged out.
  it("is true for a delivery minted moments ago", () => {
    expect(isDeliveryStillBeingRecorded(deliveryMintedAt(new Date(now.getTime() - 200)), now)).toBe(
      true
    );
  });

  it("is false once the delivery had long enough to be saved", () => {
    expect(
      isDeliveryStillBeingRecorded(deliveryMintedAt(new Date(now.getTime() - 5 * 60_000)), now)
    ).toBe(false);
  });

  it("is false for an id that isn't a delivery id", () => {
    expect(isDeliveryStillBeingRecorded("whd_not-a-delivery", now)).toBe(false);
  });
});
