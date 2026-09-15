const AUTHORIZATION_CODE_PATH_PREFIX = "/account/authorization-code/";
const REDACTED_AUTHORIZATION_CODE_PATH = "/account/authorization-code/[redacted]";

export function sanitizeHttpUrl(value: string): string {
  const queryIndex = value.indexOf("?");
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);

  return path.startsWith(AUTHORIZATION_CODE_PATH_PREFIX) ? REDACTED_AUTHORIZATION_CODE_PATH : path;
}
