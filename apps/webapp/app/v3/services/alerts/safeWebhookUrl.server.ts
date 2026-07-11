// Validator for user-supplied webhook URLs that the server fetches later
// (alert channels, error-group webhooks). Rejects non-http(s) schemes and
// private/loopback/link-local/reserved hosts.
//
// Two entry points:
//   - `assertSafeWebhookUrlLexical` — sync, no network. Runs on every
//     delivery hop; the connect-time bound lookup below is authoritative.
//   - `assertSafeWebhookUrl` — storage-time gate: lexical check plus a
//     best-effort DNS resolution for early, friendly rejection.
//
// The authoritative guard is at delivery time: `safeWebhookFetch` binds
// validation into the connection's own DNS lookup, so the address actually
// connected to is the one that was checked.

import { promises as dnsPromises } from "node:dns";

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWebhookUrlError";
  }
}

function isUnsafeIPv4(host: string): boolean {
  // Reject if the host parses as a 4-octet IPv4 in any of the unsafe ranges.
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  // 0.0.0.0/8 (unspecified)
  if (a === 0) return true;
  // 127/8 loopback
  if (a === 127) return true;
  // 10/8
  if (a === 10) return true;
  // 172.16/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168/16
  if (a === 192 && b === 168) return true;
  // 169.254/16 link-local
  if (a === 169 && b === 254) return true;
  // 100.64/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240/4 reserved
  if (a >= 240) return true;
  return false;
}

function isUnsafeIPv6(host: string): boolean {
  // URL.hostname keeps the brackets for IPv6 literals ([::1]); DNS results
  // and IP literals elsewhere are unbracketed. Strip brackets so both work.
  const lower = (
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  ).toLowerCase();
  // loopback
  if (lower === "::1") return true;
  // unspecified
  if (lower === "::" || lower === "::0" || lower === "0:0:0:0:0:0:0:0") return true;
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ULA fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // multicast ff00::/8
  if (lower.startsWith("ff")) return true;
  // IPv4-mapped, dotted form: ::ffff:a.b.c.d
  const mappedDotted = lower.match(/^::ffff:([0-9.]+)$/);
  if (mappedDotted && isUnsafeIPv4(mappedDotted[1])) return true;
  // IPv4-mapped, hex form: ::ffff:7f00:1 (how Node normalizes ::ffff:127.0.0.1).
  // The two trailing hextets encode the 32-bit IPv4 address.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isUnsafeIPv4(ipv4)) return true;
  }
  return false;
}

/**
 * Throw if a resolved IP address falls in a disallowed range. Exposed so the
 * delivery-time connector can validate the actual address it connects to.
 */
export function assertAddressAllowed(address: string, family: number): void {
  if (family === 4 && isUnsafeIPv4(address)) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL resolves to a private/loopback/link-local address: ${address}`
    );
  }
  if (family === 6 && isUnsafeIPv6(address)) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL resolves to a private/loopback/link-local IPv6 address: ${address}`
    );
  }
}

function isUnsafeHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "internal" || lower.endsWith(".internal")) return true;
  if (lower === "local" || lower.endsWith(".local")) return true;
  return false;
}

function isIPLiteral(host: string): boolean {
  // Strip brackets: URL.hostname keeps them for IPv6 literals ([::1]).
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IPv4: four dot-separated 0-255 octets.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return true;
  // IPv6: at least one `:` and only hex / `:` / `.` (the `.` allows
  // IPv4-mapped notation like ::ffff:1.2.3.4).
  if (bare.includes(":") && /^[0-9a-fA-F:.]+$/.test(bare)) return true;
  return false;
}

/**
 * Best-effort storage-time DNS check: resolve `hostname` and throw if a
 * returned address is unsafe. Not a security boundary — resolution failures
 * don't block the save, since delivery re-validates at connect time.
 */
async function assertResolvedAddressesSafe(hostname: string): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    // Unresolvable right now — don't block the save; connect-time is authoritative.
    return;
  }
  for (const { address, family } of addresses) {
    assertAddressAllowed(address, family);
  }
}

/**
 * Synchronous, no-network SSRF check: scheme allow-list plus IP-literal
 * and hostname range checks. Used on every delivery hop, where the
 * connect-time bound lookup is the authoritative range check.
 */
export function assertSafeWebhookUrlLexical(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError("Webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeWebhookUrlError(`Webhook URL must use http or https (got ${parsed.protocol})`);
  }
  const host = parsed.hostname;
  if (!host) {
    throw new UnsafeWebhookUrlError("Webhook URL must have a hostname");
  }
  if (isUnsafeHostname(host)) {
    throw new UnsafeWebhookUrlError(`Webhook URL host is not allowed: ${host}`);
  }
  if (isUnsafeIPv4(host)) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL points at a private/loopback/link-local address: ${host}`
    );
  }
  if (isUnsafeIPv6(host)) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL points at a private/loopback/link-local IPv6 address: ${host}`
    );
  }
  return parsed;
}

/**
 * Storage-time gate: lexical check plus a best-effort DNS resolution of
 * registrable domains, for early rejection before storage.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  const parsed = assertSafeWebhookUrlLexical(rawUrl);
  if (!isIPLiteral(parsed.hostname)) {
    await assertResolvedAddressesSafe(parsed.hostname);
  }
  return parsed;
}
