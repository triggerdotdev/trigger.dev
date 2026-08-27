/**
 * The document `img-src` allowlist. Remote images are a beacon channel: rendering
 * one is the outbound request, no click needed. So no wildcard host and no bare
 * scheme. Operator-supplied entries are exact origins; a base source may pin a path
 * to narrow the host further.
 */

/**
 * Always allowed: own origin, inline data, object URLs, the SSO avatar hosts, the
 * favicon endpoint org avatars are stored as (see `utils/favicon.ts`), and our own
 * changelog images. The path pins each endpoint — CSP matches the path and ignores the
 * query string. The favicon endpoint 302s to a `tN.gstatic.com` shard and CSP re-checks
 * only the host on a redirect, so the shards are listed too; their path pin limits
 * direct loads only. A trailing "/" matches by prefix.
 */
export const BASE_IMG_SRC_SOURCES = [
  "'self'",
  "data:",
  "blob:",
  "https://avatars.githubusercontent.com",
  "https://lh3.googleusercontent.com",
  "https://www.google.com/s2/favicons",
  "https://t0.gstatic.com/faviconV2",
  "https://t1.gstatic.com/faviconV2",
  "https://t2.gstatic.com/faviconV2",
  "https://t3.gstatic.com/faviconV2",
  "https://trigger.dev/changelog/",
] as const;

type RejectedOrigin = { value: string; reason: string };

export type ParsedImageOrigins = {
  /** Accepted, canonicalised (`scheme://host[:port]`) and deduplicated. */
  origins: string[];
  rejected: RejectedOrigin[];
};

export type ParseImageOriginsOptions = {
  /** Only a local development deployment may serve images over plain http. */
  allowHttp?: boolean;
};

/**
 * Parses a comma-separated `CSP_IMG_SRC_ALLOWLIST`. Never throws: bad entries are
 * reported in `rejected` so the caller can warn and boot with the valid ones.
 */
export function parseCspImageOrigins(
  raw: string | undefined | null,
  options: ParseImageOriginsOptions = {}
): ParsedImageOrigins {
  const allowHttp = options.allowHttp ?? false;
  const origins: string[] = [];
  const seen = new Set<string>();
  const rejected: RejectedOrigin[] = [];

  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (value.length === 0) continue;

    const reason = rejectionReason(value, allowHttp);
    if (reason) {
      rejected.push({ value, reason });
      continue;
    }

    const url = new URL(value);
    const origin = `${url.protocol}//${url.host}`;
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }

  return { origins, rejected };
}

/** Returns why the entry is not an acceptable origin, or undefined if it is one. */
function rejectionReason(value: string, allowHttp: boolean): string | undefined {
  if (value.includes("*")) {
    return "wildcards are not allowed, list each origin exactly";
  }
  if (/\s/.test(value)) {
    return "contains whitespace";
  }
  // `;` and `,` delimit CSP directives / source lists; an entry containing one would
  // land verbatim in the space-joined img-src and inject or truncate a directive.
  if (/[;,]/.test(value)) {
    return "must not contain ';' or ',' — these delimit CSP directives";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid absolute URL";
  }

  const allowedProtocols = allowHttp ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    return allowHttp
      ? `scheme "${url.protocol}" is not http: or https:`
      : `scheme "${url.protocol}" is not https:`;
  }
  if (url.host.length === 0) {
    return "has no host";
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return "must not contain credentials";
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    return "must be an origin only, with no path, query or hash";
  }
  return undefined;
}

/**
 * The origin of a URL the operator configured themselves, keeping its scheme: an object
 * store on plain http is a normal local or self-hosted setup. Origin only — CSP matches
 * the host and ignores the presigned query string.
 */
export function imageOriginFromUrl(baseUrl: string | undefined | null): string | undefined {
  if (!baseUrl) return undefined;

  // `new URL` keeps these in the host, and a ";" or "," would truncate or inject a
  // directive once the sources are space-joined.
  if (/[*;,]|\s/.test(baseUrl)) return undefined;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0) {
    return undefined;
  }

  return `${url.protocol}//${url.host}`;
}

/** Adds an optional origin to a source list, keeping it free of duplicates. */
export function appendImageOrigin(
  origins: readonly string[],
  origin: string | undefined
): string[] {
  if (!origin || origins.includes(origin)) return [...origins];
  return [...origins, origin];
}

/** The full directive: the base sources plus any configured extra origins. */
export function buildImgSrcDirective(extraOrigins: readonly string[] = []): string {
  return ["img-src", ...BASE_IMG_SRC_SOURCES, ...extraOrigins].join(" ");
}

/**
 * Appends the directive to whatever a route already set, rather than replacing it.
 * A route that set its own `img-src` keeps it.
 */
export function withImgSrc(existing: string | null | undefined, directive: string): string {
  if (!existing) return directive;
  if (/(^|;)\s*img-src\s/.test(existing)) return existing;
  return `${existing.replace(/;\s*$/, "")}; ${directive}`;
}
