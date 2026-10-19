import { describe, expect, it } from "vitest";
import {
  hasDeliveryListFilters,
  parseDeliveryListFilters,
} from "../app/components/webhookDeliveries/v1/deliveryListFilters.js";

function parse(query: string) {
  return parseDeliveryListFilters(new URLSearchParams(query));
}

describe("parseDeliveryListFilters", () => {
  it("returns no filters for an empty query", () => {
    const filters = parse("");
    expect(filters).toEqual({ statuses: undefined, isTest: undefined, deliveryId: undefined });
    expect(hasDeliveryListFilters(filters)).toBe(false);
  });

  it("reads repeated and comma-separated statuses, deduped, dropping unknown values", () => {
    expect(parse("statuses=SUCCEEDED&statuses=FAILED,SUCCEEDED&statuses=bogus").statuses).toEqual([
      "SUCCEEDED",
      "FAILED",
    ]);
  });

  it("ignores a statuses param with only unknown values", () => {
    expect(parse("statuses=succeeded").statuses).toBeUndefined();
  });

  it("maps a single delivery mode to isTest", () => {
    expect(parse("mode=test").isTest).toBe(true);
    expect(parse("mode=live").isTest).toBe(false);
  });

  it("treats both delivery modes, or none, as no mode filter", () => {
    expect(parse("mode=live&mode=test").isTest).toBeUndefined();
    expect(parse("mode=bogus").isTest).toBeUndefined();
  });

  it("trims the delivery id and drops a blank one", () => {
    expect(parse("deliveryId=%20whd_abc%20").deliveryId).toBe("whd_abc");
    expect(parse("deliveryId=%20%20").deliveryId).toBeUndefined();
  });

  it("counts any single filter as filtered", () => {
    expect(hasDeliveryListFilters(parse("statuses=FILTERED"))).toBe(true);
    expect(hasDeliveryListFilters(parse("mode=live"))).toBe(true);
    expect(hasDeliveryListFilters(parse("deliveryId=abc"))).toBe(true);
  });
});
