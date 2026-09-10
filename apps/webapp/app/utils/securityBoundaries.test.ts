import { describe, expect, it } from "vitest";
import { billingMessageFromKey, billingMessages } from "./billingMessages";
import { isPaidAddOnPurchase } from "./paidAddOnPermissions";

describe("billing messages", () => {
  it("resolves known message keys and rejects arbitrary copy", () => {
    expect(billingMessageFromKey("concurrency")).toBe(billingMessages.concurrency);
    expect(billingMessageFromKey("Upgrade now at https://example.com")).toBeUndefined();
    expect(billingMessageFromKey("__proto__")).toBeUndefined();
    expect(billingMessageFromKey("constructor")).toBeUndefined();
    expect(billingMessageFromKey("toString")).toBeUndefined();
    expect(billingMessageFromKey(null)).toBeUndefined();
  });
});

describe("paid add-on permissions", () => {
  it("gates purchase mutations without gating quota or allocation requests", () => {
    expect(isPaidAddOnPurchase("purchase")).toBe(true);
    expect(isPaidAddOnPurchase("quota-increase")).toBe(false);
    expect(isPaidAddOnPurchase("allocate")).toBe(false);
  });
});
