/** The `code` a PAT auth failure carries when the token was valid but has expired. */
export const PERSONAL_ACCESS_TOKEN_EXPIRED = "personal_access_token_expired";

/** The stored columns that decide whether a personal access token has expired. */
export type PersonalAccessTokenExpiryFields = {
  /** Null for tokens created without an expiry: they never expire. */
  expiresAt: Date | null;
};

export type PersonalAccessTokenExpiry = {
  code: typeof PERSONAL_ACCESS_TOKEN_EXPIRED;
  expiredAt: Date;
};

/**
 * Returns why and when the token expired, or undefined while it is still valid. Every place that
 * authenticates a PAT uses this, so the host and the RBAC plugins can't disagree about expiry.
 */
export function personalAccessTokenExpiry(
  token: PersonalAccessTokenExpiryFields,
  now: Date = new Date()
): PersonalAccessTokenExpiry | undefined {
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return { code: PERSONAL_ACCESS_TOKEN_EXPIRED, expiredAt: token.expiresAt };
  }
  return undefined;
}

/** The error a request with an expired token gets, so a failing CI job says why. */
export function personalAccessTokenExpiryMessage(
  expiry: PersonalAccessTokenExpiry,
  tokensUrl?: string
): string {
  const date = expiry.expiredAt.toISOString().slice(0, 10);
  const replacement = tokensUrl
    ? `Create a new one at ${tokensUrl}.`
    : "Create a new one on the Personal Access Tokens page of the dashboard.";
  return `This personal access token expired on ${date} (UTC). ${replacement}`;
}
