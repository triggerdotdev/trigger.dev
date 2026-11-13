// IP range validation and matching with no Node imports, so the dashboard can run the same
// checks in the browser as the server runs on save. Request authentication keeps using
// `isIpAllowed` in ipAllowlist.ts (Node's BlockList); tests hold the two to the same answers.

export const MAX_API_KEY_IP_RANGES = 50;

// The patterns Node's `net.isIP` uses (lib/internal/net.js), so both sides accept the same input.
const V4_SEG = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const V6_SEG = "(?:[0-9a-fA-F]{1,4})";
const IPV4_PATTERN = new RegExp(`^${V4_STR}$`);
const IPV6_PATTERN = new RegExp(
  "^(?:" +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ")(?:%[0-9a-zA-Z-.:]{1,})?$"
);

export type IpFamily = "ipv4" | "ipv6";

type IpRange = {
  /** The address as entered, lowercased (an IPv4-mapped IPv6 address is unwrapped to IPv4). */
  address: string;
  prefix: number;
  family: IpFamily;
  /** The address as bytes: 4 for IPv4, 16 for IPv6. */
  bytes: number[];
};

// Ranges a public client never calls from. Requests that reach the API over a
// private network (for example from inside the platform) carry one of these
// as their source, so an allowlist containing them would admit that traffic.
const NON_PUBLIC_RANGES: IpRange[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map((range) => parseIpRange(range)!);

// Node's BlockList matches IPv4 callers against IPv4-mapped IPv6 subnets, so a range in this
// block would sidestep the IPv4 checks above. Such ranges must be entered in IPv4 form.
const IPV4_MAPPED_RANGE = parseIpRange("::ffff:0:0/96")!;

export type IpRangeEntryResult = { ok: true; range: string } | { ok: false; error: string };

/**
 * Validate one allowlist entry: an address or CIDR range. On success, `range` is the stored
 * form (a bare address becomes a single-address range).
 */
export function checkIpRangeEntry(
  value: string,
  { allowNonPublicRanges = false }: { allowNonPublicRanges?: boolean } = {}
): IpRangeEntryResult {
  const range = parseIpRange(value);
  if (!range) {
    return { ok: false, error: `"${value}" is not a valid IP address or CIDR range.` };
  }

  if (overlaps(range, IPV4_MAPPED_RANGE)) {
    return {
      ok: false,
      error: `"${value}" covers IPv4-mapped IPv6 addresses. Enter IPv4 addresses in IPv4 form.`,
    };
  }

  if (!allowNonPublicRanges && NON_PUBLIC_RANGES.some((other) => overlaps(range, other))) {
    return {
      ok: false,
      error: `"${value}" includes private or reserved addresses. Use your public IP addresses.`,
    };
  }

  return { ok: true, range: `${range.address}/${range.prefix}` };
}

export const TOO_MANY_IP_RANGES_ERROR = `An API key can have at most ${MAX_API_KEY_IP_RANGES} IP ranges.`;

export type ParseIpRangesResult = { ok: true; ranges: string[] } | { ok: false; error: string };

/**
 * Validate user input into stored CIDR ranges. A bare address becomes a
 * single-address range. Ranges overlapping private or reserved space are
 * refused unless `allowNonPublicRanges` is set (self-hosted installs whose
 * clients reach the API over a private network).
 */
export function parseIpRanges(
  input: readonly string[],
  options: { allowNonPublicRanges?: boolean } = {}
): ParseIpRangesResult {
  const ranges: string[] = [];

  for (const raw of input) {
    const value = raw.trim();
    if (!value) continue;

    const entry = checkIpRangeEntry(value, options);
    if (!entry.ok) return entry;

    if (!ranges.includes(entry.range)) {
      ranges.push(entry.range);
    }
  }

  if (ranges.length > MAX_API_KEY_IP_RANGES) {
    return { ok: false, error: TOO_MANY_IP_RANGES_ERROR };
  }

  return { ok: true, ranges };
}

/**
 * The single IP address in `value`, normalized the way requests are matched (lowercased, an
 * IPv4-mapped IPv6 address in dotted form unwrapped to IPv4), or null when it isn't one.
 */
export function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const address = mapped ? mapped[1]! : trimmed;
  return ipVersion(address) === 0 ? null : address.toLowerCase();
}

/**
 * Which of `ranges` let a request from `ip` through, matched the way `isIpAllowed` matches
 * them. Entries that don't parse are skipped. Returns null when `ip` isn't an IP address.
 */
export function ipRangesCoveringIp(ranges: readonly string[], ip: string): string[] | null {
  const address = normalizeIpAddress(ip);
  const bytes = address ? addressBytes(address) : null;
  if (!bytes) return null;

  // BlockList matches an IPv4-mapped IPv6 caller (::ffff:7b7b:7b7b) against IPv4 subnets.
  const ipv4 = bytes.length === 4 ? bytes : isIpv4Mapped(bytes) ? bytes.slice(12) : null;

  return ranges.filter((value) => {
    const range = parseIpRange(value);
    if (!range) return false;
    if (range.family === "ipv4") {
      return ipv4 !== null && samePrefix(range.bytes, ipv4, range.prefix);
    }
    // And an IPv4 caller against IPv4-mapped IPv6 subnets.
    const ipv6 = bytes.length === 16 ? bytes : [...IPV4_MAPPED_RANGE.bytes.slice(0, 12), ...bytes];
    return samePrefix(range.bytes, ipv6, range.prefix);
  });
}

/** Node's `isIP`: 4, 6, or 0 when `value` isn't an address. */
export function ipVersion(value: string): 0 | 4 | 6 {
  if (IPV4_PATTERN.test(value)) return 4;
  if (IPV6_PATTERN.test(value)) return 6;
  return 0;
}

function parseIpRange(value: string): IpRange | null {
  const parts = value.split("/");
  if (parts.length > 2) return null;

  const address = normalizeIpAddress(parts[0]!);
  const bytes = address ? addressBytes(address) : null;
  if (!address || !bytes) return null;

  const family: IpFamily = bytes.length === 4 ? "ipv4" : "ipv6";
  const maxPrefix = bytes.length * 8;
  const prefixText = parts[1];
  if (prefixText === undefined) {
    return { address, prefix: maxPrefix, family, bytes };
  }

  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > maxPrefix) return null;

  // Host bits are ignored, as BlockList does: "203.0.113.9/24" matches like "203.0.113.0/24".
  return { address, prefix, family, bytes };
}

// Two ranges of one family overlap exactly when they agree on the shorter prefix. Ranges of
// different families never overlap here, so an IPv4 range doesn't overlap ::ffff:0:0/96.
function overlaps(a: IpRange, b: IpRange): boolean {
  return a.family === b.family && samePrefix(a.bytes, b.bytes, Math.min(a.prefix, b.prefix));
}

function samePrefix(a: readonly number[], b: readonly number[], prefix: number): boolean {
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false;
  }
  const bits = prefix % 8;
  if (bits === 0) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return (a[fullBytes]! & mask) === (b[fullBytes]! & mask);
}

function isIpv4Mapped(bytes: readonly number[]): boolean {
  return bytes.length === 16 && samePrefix(bytes, IPV4_MAPPED_RANGE.bytes, 96);
}

// Bytes of an address `ipVersion` accepts. A zone id (fe80::1%eth0) is ignored, as BlockList does.
function addressBytes(address: string): number[] | null {
  const version = ipVersion(address);
  if (version === 4) return address.split(".").map(Number);
  if (version !== 6) return null;

  let text = address.split("%")[0]!;
  let tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail = dotted[1]!.split(".").map(Number);
    // Keep the separator so "::1.2.3.4" still splits around "::".
    text = text.slice(0, -dotted[1]!.length) + "0:0";
  }

  const [head, rest] = text.split("::") as [string, string | undefined];
  const toWords = (part: string) => (part ? part.split(":").map((word) => parseInt(word, 16)) : []);
  const headWords = toWords(head);
  const restWords = rest === undefined ? [] : toWords(rest);
  const missing = 8 - headWords.length - restWords.length;
  const words = [...headWords, ...Array<number>(Math.max(missing, 0)).fill(0), ...restWords];

  const bytes = words.flatMap((word) => [word >> 8, word & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}
