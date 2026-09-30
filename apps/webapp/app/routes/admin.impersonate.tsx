import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { redirectWithImpersonation, requireAdminDashboardEnabled } from "~/models/admin.server";
import { requireUser } from "~/services/session.server";
import { organizationPath } from "~/utils/pathBuilder";
import { validateAndConsumeImpersonationToken } from "~/services/impersonation.server";
import { logger } from "~/services/logger.server";

const FormSchema = z.object({ id: z.string(), organizationSlug: z.string() });

async function handleImpersonationRequest(
  request: Request,
  userId: string,
  organizationSlug: string
): Promise<Response> {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }
  return redirectWithImpersonation(
    request,
    { userId, organizationSlug, path: organizationPath({ slug: organizationSlug }) },
    user
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  requireAdminDashboardEnabled();

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

  // Check admin BEFORE consuming the one-time token
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const validatedUserId = await validateAndConsumeImpersonationToken(impersonationToken);

  if (!validatedUserId || validatedUserId !== impersonateUserId) {
    logger.warn("Invalid or expired impersonation token");
    return redirect("/");
  }

  // The link only knows the user, not which org, so send staff to pick one.
  const target = await $replica.user.findFirst({
    where: { id: impersonateUserId },
    select: { email: true },
  });
  if (!target) {
    return redirect("/admin");
  }
  return redirect(`/admin?${new URLSearchParams({ search: target.email }).toString()}`);
};

export async function action({ request }: ActionFunctionArgs) {
  requireAdminDashboardEnabled();

  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());
  const { id, organizationSlug } = FormSchema.parse(payload);

  return handleImpersonationRequest(request, id, organizationSlug);
}
