/**
 * The one definition of "local" the dev-only seed scripts stage against. They carry API keys
 * and destructive writes, so every host they touch — Redis, ClickHouse, the webapp itself —
 * is checked here rather than each deciding for itself.
 */

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** `URL.hostname` brackets IPv6, so `::1` arrives as `[::1]`. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.replace(/^\[(.*)\]$/, "$1"));
}

export type LocalOriginCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: "unparseable" | "non_local"; hostname?: string };

/** Never returns the URL in the failure: an origin can carry credentials. */
export function checkLocalOrigin(origin: string): LocalOriginCheck {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!isLocalHost(parsed.hostname)) {
    return { ok: false, reason: "non_local", hostname: parsed.hostname };
  }
  return { ok: true, origin };
}
