import { withAdminApi } from "~/services/adminApi.server";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { err, ok, type Result } from "neverthrow";
import { logger } from "~/services/logger.server";
import { authenticateAdminRequest } from "~/services/personalAccessToken.server";
import {
  createPlatformNotification,
  type CreatePlatformNotificationInput,
} from "~/services/platformNotifications.server";

type AdminUser = { id: string; admin: boolean };
type AuthError = { status: number; message: string; code?: string };

async function authenticateAdmin(request: Request): Promise<Result<AdminUser, AuthError>> {
  const result = await authenticateAdminRequest(request);
  return result.ok
    ? ok({ id: result.user.id, admin: result.user.admin })
    : err({ status: result.status, message: result.message, code: result.code });
}

async function handleAction({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const authResult = await authenticateAdmin(request);
  if (authResult.isErr()) {
    const { status, message, code } = authResult.error;
    // `code` says why, e.g. the token expired, so a client can act on it.
    return json(code ? { error: message, code } : { error: message }, { status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = await createPlatformNotification(body as CreatePlatformNotificationInput);

  if (result.isErr()) {
    const error = result.error;

    if (error.type === "validation") {
      return json({ error: "Validation failed", details: error.issues }, { status: 400 });
    }

    logger.error("Failed to create platform notification", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }

  return json(result.value, { status: 201 });
}

export const action = withAdminApi(handleAction);
