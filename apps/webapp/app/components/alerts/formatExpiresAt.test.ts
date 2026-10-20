import { describe, expect, it } from "vitest";
import { formatExpiresAt } from "./formatExpiresAt";

describe("formatExpiresAt", () => {
  it("renders em dash when expiresAt is null", () => {
    expect(formatExpiresAt(null)).toBe("–");
  });

  it("renders plain text countdown for future dates", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(futureDate);
    expect(result).toMatch(/^in \d+/);
    expect(result).not.toContain("RelativeDateTime");
    expect(result).not.toMatch(/<time/);
  });

  it("renders expired text for past dates", () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(pastDate);
    expect(result).toMatch(/^expired .* ago$/);
  });

  it("fails when result contains time component formatting", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(futureDate);
    expect(result).not.toContain("T");
    expect(result).not.toMatch(/RelativeDateTime/);
  });
});
