import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { z } from "zod";
import { redirectWithImpersonation } from "~/models/admin.server";
import { authenticator } from "~/services/auth.server";
import { getRealUser } from "~/services/session.server";
import { validateAndConsumeImpersonationToken } from "~/services/impersonation.server";
import { logger } from "~/services/logger.server";
import { sanitizeRedirectPath } from "~/utils";

const FormSchema = z.object({ id: z.string() });

/**
 * The real authenticated user, or null when they're signed in but not an admin.
 *
 * Must not use `requireUser`: while impersonating it resolves to the impersonation target, whose
 * `admin` is false, so an admin switching to a second target was bounced to `/` and left on the
 * first one.
 *
 * Throws a login redirect when nobody is signed in, keeping this URL as `redirectTo` so the
 * impersonation survives the round trip — the one-time token is validated after this gate, so it's
 * still unconsumed when the browser comes back. Collapsing that into the non-admin `/` redirect
 * would drop the link the agent clicked.
 */
async function requireRealAdmin(request: Request) {
  if (!(await authenticator.isAuthenticated(request))) {
    const url = new URL(request.url);
    const redirectTo = sanitizeRedirectPath(`${url.pathname}${url.search}`);
    throw redirect(`/login?${new URLSearchParams([["redirectTo", redirectTo]])}`);
  }

  const admin = await getRealUser(request);
  return admin?.admin ? admin : null;
}

async function handleImpersonationRequest(request: Request, userId: string): Promise<Response> {
  const admin = await requireRealAdmin(request);
  if (!admin) {
    return redirect("/");
  }
  return redirectWithImpersonation(request, userId, "/");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const impersonateUserId = url.searchParams.get("impersonate");
  const impersonationToken = url.searchParams.get("impersonationToken");

  if (!impersonateUserId) {
    return redirect("/admin");
  }

  if (!impersonationToken) {
    logger.warn("Impersonation request missing token");
    return redirect("/");
  }

  // Check admin BEFORE consuming the one-time token, so a rejected request leaves the token usable.
  const admin = await requireRealAdmin(request);
  if (!admin) {
    return redirect("/");
  }

  const validatedUserId = await validateAndConsumeImpersonationToken(impersonationToken);

  if (!validatedUserId || validatedUserId !== impersonateUserId) {
    logger.warn("Invalid or expired impersonation token");
    return redirect("/");
  }

  return redirectWithImpersonation(request, impersonateUserId, "/");
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());
  const { id } = FormSchema.parse(payload);

  return handleImpersonationRequest(request, id);
}
