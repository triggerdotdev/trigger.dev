import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "~/env.server";
import { noteAdminRequest } from "~/services/adminAudit/adminAuditContext.server";

/**
 * Guards the admin API routes the billing service calls. Only the billing service secret
 * (`BILLING_SERVICE_SECRET`) is accepted: personal access tokens, including admins', are refused,
 * and the routes refuse everything when no secret is configured.
 */
export async function requireBillingServiceRequest(request: Request): Promise<void> {
  if (!isBillingServiceRequest(request, env.BILLING_SERVICE_SECRET)) {
    throw new Response(JSON.stringify({ error: "Invalid or missing billing service credential" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  noteAdminRequest(request, { actor: { kind: "billing_service" }, captureBody: true });
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
