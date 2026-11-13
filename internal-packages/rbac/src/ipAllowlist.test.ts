import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, isIpAllowed } from "./ipAllowlist.js";
import { MAX_API_KEY_IP_RANGES, parseIpRanges } from "./ipRanges.js";

describe("clientIpFromHeaders", () => {
  // Catches: trusting a client-supplied X-Forwarded-For entry instead of the one the load balancer appended.
  it("uses the last X-Forwarded-For entry", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
    expect(clientIpFromHeaders(headers)).toBe("198.51.100.7");
  });

  // Catches: an IPv4 client arriving as IPv4-mapped IPv6 failing to match its IPv4 range.
  it("unwraps IPv4-mapped IPv6 addresses", () => {
    const headers = new Headers({ "x-forwarded-for": "::ffff:198.51.100.7" });
    expect(clientIpFromHeaders(headers)).toBe("198.51.100.7");
  });

  it("returns null when the header is missing or not an address", () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "unknown" }))).toBeNull();
  });
});

describe("parseIpRanges", () => {
  it("stores bare addresses as single-address ranges and drops duplicates", () => {
    expect(parseIpRanges(["203.0.113.9", " 203.0.113.9/32 ", "2001:DB8::/32", ""])).toEqual({
      ok: true,
      ranges: ["203.0.113.9/32", "2001:db8::/32"],
    });
  });

  it("rejects malformed input", () => {
    for (const value of [
      "203.0.113.256",
      "203.0.113.0/33",
      "2001:db8::/129",
      "1.2.3.4/24/1",
      "nope",
    ]) {
      expect(parseIpRanges([value]).ok, value).toBe(false);
    }
  });

  // Catches: an allowlist that admits requests reaching the API over a private network.
  it("rejects ranges that overlap private or reserved space", () => {
    for (const value of [
      "10.1.2.3",
      "172.16.0.0/12",
      "192.168.1.0/24",
      "100.64.0.1",
      "127.0.0.1",
      "8.0.0.0/4",
      "0.0.0.0/0",
      "fd00::1",
      "::1",
    ]) {
      expect(parseIpRanges([value]).ok, value).toBe(false);
    }
    expect(parseIpRanges(["10.1.2.3"], { allowNonPublicRanges: true })).toEqual({
      ok: true,
      ranges: ["10.1.2.3/32"],
    });
  });

  // Catches: an IPv4-mapped IPv6 range passing validation and then matching private IPv4
  // callers, which reopens the private-network bypass.
  it("rejects IPv4-mapped IPv6 ranges, even when private ranges are allowed", () => {
    for (const value of ["::ffff:800:0/101", "::ffff:a01:203", "::/0"]) {
      expect(parseIpRanges([value]).ok, value).toBe(false);
      expect(parseIpRanges([value], { allowNonPublicRanges: true }).ok, value).toBe(false);
    }
    expect(parseIpRanges(["2001:db8::/32"]).ok).toBe(true);
  });

  it("caps the number of ranges", () => {
    const ranges = Array.from({ length: MAX_API_KEY_IP_RANGES + 1 }, (_, i) => `203.0.113.${i}`);
    expect(parseIpRanges(ranges).ok).toBe(false);
  });
});

describe("isIpAllowed", () => {
  it("allows any IP when the list is empty", () => {
    expect(isIpAllowed([], null)).toBe(true);
  });

  it("matches addresses inside a range and nothing else", () => {
    const ranges = ["203.0.113.0/24", "2001:db8::/32"];
    expect(isIpAllowed(ranges, "203.0.113.200")).toBe(true);
    expect(isIpAllowed(ranges, "2001:db8:1::5")).toBe(true);
    expect(isIpAllowed(ranges, "203.0.114.1")).toBe(false);
    expect(isIpAllowed(ranges, "2001:db9::1")).toBe(false);
  });

  // Catches: a restricted key being usable when the caller's IP can't be determined.
  it("denies an unknown IP when the list is not empty", () => {
    expect(isIpAllowed(["203.0.113.0/24"], null)).toBe(false);
  });
});
