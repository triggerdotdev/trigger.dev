import { env } from "~/env.server";
import { createAdminOriginResolver } from "~/utils/adminOrigin";

export const adminOriginForRequest = createAdminOriginResolver(env.ADDITIONAL_LOGIN_ORIGINS);

export function loginOriginForRequest(request: Request): string {
  return adminOriginForRequest(request) ?? env.LOGIN_ORIGIN;
}

// Origin for links sent to customers (emails, invites). The admin webapp's own
// origin is only reachable through a tunnel, so it sets PUBLIC_APP_ORIGIN to the
// public dashboard and customer links must use that instead.
export function publicAppOrigin(): string {
  return (env.PUBLIC_APP_ORIGIN ?? env.LOGIN_ORIGIN).replace(/\/$/, "");
}
