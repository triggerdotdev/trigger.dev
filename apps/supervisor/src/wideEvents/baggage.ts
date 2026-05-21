/**
 * W3C Baggage (https://www.w3.org/TR/baggage/) encoding for outbound peer
 * calls. Serialises a State's `meta` map into a `Baggage` header value so
 * the downstream service auto-stamps the same labels onto its own wide
 * events - even on early-error paths that bail before parsing the request
 * body.
 *
 * Outbound discipline: only call this on peer-to-peer hops within the trust
 * boundary. External-endpoint calls (image registries, cloud-provider
 * APIs, third-party webhooks) must not include the Baggage header.
 */

/**
 * Cap the number of entries serialised onto the header. A misbehaving
 * caller's `meta` map shouldn't blow up downstream event width.
 */
const MAX_BAGGAGE_ENTRIES = 32;

/**
 * Cap each value's length. Defense against an upstream that stuffs
 * unbounded payloads into a meta value.
 */
const MAX_BAGGAGE_VALUE_BYTES = 256;

/**
 * Encode a `meta` map as a Baggage header value (`k1=v1,k2=v2`). Keys are
 * sorted for stable output across hops; an empty input yields the empty
 * string so the caller can skip emitting the header entirely.
 */
export function encodeBaggage(meta: Record<string, string>): string {
  const entries = Object.entries(meta).filter(([k, v]) => k && v);
  if (entries.length === 0) return "";

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: string[] = [];
  for (const [k, raw] of entries) {
    if (out.length >= MAX_BAGGAGE_ENTRIES) break;
    const v = raw.length > MAX_BAGGAGE_VALUE_BYTES ? raw.slice(0, MAX_BAGGAGE_VALUE_BYTES) : raw;
    out.push(`${k}=${v}`);
  }
  return out.join(",");
}
