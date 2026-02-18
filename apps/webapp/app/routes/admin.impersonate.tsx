import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { redirectWithImpersonation } from "~/models/admin.server";
import { requireUser } from "~/services/session.server";
import { validateAndConsumeImpersonationToken } from "~/services/impersonation.server";
import { logger } from "~/services/logger.server";

const FormSchema = z.object({ id: z.string() });

async function handleImpersonationRequest(request: Request, userId: string): Promise<Response> {
  const user = await requireUser(request);
  if (!user.admin) {
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

  const validatedUserId = await validateAndConsumeImpersonationToken(impersonationToken);

  if (!validatedUserId || validatedUserId !== impersonateUserId) {
    logger.warn("Invalid or expired impersonation token");
    return redirect("/");
  }

  return handleImpersonationRequest(request, impersonateUserId);
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());
  const { id } = FormSchema.parse(payload);

  return handleImpersonationRequest(request, id);
}
