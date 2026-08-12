import { describe, expect, it } from "vitest";
import {
  answerAllCardKeys,
  emailLookupCandidates,
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

  // A contact created by an integration can have neither identifier. There's nothing to look up,
  // but rejecting it would make Plain record an integration error rather than hide the card.
  it("accepts a customer with neither email nor externalId", () => {
    const result = PlainCustomerCardRequestSchema.safeParse(
      request({ customer: { id: "c_1", email: null, externalId: null } })
    );

    expect(result.success).toBe(true);
  });

  it("rejects a body with no card keys field", () => {
    expect(PlainCustomerCardRequestSchema.safeParse({ customer: { id: "c_1" } }).success).toBe(
      false
    );
  });
});

// `User.email` casing depends on the signup path: the SSO upsert lowercases, magic-link and OAuth
// store what the provider gave. Either candidate alone misses one of those populations.
describe("emailLookupCandidates", () => {
  it("tries the address as sent before its lowercased form", () => {
    // Finds a magic-link user stored with capitals, then an SSO user stored lowercased.
    expect(emailLookupCandidates("Dev@Example.com")).toEqual([
      "Dev@Example.com",
      "dev@example.com",
    ]);
  });

  it("yields a single candidate when the address is already lowercase", () => {
    expect(emailLookupCandidates("dev@example.com")).toEqual(["dev@example.com"]);
  });

  it("trims before comparing, so padding doesn't produce a duplicate candidate", () => {
    expect(emailLookupCandidates("  dev@example.com  ")).toEqual(["dev@example.com"]);
  });

  it("is empty for absent or blank addresses, so the lookup can be skipped", () => {
    expect(emailLookupCandidates(null)).toEqual([]);
    expect(emailLookupCandidates(undefined)).toEqual([]);
    expect(emailLookupCandidates("")).toEqual([]);
    expect(emailLookupCandidates("   ")).toEqual([]);
  });
});

describe("answerAllCardKeys", () => {
  it("adds a no-data card for every unanswered key", () => {
    expect(answerAllCardKeys(["a", "b"], [])).toEqual([
      { key: "a", components: null, timeToLiveSeconds: 60 },
      { key: "b", components: null, timeToLiveSeconds: 60 },
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
      { key: "a", components: null, timeToLiveSeconds: 60 },
      { key: "c", components: null, timeToLiveSeconds: 60 },
    ]);
  });

  // Omitting the TTL would fall back to the card's configured default, keeping an empty card in
  // Plain's cache after the customer becomes resolvable.
  it("caps how long an empty card is cached", () => {
    const [filler] = answerAllCardKeys(["a"], []);

    expect(filler).toMatchObject({ timeToLiveSeconds: 60 });
  });

  it("ignores extra cards that were not requested", () => {
    const extra = { key: "unrequested", components: [] };

    expect(answerAllCardKeys([], [extra])).toEqual([extra]);
  });
});
