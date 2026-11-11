import { withAdminApi } from "~/services/adminApi.server";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  adminTemplateBuilds,
  TemplateBuildsBodySchema,
} from "~/v3/services/adminTemplateBuilds.server";

async function handleAction({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const [bodyError, body] = await tryCatch(request.json());
  if (bodyError) {
    return json({ error: bodyError.message }, { status: 400 });
  }

  const parsedBody = TemplateBuildsBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return json({ error: parsedBody.error.message }, { status: 400 });
  }

  return adminTemplateBuilds(parsedBody.data);
}

export const action = withAdminApi(handleAction);
