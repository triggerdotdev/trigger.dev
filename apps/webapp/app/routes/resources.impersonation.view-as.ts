import { redirect, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { commitImpersonationSession, setViewingAsUser } from "~/services/impersonation.server";
import { requireUser } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";

const FormSchema = z.object({
  viewAsUser: z.enum(["true", "false"]),
  redirectTo: z.string().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const user = await requireUser(request);

  const payload = Object.fromEntries(await request.formData());
  const parsed = FormSchema.safeParse(payload);
  const redirectTo = sanitizeRedirectPath(parsed.success ? parsed.data.redirectTo : undefined);

  // Display-only toggle scoped to an impersonation session — outside one there
  // is nothing to toggle.
  if (!user.isImpersonating || !parsed.success) {
    return redirect(redirectTo);
  }

  const session = await setViewingAsUser(parsed.data.viewAsUser === "true", request);

  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await commitImpersonationSession(session),
    },
  });
}
