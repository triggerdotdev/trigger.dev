import { env } from "~/env.server";
import { createAdminOriginResolver } from "~/utils/adminOrigin";

export const adminOriginForRequest = createAdminOriginResolver(env.ADDITIONAL_LOGIN_ORIGINS);

export function loginOriginForRequest(request: Request): string {
  return adminOriginForRequest(request) ?? env.LOGIN_ORIGIN;
}
