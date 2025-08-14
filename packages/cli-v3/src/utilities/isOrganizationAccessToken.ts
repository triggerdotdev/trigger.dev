const tokenPrefix = "tr_oat_";

export function isOrganizationAccessToken(token: string) {
  return token.startsWith(tokenPrefix);
}

export class NotOrganizationAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotOrganizationAccessTokenError";
  }
}