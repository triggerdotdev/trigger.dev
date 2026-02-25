import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { setReferralSourceCookie } from "~/services/referralSource.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { sanitizeVercelNextUrl } from "~/v3/vercel/vercelUrls.server";

const VercelCallbackSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    configurationId: z.string().optional(),
    next: z.string().optional()
  })
  .passthrough();

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() !== "GET") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  const userId = await getUserId(request);
  if (!userId) {
    const currentUrl = new URL(request.url);
    const redirectTo = `${currentUrl.pathname}${currentUrl.search}`;
    const referralCookie = await setReferralSourceCookie("vercel");

    const headers = new Headers();
    headers.append("Set-Cookie", referralCookie);

    throw redirect(`/login?redirectTo=${encodeURIComponent(redirectTo)}`, { headers });
  }

  const url = requestUrl(request);
  const parsed = VercelCallbackSchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    logger.error("Invalid Vercel callback params", { error: parsed.error });
    throw new Response("Invalid callback parameters", { status: 400 });
  }

  const { code, state, error, error_description, configurationId, next: rawNextUrl } = parsed.data;

  // Sanitize the `next` parameter to prevent open redirects
  const nextUrl = sanitizeVercelNextUrl(rawNextUrl);

  if (error) {
    logger.error("Vercel OAuth error", { error, error_description });
    throw new Response("Vercel OAuth error", { status: 500 });
  }

  if (!code) {
    logger.error("Missing authorization code from Vercel callback");
    throw new Response("Missing authorization code", { status: 400 });
  }

  // Route with state: dashboard-invoked flow
  if (state) {
    const params = new URLSearchParams({ state, code, origin: "dashboard" });
    if (configurationId) params.set("configurationId", configurationId);
    if (nextUrl) params.set("next", nextUrl);
    return redirect(`/vercel/connect?${params.toString()}`);
  }

  // Route without state but with configurationId: marketplace-invoked flow
  if (configurationId) {
    const params = new URLSearchParams({ code, configurationId, origin: "marketplace" });
    if (nextUrl) params.set("next", nextUrl);
    return redirect(`/vercel/onboarding?${params.toString()}`);
  }

  logger.error("Missing both state and configurationId from Vercel callback");
  throw new Response("Missing state or configurationId parameter", { status: 400 });
}
