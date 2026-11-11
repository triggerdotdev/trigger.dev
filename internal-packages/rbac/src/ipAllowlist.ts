import { BlockList, isIP } from "node:net";

// Request matching only. Validating ranges on save lives in ipRanges.ts, which has no Node
// imports so the dashboard can use it too.

type IpFamily = "ipv4" | "ipv6";

type IpRange = {
  address: string;
  prefix: number;
  family: IpFamily;
};

/**
 * The client IP of an API request: the last X-Forwarded-For entry. The load
 * balancer in front of the API appends the address it received the connection
 * from, so the last entry is the only one a client cannot set.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (!forwardedFor) return null;

  const entries = forwardedFor.split(",");
  const last = entries[entries.length - 1]?.trim();
  if (!last) return null;

  return normalizeIp(last);
}

/**
 * Whether a request from `ip` may use a key restricted to `ranges`. An empty
 * list allows any IP. An unknown IP, or stored ranges that no longer parse,
 * never match.
 */
export function isIpAllowed(ranges: readonly string[], ip: string | null): boolean {
  if (ranges.length === 0) return true;
  if (!ip) return false;

  const address = normalizeIp(ip);
  const family = address ? ipFamily(address) : null;
  if (!address || !family) return false;

  const parsed: IpRange[] = [];
  for (const range of ranges) {
    const value = parseIpRange(range);
    if (value) parsed.push(value);
  }

  return buildBlockList(parsed).check(address, family);
}

function parseIpRange(value: string): IpRange | null {
  const parts = value.split("/");
  if (parts.length > 2) return null;

  const address = normalizeIp(parts[0]!);
  const family = address ? ipFamily(address) : null;
  if (!address || !family) return null;

  const maxPrefix = family === "ipv4" ? 32 : 128;
  const prefixText = parts[1];
  if (prefixText === undefined) {
    return { address, prefix: maxPrefix, family };
  }

  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > maxPrefix) return null;

  // BlockList ignores host bits, so "203.0.113.9/24" matches the same as "203.0.113.0/24".
  return { address, prefix, family };
}

function buildBlockList(ranges: readonly IpRange[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    list.addSubnet(range.address, range.prefix, range.family);
  }
  return list;
}

// IPv4 clients can show up as IPv4-mapped IPv6 (::ffff:203.0.113.9); compare them as IPv4.
function normalizeIp(value: string): string | null {
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const address = mapped ? mapped[1]! : trimmed;
  return isIP(address) === 0 ? null : address.toLowerCase();
}

function ipFamily(address: string): IpFamily | null {
  const version = isIP(address);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}
