/**
 * The rule for reading impersonation state off the impersonation cookie.
 *
 * Kept pure and free of server-only imports so it can be unit tested directly,
 * and so there is exactly one definition of "this request is impersonating" for
 * every caller to share.
 */

import { Result } from "neverthrow";

export type ImpersonationState = {
  isImpersonating: boolean;
  isViewingAsUser: boolean;
};

/**
 * Resolves the impersonation cookie's raw contents against the identity the
 * request actually authenticated as.
 *
 * Matching the impersonated id against `resolvedUserId` is deliberate. When an
 * admin's role is revoked mid-session the session falls back to the real admin's
 * id while the cookie still names the impersonation target, so "an impersonated
 * id is present" and "this request is impersonating" stop meaning the same
 * thing. Only the strict reading is correct there: that session is no longer
 * impersonating, and so it is not viewing as the user either.
 *
 * Every consumer has to agree on this, or the flags computed on the server and
 * the flag published to the client drift apart — the admin chrome would hide
 * itself on a session that is not impersonating at all.
 */
export function resolveImpersonationState(options: {
  impersonatedUserId: unknown;
  viewingAsUser: unknown;
  resolvedUserId: string | undefined;
  supportAccessExpiresAt?: unknown;
  supportAccessRequest?: SupportAccessRequestInfo;
  now?: number;
}): ImpersonationState {
  const { impersonatedUserId, viewingAsUser, resolvedUserId } = options;

  const isImpersonating =
    typeof impersonatedUserId === "string" &&
    resolvedUserId !== undefined &&
    impersonatedUserId === resolvedUserId &&
    !isSupportAccessExpired(options.supportAccessExpiresAt, options.now ?? Date.now()) &&
    (options.supportAccessRequest === undefined ||
      supportAccessDecision(options.supportAccessRequest).type === "allow");

  return {
    isImpersonating,
    // Display only, and meaningless outside an impersonation session, so it
    // never reads as on without one.
    isViewingAsUser: isImpersonating && viewingAsUser === true,
  };
}

// Unset for Allow sessions; anything but a future epoch-ms value counts as expired.
export function isSupportAccessExpired(expiresAt: unknown, now: number): boolean {
  if (expiresAt === undefined) return false;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true;
  return expiresAt <= now;
}

export type SupportAccessRequestInfo = {
  orgSlugs: unknown;
  url: URL;
  referer: string | null;
  method: string;
};

export type SupportAccessDecision =
  | { type: "allow" }
  | { type: "deny"; reason: "never_allowed" | "outside_session"; homeSlug?: string };

const ORG_PATH = /^\/(?:resources\/)?orgs\/([^/?#]+)/;
const ORG_PAGE = /^\/orgs\/([^/?#]+)(?:\/|$)/;

// Account-level changes outlive the session and span every org, so they're never allowed.
const NEVER_ALLOWED = [
  /^\/account\/authorization-code(?:\/|$)/,
  /^\/resources\/account(?:\/|$)/,
  /^\/invite/,
  /^\/confirm-basic-details(?:\/|$)/,
  /^\/orgs\/new(?:\/|$)/,
  /^\/projects\/new(?:\/|$)/,
];

// The customer's account pages can be viewed, not changed.
const READ_ONLY = [/^\/account(?:\/|$)/];

// Link helpers that only redirect into /orgs/<slug>/..., where the org is checked.
const ORG_REDIRECTS = [
  /^\/runs\/[^/]+$/,
  /^\/deployments\/[^/]+$/,
  /^\/_\//,
  /^\/projects\/[^/]+(?:\/ai-help)?$/,
  /^\/projects\/v3\/[^/]+$/,
  /^\/projects\/v3\/[^/]+\/runs(?:\/[^/]+)?$/,
  /^\/projects\/v3\/[^/]+\/deployments\/[^/]+$/,
  /^\/projects\/v3\/[^/]+\/(?:environment-variables|test)$/,
];

const ALWAYS_ALLOWED = [
  /^\/@(?:\/|$)/,
  /^\/admin(?:\/|$)/,
  /^\/logout(?:\/|$)/,
  /^\/resources\/impersonation(?:\/|$)/,
  /^\/resources\/preferences\//,
  /^\/resources\/timezone$/,
  /^\/resources\/platform-(?:notifications|changelogs)/,
  /^\/resources\/incidents$/,
];

function sessionSlugs(orgSlugs: unknown): string[] | undefined {
  if (!Array.isArray(orgSlugs) || orgSlugs.length === 0) return undefined;
  if (!orgSlugs.every((s) => typeof s === "string")) return undefined;
  return orgSlugs.map((s) => s.toLowerCase());
}

const decodeSegment = Result.fromThrowable(decodeURIComponent, () => "malformed" as const);

// Matches the router, which decodes each segment and ignores case.
function routedPath(pathname: string): string | undefined {
  const segments = Result.combine(pathname.split("/").map((s) => decodeSegment(s)));
  if (segments.isErr()) return undefined;
  return segments.value
    .map((s) => s.replace(/\//g, "%2F"))
    .join("/")
    .toLowerCase();
}

function sameOriginPath(referer: string | null, url: URL): string | undefined {
  if (!referer || !URL.canParse(referer)) return undefined;
  const parsed = new URL(referer);
  return parsed.host === url.host ? routedPath(parsed.pathname) : undefined;
}

// Default-deny: org pages must be the session's org, and anything else must be called from one.
export function supportAccessDecision({
  orgSlugs,
  url,
  referer,
  method,
}: SupportAccessRequestInfo): SupportAccessDecision {
  const slugs = sessionSlugs(orgSlugs);
  const neverAllowed = { type: "deny" as const, reason: "never_allowed" as const };
  const deny = { type: "deny" as const, reason: "outside_session" as const, homeSlug: slugs?.[0] };
  const path = routedPath(url.pathname);
  if (path === undefined) return neverAllowed;
  if (NEVER_ALLOWED.some((re) => re.test(path))) return neverAllowed;
  if (ALWAYS_ALLOWED.some((re) => re.test(path))) return { type: "allow" };
  if (!slugs) return deny;
  // "/" would redirect to the customer's last-used org, so it goes to the session's org instead.
  if (path === "/") return deny;
  if (READ_ONLY.some((re) => re.test(path))) {
    return method === "GET" || method === "HEAD" ? { type: "allow" } : deny;
  }
  if (ORG_REDIRECTS.some((re) => re.test(path))) return { type: "allow" };

  const orgMatch = ORG_PATH.exec(path);
  if (orgMatch) return slugs.includes(orgMatch[1]) ? { type: "allow" } : deny;

  const from = sameOriginPath(referer, url);
  const fromOrg = from ? ORG_PAGE.exec(from) : null;
  return fromOrg && slugs.includes(fromOrg[1]) ? { type: "allow" } : deny;
}
