import { BlockList, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { isIpAllowed } from "./ipAllowlist.js";
import {
  checkIpRangeEntry,
  ipRangesCoveringIp,
  ipVersion,
  normalizeIpAddress,
} from "./ipRanges.js";

const ADDRESS_INPUTS = [
  "203.0.113.9",
  "0.0.0.0",
  "255.255.255.255",
  "01.2.3.4",
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  " 1.2.3.4",
  "::",
  "::1",
  "2001:db8::",
  "2001:DB8::1",
  "2001:0db8:0000:0000:0000:0000:0000:0001",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7:8:9",
  "1::2::3",
  "::ffff:1.2.3.4",
  "::ffff:7b7b:7b7b",
  "::1.2.3.4",
  "1:2:3:4:5:6:1.2.3.4",
  "fe80::1%eth0",
  "fe80::1%",
  "12345::",
  "g::1",
  ":1",
  "1:",
  "",
  "abc",
];

// Catches: the browser accepting an address the server rejects, or the other way round.
describe("ipVersion", () => {
  it("agrees with net.isIP", () => {
    for (const value of ADDRESS_INPUTS) {
      expect(ipVersion(value), value).toBe(isIP(value));
    }
  });
});

describe("checkIpRangeEntry", () => {
  // Catches: the dashboard sending a form the server stores differently from what it showed.
  it("returns the stored form", () => {
    expect(checkIpRangeEntry("203.0.113.9")).toEqual({ ok: true, range: "203.0.113.9/32" });
    expect(checkIpRangeEntry("2001:DB8::/32")).toEqual({ ok: true, range: "2001:db8::/32" });
  });

  // Catches: the dashboard and the save error wording an invalid entry differently.
  it("uses the server's messages", () => {
    expect(checkIpRangeEntry("not-an-ip")).toEqual({
      ok: false,
      error: '"not-an-ip" is not a valid IP address or CIDR range.',
    });
    expect(checkIpRangeEntry("10.0.0.1")).toEqual({
      ok: false,
      error: '"10.0.0.1" includes private or reserved addresses. Use your public IP addresses.',
    });
    expect(checkIpRangeEntry("::ffff:a01:203", { allowNonPublicRanges: true })).toEqual({
      ok: false,
      error:
        '"::ffff:a01:203" covers IPv4-mapped IPv6 addresses. Enter IPv4 addresses in IPv4 form.',
    });
    expect(checkIpRangeEntry("10.0.0.1", { allowNonPublicRanges: true }).ok).toBe(true);
  });

  // Catches: the byte math disagreeing with BlockList on where a range starts and ends, which
  // would let a private range through (or refuse a public one) after the move off BlockList.
  it("finds overlaps the way BlockList does", () => {
    const blocked = ["10.0.0.0/8", "172.16.0.0/12", "fc00::/7", "fe80::/10"];
    const cases: [string, boolean][] = [
      ["9.255.255.255", true],
      ["11.0.0.0", true],
      ["8.0.0.0/7", true],
      ["8.0.0.0/6", false],
      ["172.15.255.255", true],
      ["172.32.0.0", true],
      ["172.31.255.255", false],
      ["172.0.0.0/12", true],
      ["172.0.0.0/11", false],
      ["fbff::/16", true],
      ["fe00::/8", false],
      ["fec0::/10", true],
      ["2001:db8::/32", true],
      ["::/1", false],
      ["8000::/1", false],
    ];
    for (const [value, expectedOk] of cases) {
      expect(checkIpRangeEntry(value).ok, value).toBe(expectedOk);
    }
    // And the blocked ranges themselves, checked against BlockList directly.
    const list = new BlockList();
    for (const range of blocked) {
      const [address, prefix] = range.split("/");
      list.addSubnet(address!, Number(prefix), isIP(address!) === 4 ? "ipv4" : "ipv6");
    }
    for (const [value] of cases.filter(([value]) => !value.includes("/"))) {
      const ok = checkIpRangeEntry(value).ok;
      if (!ok) continue;
      expect(list.check(value, isIP(value) === 4 ? "ipv4" : "ipv6"), value).toBe(false);
    }
  });
});

describe("normalizeIpAddress", () => {
  // Catches: "Test an IP" treating ::ffff:203.0.113.9 as IPv6, or accepting a range as an address.
  it("unwraps IPv4-mapped addresses and rejects ranges", () => {
    expect(normalizeIpAddress("::FFFF:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIpAddress("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIpAddress("203.0.113.0/24")).toBeNull();
    expect(normalizeIpAddress("abc")).toBeNull();
  });
});

// Catches: the dashboard's "Test an IP" verdict disagreeing with what authentication does.
describe("ipRangesCoveringIp", () => {
  const ranges = [
    "203.0.113.9/32",
    "198.51.100.0/24",
    "198.51.100.64/26",
    "2001:db8::/32",
    "2001:db8:ff00::/40",
    "64:ff9b::/96",
    "8.0.0.0/6",
    "2a00::/12",
  ];
  const ips = [
    "203.0.113.9",
    "203.0.113.10",
    "198.51.100.77",
    "198.51.100.0",
    "198.51.100.255",
    "198.51.101.0",
    "::ffff:198.51.100.77",
    "::ffff:c633:644d",
    "::c633:644d",
    "2001:db8::1",
    "2001:db8:ff12::1",
    "2001:db9::1",
    "2001:0DB8:0:0:0:0:0:1",
    "64:ff9b::c633:644d",
    "64:ff9b::1:c633:644d",
    "11.255.255.255",
    "12.0.0.0",
    "2a0f:ffff::1",
    "2a10::1",
    "fe80::1%eth0",
  ];

  it("agrees with isIpAllowed", () => {
    for (const ip of ips) {
      for (const range of ranges) {
        const single = [range];
        expect(ipRangesCoveringIp(single, ip)!.length > 0, `${ip} in ${single}`).toBe(
          isIpAllowed(single, ip)
        );
      }
      expect(ipRangesCoveringIp(ranges, ip)!.length > 0, ip).toBe(isIpAllowed(ranges, ip));
    }
  });

  it("agrees with isIpAllowed on random ranges and addresses", () => {
    // mulberry32: 32-bit integer math only, so the sequence is exact and well spread.
    let seed = 42;
    const random = (max: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % max;
    };
    const ipv4 = () => Array.from({ length: 4 }, () => random(256)).join(".");
    const ipv6 = () =>
      Array.from({ length: 8 }, () => (random(4) === 0 ? 0 : random(0x10000)).toString(16)).join(
        ":"
      );

    for (let i = 0; i < 2000; i++) {
      const v4 = random(2) === 0;
      const base = v4 ? ipv4() : ipv6();
      const range = `${base}/${random(v4 ? 33 : 129)}`;
      // Half the time, test an address that shares the range's leading bytes.
      const ip =
        random(2) === 0
          ? v4
            ? ipv4()
            : ipv6()
          : v4
            ? base.split(".").slice(0, 3).join(".") + `.${random(256)}`
            : base.split(":").slice(0, 6).join(":") + `:${random(0x10000).toString(16)}:1`;
      expect(ipRangesCoveringIp([range], ip)!.length > 0, `${ip} in ${range}`).toBe(
        isIpAllowed([range], ip)
      );
    }
  });

  // Catches: the tester highlighting the wrong pills, or giving a verdict for input that isn't an IP.
  it("returns the covering ranges, or null for something that isn't an address", () => {
    expect(ipRangesCoveringIp(ranges, "198.51.100.77")).toEqual([
      "198.51.100.0/24",
      "198.51.100.64/26",
    ]);
    expect(ipRangesCoveringIp(ranges, "192.0.2.1")).toEqual([]);
    expect(ipRangesCoveringIp(ranges, "198.51.100.0/24")).toBeNull();
    expect(ipRangesCoveringIp(ranges, "abc")).toBeNull();
  });
});
