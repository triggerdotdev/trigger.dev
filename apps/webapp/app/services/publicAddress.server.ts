// Shared check for whether the server may connect to an address on behalf of a
// tenant-supplied URL.

import { BlockList, isIP } from "node:net";

const blocked = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}

// IPv4-mapped (::ffff:0:0/96) is matched against the IPv4 rules by BlockList.
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0:0", 96], // IPv4-translated
  ["64:ff9b:1::", 48], // local-use NAT64
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

const nat64 = new BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// Last 32 bits of an IPv6 address in 64:ff9b::/96, as dotted IPv4.
function nat64EmbeddedIPv4(address: string): string {
  const groups = address.split(":");
  const tail = groups[groups.length - 1];
  if (tail.includes(".")) return tail;
  const hi = parseInt(groups[groups.length - 2] || "0", 16);
  const lo = parseInt(tail || "0", 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** The bare address when `host` is an IP literal (brackets allowed), else null. */
export function ipLiteralHost(host: string): string | null {
  const bare = stripBrackets(host);
  return isIP(bare) === 0 ? null : bare;
}

/** False for loopback, private, link-local, reserved and IPv4-embedding addresses. */
export function isPublicAddress(address: string): boolean {
  const bare = stripBrackets(address).split("%")[0];
  const family = isIP(bare);
  if (family === 4) return !blocked.check(bare, "ipv4");
  if (family !== 6) return false;
  if (blocked.check(bare, "ipv6")) return false;
  if (nat64.check(bare, "ipv6")) return isPublicAddress(nat64EmbeddedIPv4(bare));
  return true;
}
