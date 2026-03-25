const personalTokenPrefix = "tr_pat_";
const organizationTokenPrefix = "tr_oat_";

function isPersonalAccessToken(token: string) {
  return token.startsWith(personalTokenPrefix);
}

function isOrganizationAccessToken(token: string) {
  return token.startsWith(organizationTokenPrefix);
}

export function validateAccessToken(
  token: string
): { success: true; type: "personal" | "organization" } | { success: false } {
  if (isPersonalAccessToken(token)) {
    return { success: true, type: "personal" };
  }

  if (isOrganizationAccessToken(token)) {
    return { success: true, type: "organization" };
  }

  return { success: false };
}

export class NotPersonalAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPersonalAccessTokenError";
  }
}

export class NotAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAccessTokenError";
  }
}
