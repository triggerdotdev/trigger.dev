import { describe, expect, it } from "vitest";
import {
  answerAllCardKeys,
  normalizeEmail,
  PlainCustomerCardRequestSchema,
} from "./plainCustomerCards";

const request = (overrides: Record<string, unknown> = {}) => ({
  cardKeys: ["account-details"],
  customer: { id: "c_1", email: "dev@example.com", externalId: "user_1" },
  ...overrides,
});

describe("PlainCustomerCardRequestSchema", () => {
  it("accepts a fully populated request", () => {
    expect(
      PlainCustomerCardRequestSchema.safeParse(request({ thread: { id: "th_1" } })).success
    ).toBe(true);
  });

  // Plain sends explicit nulls rather than omitting these keys. Rejecting them meant every
  // customer created outside our own writes got a 400 instead of a card.
  it("accepts a null externalId when there is an email", () => {
    const result = PlainCustomerCardRequestSchema.safeParse(
      request({ customer: { id: "c_1", email: "dev@example.com", externalId: null } })
    );

    expect(result.success).toBe(true);
  });

  it("accepts a null email when there is an externalId", () => {
    const result = PlainCustomerCardRequestSchema.safeParse(
      request({ customer: { id: "c_1", email: null, externalId: "user_1" } })
    );

    expect(result.success).toBe(true);
  });

  it("accepts a null thread", () => {
    expect(PlainCustomerCardRequestSchema.safeParse(request({ thread: null })).success).toBe(true);
  });

  it("accepts an omitted thread", () => {
    expect(PlainCustomerCardRequestSchema.safeParse(request()).success).toBe(true);
  });

  it("still requires one of email or externalId", () => {
    const result = PlainCustomerCardRequestSchema.safeParse(
      request({ customer: { id: "c_1", email: null, externalId: null } })
    );

    expect(result.success).toBe(false);
  });

  it("rejects a body with no card keys field", () => {
    expect(PlainCustomerCardRequestSchema.safeParse({ customer: { id: "c_1" } }).success).toBe(
      false
    );
  });
});

// Users are stored with a lowercased, trimmed email, so a lookup on the raw value Plain sends
// would miss a real account whose address differs only in casing or padding.
describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  DEV@Example.COM ")).toBe("dev@example.com");
  });

  it("leaves an already-normalized address alone", () => {
    expect(normalizeEmail("dev@example.com")).toBe("dev@example.com");
  });

  it("is null for absent or empty addresses, so the lookup can be skipped", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });
});

describe("answerAllCardKeys", () => {
  it("adds a no-data card for every unanswered key", () => {
    expect(answerAllCardKeys(["a", "b"], [])).toEqual([
      { key: "a", components: null },
      { key: "b", components: null },
    ]);
  });

  it("leaves answered cards untouched", () => {
    const answered = { key: "a", components: [{ componentText: { text: "hi" } }] };

    expect(answerAllCardKeys(["a"], [answered])).toEqual([answered]);
  });

  it("fills only the gaps, keeping answered cards first", () => {
    const answered = { key: "b", components: [] };

    expect(answerAllCardKeys(["a", "b", "c"], [answered])).toEqual([
      answered,
      { key: "a", components: null },
      { key: "c", components: null },
    ]);
  });

  it("ignores extra cards that were not requested", () => {
    const extra = { key: "unrequested", components: [] };

    expect(answerAllCardKeys([], [extra])).toEqual([extra]);
  });
});
