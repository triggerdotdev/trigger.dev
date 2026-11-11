export function bearerTokenFromAuthorizationHeader(authorizationValue: string): string {
  return authorizationValue.replace(/^Bearer /, "").trim();
}
