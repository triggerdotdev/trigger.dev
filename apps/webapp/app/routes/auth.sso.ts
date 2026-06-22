import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { tryCatch } from "@trigger.dev/core/v3";
import { SSO_FLOWS, type SsoFlow } from "@trigger.dev/plugins";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";
import {
  checkSsoEmailRateLimit,
  checkSsoIpRateLimit,
  SsoRateLimitError,
} from "~/services/ssoRateLimiter.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { sanitizeRedirectPath } from "~/utils";

const VALID_FLOWS: ReadonlySet<SsoFlow> = new Set<SsoFlow>(SSO_FLOWS);

function isSsoFlow(value: string): value is SsoFlow {
  return VALID_FLOWS.has(value as SsoFlow);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const form = await request.formData();
  const rawEmail = form.get("email");
  if (typeof rawEmail !== "string" || rawEmail.trim().length === 0) {
    return redirect("/login/sso?error=missing_email");
  }
  const email = rawEmail.toLowerCase().trim();

  const rawRedirectTo = form.get("redirectTo");
  const redirectTo =
    sanitizeRedirectPath(typeof rawRedirectTo === "string" ? rawRedirectTo : null) ?? "/";
  const rawFlow = (form.get("flow") as string | null) ?? "user_initiated";
  const flow: SsoFlow = isSsoFlow(rawFlow) ? rawFlow : "user_initiated";

  if (env.LOGIN_RATE_LIMITS_ENABLED) {
    const xff = request.headers.get("x-forwarded-for");
    const clientIp = extractClientIp(xff);
    const [rateError] = await tryCatch(
      Promise.all([
        clientIp ? checkSsoIpRateLimit(clientIp) : Promise.resolve(),
        checkSsoEmailRateLimit(email),
      ])
    );
    if (rateError) {
      if (rateError instanceof SsoRateLimitError) {
        logger.warn("SSO login rate limit exceeded", { clientIp, email });
      } else {
        logger.error("SSO login rate limiter failed", { clientIp, email, error: rateError });
      }
      return redirect(`/login/sso?email=${encodeURIComponent(email)}&error=rate_limited`);
    }
  }

  // decideRouteForEmail is the auto-discovery gate — "should I redirect
  // a magic-link / OAuth attempt to SSO?" That gate requires
  // enforced=true. user_initiated means the user explicitly chose SSO,
  // so enforcement is irrelevant; we just need a configured domain,
  // which beginAuthorization itself validates (returns
  // no_org_for_domain / no_active_connection).
  if (flow !== "user_initiated") {
    const decision = await ssoController.decideRouteForEmail(email);
    if (decision.isErr() || decision.value.kind === "no_sso") {
      return redirect(`/login/sso?email=${encodeURIComponent(email)}&error=no_sso_for_domain`);
    }
  }

  const begun = await ssoController.beginAuthorization({ email, redirectTo, flow });
  if (begun.isErr()) {
    logger.warn("SSO beginAuthorization failed", { reason: begun.error, email, flow });
    return redirect(`/login/sso?email=${encodeURIComponent(email)}&error=${begun.error}`);
  }

  return redirect(begun.value.url);
}
