import { BlockList, isIP } from "node:net";

export const MAX_API_KEY_IP_RANGES = 50;

type IpFamily = "ipv4" | "ipv6";

type IpRange = {
  address: string;
  prefix: number;
  family: IpFamily;
};

// Ranges a public client never calls from. Requests that reach the API over a
// private network (for example from inside the platform) carry one of these
// as their source, so an allowlist containing them would admit that traffic.
const NON_PUBLIC_RANGES: IpRange[] = [
  { address: "0.0.0.0", prefix: 8, family: "ipv4" },
  { address: "10.0.0.0", prefix: 8, family: "ipv4" },
  { address: "100.64.0.0", prefix: 10, family: "ipv4" },
  { address: "127.0.0.0", prefix: 8, family: "ipv4" },
  { address: "169.254.0.0", prefix: 16, family: "ipv4" },
  { address: "172.16.0.0", prefix: 12, family: "ipv4" },
  { address: "192.168.0.0", prefix: 16, family: "ipv4" },
  { address: "::", prefix: 128, family: "ipv6" },
  { address: "::1", prefix: 128, family: "ipv6" },
  { address: "fc00::", prefix: 7, family: "ipv6" },
  { address: "fe80::", prefix: 10, family: "ipv6" },
];

// Node's BlockList matches IPv4 callers against IPv4-mapped IPv6 subnets, so a range in this
// block would sidestep the IPv4 checks above. Such ranges must be entered in IPv4 form.
const IPV4_MAPPED_RANGE: IpRange = { address: "::ffff:0:0", prefix: 96, family: "ipv6" };

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

export type ParseIpRangesResult = { ok: true; ranges: string[] } | { ok: false; error: string };

/**
 * Validate user input into stored CIDR ranges. A bare address becomes a
 * single-address range. Ranges overlapping private or reserved space are
 * refused unless `allowNonPublicRanges` is set (self-hosted installs whose
 * clients reach the API over a private network).
 */
export function parseIpRanges(
  input: readonly string[],
  { allowNonPublicRanges = false }: { allowNonPublicRanges?: boolean } = {}
): ParseIpRangesResult {
  const ranges: string[] = [];

  for (const raw of input) {
    const value = raw.trim();
    if (!value) continue;

    const range = parseIpRange(value);
    if (!range) {
      return { ok: false, error: `"${value}" is not a valid IP address or CIDR range.` };
    }

    if (overlapsRanges(range, [IPV4_MAPPED_RANGE])) {
      return {
        ok: false,
        error: `"${value}" covers IPv4-mapped IPv6 addresses. Enter IPv4 addresses in IPv4 form.`,
      };
    }

    if (!allowNonPublicRanges && overlapsRanges(range, NON_PUBLIC_RANGES)) {
      return {
        ok: false,
        error: `"${value}" includes private or reserved addresses. Use your public IP addresses.`,
      };
    }

    const canonical = `${range.address}/${range.prefix}`;
    if (!ranges.includes(canonical)) {
      ranges.push(canonical);
    }
  }

  if (ranges.length > MAX_API_KEY_IP_RANGES) {
    return {
      ok: false,
      error: `An API key can have at most ${MAX_API_KEY_IP_RANGES} IP ranges.`,
    };
  }

  return { ok: true, ranges };
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

function overlapsRanges(range: IpRange, others: readonly IpRange[]): boolean {
  // Compare within one family only: BlockList matches IPv4 addresses against IPv4-mapped IPv6
  // subnets, which would make every IPv4 range overlap ::ffff:0:0/96.
  const sameFamily = others.filter((other) => other.family === range.family);
  if (sameFamily.length === 0) return false;

  // Two ranges overlap exactly when one contains the other's first address.
  if (buildBlockList(sameFamily).check(range.address, range.family)) return true;
  const candidate = buildBlockList([range]);
  return sameFamily.some((other) => candidate.check(other.address, other.family));
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
