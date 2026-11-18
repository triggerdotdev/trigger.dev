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
import { ipLiteralHost, isPublicAddress } from "~/services/publicAddress.server";

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWebhookUrlError";
  }
}

/**
 * Throw if a resolved IP address falls in a disallowed range. Exposed so the
 * delivery-time connector can validate the actual address it connects to.
 */
export function assertAddressAllowed(address: string, family: number): void {
  if (isPublicAddress(address)) return;
  const kind = family === 6 ? "IPv6 address" : "address";
  throw new UnsafeWebhookUrlError(
    `Webhook URL resolves to a private/loopback/link-local ${kind}: ${address}`
  );
}

function isUnsafeHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "internal" || lower.endsWith(".internal")) return true;
  if (lower === "local" || lower.endsWith(".local")) return true;
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
  if (ipLiteralHost(host) !== null && !isPublicAddress(host)) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL points at a private/loopback/link-local address: ${host}`
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
  if (ipLiteralHost(parsed.hostname) === null) {
    await assertResolvedAddressesSafe(parsed.hostname);
  }
  return parsed;
}
