import { describe, it, expect } from "vitest";
import { supportChannelName } from "~/services/supportSlackChannel.server";

describe("supportChannelName", () => {
  it("prefixes cus- and lowercases", () => {
    expect(supportChannelName("Acme-Corp")).toBe("cus-acme-corp");
  });
  it("replaces invalid characters and collapses dashes", () => {
    expect(supportChannelName("acme.co/team!")).toBe("cus-acme-co-team");
  });
  it("caps total length at 80 characters", () => {
    expect(supportChannelName("a".repeat(100)).length).toBe(80);
  });
});
