import { MAX_API_KEY_IP_RANGES } from "@trigger.dev/rbac/ipRanges";
import { describe, expect, it } from "vitest";
import { commitIpRangeEntries, ipRangeCoversIp, ipRangesDraftError } from "~/utils/ipRangeEntries";

const options = { allowPrivateIpRanges: false };

describe("commitIpRangeEntries", () => {
  // Catches: an invalid entry becoming a pill, or being dropped instead of left for the user to fix.
  it("adds valid values and returns the rest with the server's messages", () => {
    expect(
      commitIpRangeEntries(["203.0.113.9"], ["198.51.100.0/24", "10.0.0.1", "nope"], options)
    ).toEqual({
      entries: ["203.0.113.9", "198.51.100.0/24"],
      rejected: [
        {
          value: "10.0.0.1",
          error: '"10.0.0.1" includes private or reserved addresses. Use your public IP addresses.',
        },
        { value: "nope", error: '"nope" is not a valid IP address or CIDR range.' },
      ],
      duplicate: null,
    });
  });

  // Catches: the dashboard refusing private ranges on an install whose server accepts them.
  it("follows the install's private range setting", () => {
    expect(commitIpRangeEntries([], ["10.0.0.1"], { allowPrivateIpRanges: true }).entries).toEqual([
      "10.0.0.1",
    ]);
  });

  // Catches: the same range listed twice as "1.2.3.4" and "1.2.3.4/32".
  it("reports a value that stores as an existing entry instead of adding it", () => {
    expect(commitIpRangeEntries(["203.0.113.9/32"], ["203.0.113.9"], options)).toEqual({
      entries: ["203.0.113.9/32"],
      rejected: [],
      duplicate: "203.0.113.9/32",
    });
  });

  // Catches: a list growing past the limit the server enforces on save.
  it("stops at the range limit", () => {
    const full = Array.from({ length: MAX_API_KEY_IP_RANGES }, (_, i) => `203.0.113.${i}`);
    const result = commitIpRangeEntries(full, ["198.51.100.1"], options);
    expect(result.entries).toHaveLength(MAX_API_KEY_IP_RANGES);
    expect(result.rejected).toEqual([
      {
        value: "198.51.100.1",
        error: `An API key can have at most ${MAX_API_KEY_IP_RANGES} IP ranges.`,
      },
    ]);
  });
});

describe("ipRangesDraftError", () => {
  // Catches: Create staying enabled while the input holds text that would be refused.
  it("returns the first message, or null when everything in the draft can be added", () => {
    expect(ipRangesDraftError([], "203.0.113.9", options)).toBeNull();
    expect(ipRangesDraftError(["203.0.113.9"], "203.0.113.9/32", options)).toBeNull();
    expect(ipRangesDraftError([], "203.0.", options)).toBe(
      '"203.0." is not a valid IP address or CIDR range.'
    );
  });
});

describe("ipRangeCoversIp", () => {
  // Catches: "Add this IP" showing for an address the list already lets through.
  it("matches the way requests are checked", () => {
    expect(ipRangeCoversIp("198.51.100.0/24", "198.51.100.77")).toBe(true);
    expect(ipRangeCoversIp("198.51.100.0/24", "::ffff:198.51.100.77")).toBe(true);
    expect(ipRangeCoversIp("198.51.100.0/24", "192.0.2.1")).toBe(false);
  });
});
