import { describe, expect, it } from "vitest";
import { ipLiteralHost, isPublicAddress } from "../app/services/publicAddress.server.js";

describe("isPublicAddress", () => {
  // Catches: public addresses, including NAT64 to a public IPv4, being refused.
  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "198.17.255.255",
    "198.20.0.0",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "64:ff9b::8.8.8.8",
    "[2606:4700:4700::1111]",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  // Catches: a reserved range, or an IPv6 form carrying a private IPv4, counted as public.
  it.each([
    // IPv4
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.192",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    // IPv4 carried in IPv6
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::a00:1",
    "64:ff9b::",
    "64:ff9b:1::a9fe:a9fe",
    "::a9fe:a9fe",
    "::169.254.169.254",
    "::ffff:0:a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "2002:808:808::1",
    "2001:0:4136:e378:8000:63bf:56fe:5601",
    "[64:ff9b::a9fe:a9fe]",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  // Catches: hostnames or malformed input treated as allowed addresses.
  it.each(["", "example.com", "not an ip", "999.1.1.1"])("blocks non-address %j", (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });
});

describe("ipLiteralHost", () => {
  // Catches: bracketed IPv6 hosts not recognised as literals, skipping the connect-time check.
  it("returns the bare address for IP-literal hosts", () => {
    expect(ipLiteralHost("[::1]")).toBe("::1");
    expect(ipLiteralHost("10.0.0.1")).toBe("10.0.0.1");
  });

  it("returns null for hostnames", () => {
    expect(ipLiteralHost("example.com")).toBeNull();
    expect(ipLiteralHost("[example.com]")).toBeNull();
  });
});
