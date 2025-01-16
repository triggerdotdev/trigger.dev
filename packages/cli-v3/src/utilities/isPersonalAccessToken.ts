const tokenPrefix = "tr_pat_";

export function isPersonalAccessToken(token: string) {
  return token.startsWith(tokenPrefix);
}

export class NotPersonalAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPersonalAccessTokenError";
  }
}
