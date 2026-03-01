import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { err, ok, type Result } from "neverthrow";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import {
  createPlatformNotification,
  type CreatePlatformNotificationInput,
} from "~/services/platformNotifications.server";

type AdminUser = { id: string; admin: boolean };
type AuthError = { status: number; message: string };

async function authenticateAdmin(request: Request): Promise<Result<AdminUser, AuthError>> {
  const authResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authResult) {
    return err({ status: 401, message: "Invalid or Missing API key" });
  }

  const user = await prisma.user.findUnique({
    where: { id: authResult.userId },
    select: { id: true, admin: true },
  });

  if (!user) {
    return err({ status: 401, message: "Invalid or Missing API key" });
  }

  if (!user.admin) {
    return err({ status: 403, message: "You must be an admin to perform this action" });
  }

  return ok(user);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const authResult = await authenticateAdmin(request);
  if (authResult.isErr()) {
    const { status, message } = authResult.error;
    return json({ error: message }, { status });
  }

  const body = await request.json();
  const result = await createPlatformNotification(body as CreatePlatformNotificationInput);

  if (result.isErr()) {
    const error = result.error;

    if (error.type === "validation") {
      return json({ error: "Validation failed", details: error.issues }, { status: 400 });
    }

    return json({ error: error.message }, { status: 500 });
  }

  return json(result.value, { status: 201 });
}
