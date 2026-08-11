import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { z } from "zod";
import { redirectWithImpersonation } from "~/models/admin.server";
import { authenticator } from "~/services/auth.server";
import { rbac } from "~/services/rbac.server";
import { getRealUser } from "~/services/session.server";
import { validateAndConsumeImpersonationToken } from "~/services/impersonation.server";
import { logger } from "~/services/logger.server";
import { sanitizeRedirectPath } from "~/utils";

/**
 * Served at `/admin/impersonate`, but the trailing `_` on `admin_` keeps it out of the `admin.tsx`
 * layout on purpose.
 *
 * That layout's loader is `dashboardLoader({ authorization: { requireSuper: true } })`, which
 * resolves the user through `getUserId` — the impersonated id while impersonating. So starting on a
 * second target ran the parent gate against the target, which isn't a super admin, and it answered
 * with its own `redirect("/")`. Nesting would leave this route's behaviour depending on the router
 * preferring the deepest redirect; opting out removes the question. Nothing is lost — this route
 * only ever redirects, so it never rendered inside the layout anyway.
 */

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
  if (!admin) return null;

  // Same gate `dashboardLoader({ authorization: { requireSuper: true } })` applies, evaluated
  // against the real admin. It can't be reached through the builder here, because the builder
  // resolves its subject with `getUserId` — the impersonated id while impersonating, which is the
  // bug this route exists to fix. So the ability is built explicitly for `admin.id` instead of
  // trusting the raw `User.admin` column: `canSuper()` is only equal to that column in the OSS
  // fallback, and a plugin is free to be stricter. requireSuper needs no org/project scope.
  const auth = await rbac.authenticateSession(request, { userId: admin.id });
  if (!auth.ok || !auth.ability.canSuper()) return null;

  return admin;
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
