/** The `code` a PAT auth failure carries when the token was valid but has expired. */
export const PERSONAL_ACCESS_TOKEN_EXPIRED = "personal_access_token_expired";

/** The `code` a PAT auth failure carries when a CLI login token went unused for too long. */
export const CLI_LOGIN_EXPIRED = "cli_login_expired";

/** The stored columns that decide whether a personal access token has expired. */
export type PersonalAccessTokenExpiryFields = {
  /** Null for tokens created without an expiry. */
  expiresAt: Date | null;
  /** Set on CLI login tokens: they expire this long after their last use. Null means no idle limit. */
  idleTimeoutSeconds: number | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
};

export type PersonalAccessTokenExpiry = {
  code: typeof PERSONAL_ACCESS_TOKEN_EXPIRED | typeof CLI_LOGIN_EXPIRED;
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

  const idleExpiresAt = idleExpiry(token);
  if (idleExpiresAt && idleExpiresAt.getTime() <= now.getTime()) {
    return { code: CLI_LOGIN_EXPIRED, expiredAt: idleExpiresAt };
  }

  return undefined;
}

/**
 * When the token stops working if it isn't used again: the earlier of its fixed expiry and its
 * idle expiry. Undefined for a token with neither. Credentials derived from the token shouldn't
 * outlive this.
 */
export function personalAccessTokenValidUntil(
  token: PersonalAccessTokenExpiryFields
): Date | undefined {
  const idleExpiresAt = idleExpiry(token);
  if (token.expiresAt && idleExpiresAt) {
    return token.expiresAt.getTime() <= idleExpiresAt.getTime() ? token.expiresAt : idleExpiresAt;
  }
  return token.expiresAt ?? idleExpiresAt;
}

function idleExpiry(token: PersonalAccessTokenExpiryFields): Date | undefined {
  // A row read without the idle column (a caller on an older contract) has no idle limit, same
  // as null.
  if (typeof token.idleTimeoutSeconds !== "number") return undefined;
  const lastUsedAt = token.lastAccessedAt ?? token.createdAt;
  return new Date(lastUsedAt.getTime() + token.idleTimeoutSeconds * 1000);
}

/** The error a request with an expired token gets, so a failing CI job or CLI says why. */
export function personalAccessTokenExpiryMessage(
  expiry: PersonalAccessTokenExpiry,
  tokensUrl?: string
): string {
  if (expiry.code === CLI_LOGIN_EXPIRED) {
    return "Your CLI login expired because it wasn't used for a while. Run `npx trigger.dev@latest login` to log in again (add `--profile <name>` if you use a named profile). With an older CLI version, run `trigger.dev logout` first.";
  }

  const date = expiry.expiredAt.toISOString().slice(0, 10);
  const replacement = tokensUrl
    ? `Create a new one at ${tokensUrl}.`
    : "Create a new one on the Personal Access Tokens page of the dashboard.";
  return `This personal access token expired on ${date} (UTC). ${replacement}`;
}
