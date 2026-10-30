import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

/**
 * Guards the admin API routes the billing service calls. Accepts the billing service secret
 * (`BILLING_SERVICE_SECRET`) or, as on every other admin route, an admin's personal access token.
 */
export async function requireBillingServiceOrAdminApiRequest(request: Request): Promise<void> {
  if (isBillingServiceRequest(request, env.BILLING_SERVICE_SECRET)) {
    return;
  }

  await requireAdminApiRequest(request);
}

function isBillingServiceRequest(request: Request, secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  return digestEquals(authorization.slice("Bearer ".length), secret);
}

function digestEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest()
  );
}
